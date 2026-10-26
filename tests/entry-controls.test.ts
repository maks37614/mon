import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Store } from "../backend/store";
import { Vault } from "../backend/security";
import { Trading } from "../backend/trading";
import { ExchangeGateway } from "../backend/exchange";
import { detectFormations } from "../backend/patterns";
import { evaluateStrategy, strategyPreset } from "../src/chart/strategyEngine";
import { DEFAULT_SETTINGS, type Settings, type Signal, type Candle } from "../backend/config";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "audit-signal", exchange: "binance", symbol: "BTCUSDT", timeframe: "1m",
    formation: "Double Bottom", direction: "LONG", entryPrice: 100, currentPrice: 100,
    stopLoss: 99.75, takeProfit: 100.45, confidence: 90, status: "confirmed",
    candleAt: Date.now() - 1000, detectedAt: Date.now(), description: "Synthetic audit fixture",
    ...overrides,
  };
}

function fixture(t: TestContext, overrides: Partial<Settings> = {}, input: Partial<Signal> = {}) {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-entry-"));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const settings = { ...DEFAULT_SETTINGS, autoEntries: true, entryCooldownSeconds: 0, ...overrides };
  store.set("settings", settings);
  const signal = makeSignal({ exchange: settings.exchange, ...input });
  store.set("signals", [signal]);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save(settings.exchange, "audit-fake-key", "audit-fake-secret");
  vault.verify(settings.exchange);
  let price = 100;
  const market: any = {
    getPrices: async () => ({ at: Date.now(), data: { BTCUSDT: price } }),
    getMarkets: async () => [{ symbol: "BTCUSDT", quantityStep: 0.001, minQuantity: 0.001, minNotional: 5, tickSize: 0.01 }],
  };
  const broker: any = {
    positions: [], submitted: [],
    account: async () => ({ total: 1000, free: 1000, positions: structuredClone(broker.positions) }),
    quantity: async (_exchange: string, _symbol: string, quote: number, notional: number) => notional / quote,
    prepare: async () => {},
    submit: async (intent: any) => {
      broker.submitted.push(structuredClone(intent));
      assert.equal(intent.kind, "entry");
      broker.positions.push({ ...intent, entryPrice: price, currentPrice: price });
      return { id: `stub-${intent.id}`, filled: intent.quantity, average: price, fee: 0.015, status: "closed" };
    },
    protection: async (_intent: any, _quantity: any, saved: any) => { saved("stub-sl"); saved("stub-tp"); },
  };
  const trading = new Trading(store, market, vault, broker, true);
  return { store, trading, signal, broker, market, vault, setPrice: (value: number) => { price = value; } };
}

for (const exchange of ["binance", "bybit"] as const)
  for (const mode of ["paper", "live"] as const)
    for (const direction of ["LONG", "SHORT"] as const)
      for (const reverseEnabled of [false, true])
        for (const confirmedOnly of [false, true])
          for (const status of ["confirmed", "watching"] as const)
            test(`${exchange}/${mode}: ${direction}, reverse=${reverseEnabled}, confirmedOnly=${confirmedOnly}, status=${status}`, async (t) => {
              const f = fixture(t, { exchange, mode, reverseEnabled, confirmedOnly }, { direction, status });
              await f.trading.monitor();
              const positions = f.trading.snapshot().positions;
              const expectedCount = !confirmedOnly || status === "confirmed" ? 1 : 0;
              assert.equal(positions.length, expectedCount);
              assert.equal(f.broker.submitted.length, mode === "live" ? expectedCount : 0);
              if (expectedCount) {
                const p = positions[0];
                const expected = reverseEnabled ? (direction === "LONG" ? "SHORT" : "LONG") : direction;
                assert.equal(p.direction, expected);
                const sign = expected === "LONG" ? 1 : -1;
                assert.ok(Math.abs(p.stopLoss - 100 * (1 - sign * 0.25 / 100)) < 1e-9);
                assert.ok(Math.abs(p.takeProfit - 100 * (1 + sign * 0.45 / 100)) < 1e-9);
                assert.equal(f.store.get<any[]>("signals", [])[0].direction, direction, "Original signal must not be reversed");
                if (mode === "live") assert.equal(f.broker.submitted[0].signal.direction, direction);
              }
            });

for (const mode of ["paper", "live"] as const)
  test(`${mode}: disabled automatic entries do not enter; manual entry is still available`, async (t) => {
    const f = fixture(t, { mode, autoEntries: false, reverseEnabled: true });
    await f.trading.monitor();
    assert.equal(f.trading.snapshot().positions.length, 0);
    assert.equal(f.broker.submitted.length, 0);
    await f.trading.enter(f.signal.id);
    assert.equal(f.trading.snapshot().positions[0].direction, "SHORT");
  });

const invalidSignals = [
  ["wrong exchange", { exchange: "bybit" }],
  ["unselected timeframe", { timeframe: "5m" }],
  ["unselected formation", { formation: "H&S" }],
  ["insufficient score", { confidence: 74 }],
  ["unconfirmed original signal", { status: "watching" }],
  ["stale candle", { candleAt: Date.now() - 181_000 }],
  ["future candle", { candleAt: Date.now() + 60_000 }],
  ["price outside slippage allowance", { entryPrice: 101 }],
] as const;
for (const reverseEnabled of [false, true])
  for (const [name, overrides] of invalidSignals)
    test(`filters preserved with reverse=${reverseEnabled}: ${name}`, async (t) => {
      const f = fixture(t, { reverseEnabled, formationTypes: ["Double Bottom"] }, overrides as Partial<Signal>);
      await f.trading.monitor();
      assert.equal(f.trading.snapshot().positions.length, 0);
      await assert.rejects(f.trading.enter(f.signal.id));
    });

test("saving controls persists them for a fresh server engine", async (t) => {
  const f = fixture(t, { autoEntries: false });
  await f.trading.updateSettings({ autoEntries: true, reverseEnabled: true, confirmedOnly: true });
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, true);
  assert.equal(restarted.settings().reverseEnabled, true);
  assert.equal(restarted.settings().confirmedOnly, true);
  await restarted.monitor();
  assert.equal(restarted.snapshot().positions[0].direction, "SHORT");
});

test("entry interval blocks a new candidate until the configured time", async (t) => {
  const f = fixture(t, { reverseEnabled: true });
  await f.trading.monitor();
  await f.trading.closePosition(f.trading.snapshot().positions[0].id);
  f.store.set("signals", [makeSignal({ id: "second" })]);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 0);
  const b = f.store.get<any>("book:paper", null);
  b.lastEntryAt = Date.now() - 61_000;
  f.store.set("book:paper", b);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions[0].direction, "SHORT");
});

for (const direction of ["LONG", "SHORT"] as const)
  for (const reason of ["TP", "SL"] as const)
    test(`reversed ${direction}: ${reason} closes in the correct price direction`, async (t) => {
      const f = fixture(t, { reverseEnabled: true }, { direction });
      await f.trading.monitor();
      const opened = f.trading.snapshot().positions[0];
      await f.trading.updateSettings({ autoEntries: false });
      f.setPrice(reason === "TP" ? opened.takeProfit : opened.stopLoss);
      await f.trading.monitor();
      const state = f.trading.snapshot();
      assert.equal(state.positions.length, 0);
      assert.equal(state.history[0].reason, reason);
      assert.equal(state.history[0].grossPnl > 0, reason === "TP");
    });

function bottomCandles(confirmed: boolean): Candle[] {
  const start = Math.floor(Date.now() / 60_000) * 60_000 - 100 * 60_000;
  const candles = Array.from({ length: 100 }, (_, i) => ({ time: start + i * 60_000, open: 100, close: 100, high: 100.1, low: 99.9, volume: 100 }));
  candles[75].low = 98;
  candles[88].low = 98;
  candles[82].high = 101;
  if (confirmed) { candles[99].close = 101.05; candles[99].high = 101.1; }
  return candles;
}

for (const bearish of [false, true])
  for (const confirmedOnly of [false, true])
    for (const confirmed of [false, true])
      test(`real pattern detector: bearish=${bearish}, confirmedOnly=${confirmedOnly}, closed breakout=${confirmed}`, async (t) => {
        let candles = bottomCandles(confirmed);
        if (bearish) candles = candles.map(c => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close }));
        const formation = bearish ? "Double Top" : "Double Bottom";
        const settings = { ...DEFAULT_SETTINGS, confirmedOnly, formationTypes: [formation] };
        const signals = detectFormations(candles, "binance", "BTCUSDT", "1m", settings);
        assert.equal(signals.length, !confirmedOnly || confirmed ? 1 : 0);
        if (signals.length) {
          assert.equal(signals[0].status, confirmed ? "confirmed" : "watching");
          assert.equal(signals[0].direction, bearish ? "SHORT" : "LONG");
          if (confirmed) {
            const f = fixture(t, { reverseEnabled: true, formationTypes: [formation] }, signals[0]);
            f.setPrice(candles.at(-1)!.close);
            await f.trading.monitor();
            assert.equal(f.trading.snapshot().positions[0]?.direction, bearish ? "LONG" : "SHORT");
          }
        }
      });

for (const exchange of ["binance", "bybit"] as const)
  for (const direction of ["LONG", "SHORT"] as const)
    test(`${exchange} exchange adapter maps ${direction} entry to the correct order side`, async (t) => {
      const f = fixture(t, { exchange });
      const calls: any[] = [];
      const instrument = { id: "BTCUSDT", symbol: "BTC/USDT:USDT", swap: true, linear: true, settle: "USDT", contractSize: 1 };
      const client: any = {
        loadMarkets: async () => {}, markets: { [instrument.symbol]: instrument }, market: () => instrument,
        priceToPrecision: (_symbol: string, price: number) => price.toFixed(2),
        createOrder: async (...args: any[]) => { calls.push(args); return { id: "stub", filled: 0.25, average: 100, status: "closed" }; },
      };
      const gateway = new ExchangeGateway(f.vault, async () => client);
      await gateway.submit({ id: "audit-adapter", exchange, symbol: "BTCUSDT", direction, signal: f.signal, quantity: 0.25,
        stopLoss: direction === "LONG" ? 99.75 : 100.25, takeProfit: direction === "LONG" ? 100.45 : 99.55, createdAt: Date.now(), kind: "entry" }, { ...DEFAULT_SETTINGS, exchange });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][2], direction === "LONG" ? "buy" : "sell");
    });

function symmetricCandles(direction: "LONG" | "SHORT"): Candle[] {
  const start = Math.floor(Date.now() / 60_000) * 60_000 - 100 * 60_000;
  const candles = Array.from({ length: 100 }, (_, i) => {
    const price = 100 + (10 - 0.07 * i) * Math.sin(2 * Math.PI * i / 16);
    return { time: start + i * 60_000, open: price, close: price, high: price + 0.1, low: price - 0.1, volume: 100 };
  });
  candles[99] = { ...candles[99], open: 97, high: 97.1, low: 96.7, close: 96.78 };
  return direction === "SHORT" ? candles : candles.map(c => ({
    ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high,
  }));
}

for (const exchange of ["binance", "bybit"] as const)
  for (const mode of ["paper", "live"] as const)
    for (const direction of ["LONG", "SHORT"] as const)
      for (const reverseEnabled of [false, true])
        test(`symmetric triangle breakout: ${exchange}/${mode}, signal=${direction}, reverse=${reverseEnabled}`, async (t) => {
          const candles = symmetricCandles(direction);
          const settings = { ...DEFAULT_SETTINGS, autoEntries: true, exchange, mode, reverseEnabled, formationTypes: ["Symmetric Triangle"] };
          const signals = detectFormations(candles, exchange, "BTCUSDT", "1m", settings);
          assert.equal(signals.length, 1);
          assert.equal(signals[0].direction, direction);
          assert.equal(signals[0].status, "confirmed");
          const expectedEntry = direction === "SHORT" ? 96.83 : 103.17;
          assert.ok(Math.abs(signals[0].entryPrice - expectedEntry) < 1e-9,
            `Breakout must use the crossed boundary ${expectedEntry}; got ${signals[0].entryPrice}`);
          const f = fixture(t, settings, signals[0]);
          f.setPrice(candles.at(-1)!.close);
          await f.trading.monitor();
          const expectedDirection = reverseEnabled ? (direction === "LONG" ? "SHORT" : "LONG") : direction;
          const position = f.trading.snapshot().positions[0];
          assert.equal(position?.direction, expectedDirection);
          assert.equal(f.broker.submitted.length, mode === "live" ? 1 : 0);
          if (mode === "live") assert.equal(f.broker.submitted[0].signal.direction, direction);
        });

for (const direction of ["LONG", "SHORT"] as const)
  test(`chart strategy resolves symmetric triangle direction before selecting its trigger: ${direction}`, () => {
    const candles = symmetricCandles(direction);
    const series = candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    const preset = strategyPreset("patterns_wide")!;
    const result = evaluateStrategy({ ...preset, config: { ...preset.config, patternTfs: ["1m"], patternTypes: ["Symmetric Triangle"], allPatterns: false, onlyConfirmed: true } }, {
      series: { "1m": series }, chartCandles: series, levels: [], densities: [], book: { b: [], a: [] },
      oiHistory: [], fundingHistory: [], fundingRate: 0, currentPrice: candles.at(-1)!.close,
    });
    assert.equal(result.events.length, 1);
    const event = result.events[0];
    assert.equal(event.direction, direction === "LONG" ? "bullish" : "bearish");
    assert.equal(event.state, "confirmed");
    assert.equal(event.p, event.lines!.find(l => l.label === (direction === "LONG" ? "upper" : "lower"))!.p1);
    assert.ok(direction === "LONG" ? result.directionScore > 0 : result.directionScore < 0);
  });

for (const onlyConfirmed of [false, true])
  test(`symmetric triangle wick crossings do not confirm a breakout; onlyConfirmed=${onlyConfirmed}`, () => {
    const candles = symmetricCandles("SHORT");
    candles[99] = { ...candles[99], open: 100, close: 100, high: 104, low: 96 };
    const series = candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    const preset = strategyPreset("patterns_wide")!;
    const result = evaluateStrategy({ ...preset, config: { ...preset.config, patternTfs: ["1m"], patternTypes: ["Symmetric Triangle"], allPatterns: false, onlyConfirmed } }, {
      series: { "1m": series }, chartCandles: series, levels: [], densities: [], book: { b: [], a: [] },
      oiHistory: [], fundingHistory: [], fundingRate: 0, currentPrice: 100,
    });
    assert.equal(result.events.length, onlyConfirmed ? 0 : 1);
    if (!onlyConfirmed) {
      assert.equal(result.events[0].direction, "neutral");
      assert.equal(result.events[0].state, "watching");
      assert.equal(result.directionScore, 0);
    }
  });
