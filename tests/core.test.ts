import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Store } from "../backend/store";
import { Vault, hashPassword, checkPassword } from "../backend/security";
import {
  DEFAULT_SETTINGS,
  FORMATION_ANALYSIS_VERSION,
  validateSettings,
  type Signal,
  type Settings,
} from "../backend/config";
import { Trading } from "../backend/trading";
import { HookFormationSources } from "../backend/hookFormationSources";
import { MarketData } from "../backend/market";
import { Scanner } from "../backend/scanner";
import { detectFormations } from "../backend/patterns";
import { ExchangeGateway } from "../backend/exchange";
import { createApplication } from "../server";
import { paperVenue } from "./paperFixture";

function storage(t: any) {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-"));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}
function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "signal-1",
    exchange: "binance",
    symbol: "BTCUSDT",
    timeframe: "1m",
    formation: "Double Bottom",
    direction: "LONG",
    entryPrice: 100,
    currentPrice: 100,
    stopLoss: 99.75,
    takeProfit: 100.45,
    confidence: 90,
    analysisVersion: FORMATION_ANALYSIS_VERSION,
    status: "confirmed",
    candleAt: Date.now() - 1000,
    detectedAt: Date.now(),
    description: "Fixture",
    ...overrides,
  };
}
function fixture(t: any, mode: "paper" | "live" = "paper") {
  const { store, directory } = storage(t);
  const s = { ...DEFAULT_SETTINGS, mode, entryCooldownSeconds: 0, paperLatencyMs: 0 };
  store.set("settings", s);
  store.set("signals", [signal()]);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture-key", "fixture-secret");
  vault.verify("binance");
  let price = 100;
  const market: any = {
    getPrices: async () => ({ at: Date.now(), data: { BTCUSDT: price } }),
    getMarkets: async () => [
      {
        symbol: "BTCUSDT",
        quantityStep: 0.001,
        minQuantity: 0.001,
        minNotional: 5,
        tickSize: 0.01,
      },
    ],
  };
  const broker: any = {
    positions: [],
    orders: new Map(),
    submitted: [],
    guardFailed: false,
    unknown: false,
    account: async () => ({
      total: 1000,
      free: 1000,
      positions: structuredClone(broker.positions),
    }),
    quantity: async (_e: any, _s: any, quote: number, notional: number) =>
      notional / quote,
    prepare: async () => {},
    submit: async (intent: any) => {
      broker.submitted.push(structuredClone(intent));
      if (intent.kind === "entry") {
        broker.positions.push({
          symbol: intent.symbol,
          direction: intent.direction,
          quantity: intent.quantity,
          entryPrice: price,
          currentPrice: price,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
        });
        const fill = {
          id: `venue-${intent.id}`,
          filled: intent.quantity,
          average: price,
          fee: 0.015,
          status: "closed",
        };
        broker.orders.set(intent.id, fill);
        if (broker.unknown)
          throw Object.assign(new Error("fixture network failure"), {
            name: "RequestTimeout",
          });
        return fill;
      }
      broker.positions = [];
      const fill = {
        id: `venue-${intent.id}`,
        filled: intent.quantity,
        average: price,
        fee: 0.015,
        status: "closed",
      };
      broker.orders.set(intent.id, fill);
      return fill;
    },
    read: async (intent: any) => broker.orders.get(intent.id) || null,
    protection: async (_i: any, _q: any, saved: any) => {
      if (broker.guardFailed) throw new Error("fixture guard rejection");
      saved("sl-1", "stopLoss");
      saved("tp-1", "takeProfit");
    },
    checkProtection: async () => "verified",
    cancelProtection: async () => {},
    closingTrades: async () => [
      {
        id: "close-1",
        side: "sell",
        quantity: 0.25,
        price,
        fee: 0.015,
        at: Date.now(),
      },
    ],
  };
  paperVenue(market, broker, () => price);
  const trading = new Trading(store, market, vault, broker, true);
  return {
    trading,
    store,
    directory,
    vault,
    market,
    broker,
    setPrice: (value: number) => {
      price = value;
      for (const p of broker.positions) p.currentPrice = value;
    },
  };
}

test("password hashing verifies the password and rejects a different value", async () => {
  const hash = await hashPassword("fixture-only-password");
  assert.equal(await checkPassword("fixture-only-password", hash), true);
  assert.equal(await checkPassword("wrong-password", hash), false);
  assert.notEqual(hash, await hashPassword("fixture-only-password"));
});
test("exchange secrets are encrypted at rest and authenticated against the exchange name", (t) => {
  const { store } = storage(t),
    key = randomBytes(32).toString("base64"),
    vault = new Vault(store, key);
  vault.save("binance", "private-fixture-api", "private-fixture-secret");
  assert.deepEqual(vault.load("binance"), {
    apiKey: "private-fixture-api",
    secret: "private-fixture-secret",
  });
  const raw = store.get<any>("credentials:binance", null);
  assert.equal(JSON.stringify(raw).includes("private-fixture"), false);
  store.set("credentials:bybit", raw);
  assert.throws(() => vault.load("bybit"));
  assert.deepEqual(vault.status("binance"), {
    configured: true,
    verified: false,
  });
});
test("settings reject invalid numbers, inherited keys and unsupported formations", () => {
  assert.throws(() =>
    validateSettings({ requestsPerSecond: 100 }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ maxPositions: NaN }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ toString: "invalid" }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ formationTypes: ["invented"] }, DEFAULT_SETTINGS),
  );
});
test("flat market produces no fabricated formations", () => {
  const now = Date.now() - 100 * 60_000;
  const candles = Array.from({ length: 100 }, (_, i) => ({
    time: now + i * 60_000,
    open: 100,
    close: 100,
    high: 100,
    low: 100,
    volume: 100,
  }));
  assert.deepEqual(
    detectFormations(candles, "binance", "BTCUSDT", "1m", DEFAULT_SETTINGS),
    [],
  );
});
test("paper TP uses observed execution price and both fees, without a real order", async (t) => {
  const f = fixture(t);
  await f.trading.enter("signal-1");
  assert.equal(f.trading.snapshot().positions.length, 1);
  f.setPrice(101);
  await f.trading.monitor();
  const state = f.trading.snapshot();
  assert.equal(state.positions.length, 0);
  assert.ok(Math.abs(state.history[0].exitPrice - 101) < 1e-8);
  assert.ok(
    Math.abs(state.history[0].netPnl - (0.25 - 0.015 - 0.01515)) < 1e-9,
  );
  assert.equal(f.broker.submitted.length, 0);
});
test("trade history preserves the entry signal, timeframe and protection levels after settings change", async (t) => {
  const f = fixture(t);
  await f.trading.updateSettings({ timeframes: ["15m"], confirmedOnly: false, reverseEnabled: true });
  f.store.set("signals", [signal({ timeframe: "15m", confidence: 83, status: "watching" })]);
  await f.trading.enter("signal-1");
  const position = f.trading.snapshot().positions[0];
  assert.equal(position.timeframe, "15m");
  assert.equal(position.direction, "SHORT");
  // Active positions from an earlier release retain the timeframe in their intent.
  const book = f.store.get<any>("book:paper", null);
  delete book.positions[0].timeframe;
  f.store.set("book:paper", book);
  assert.equal(f.trading.snapshot().positions[0].timeframe, "15m");
  f.store.set("signals", [signal({ timeframe: "4h", confidence: 99, status: "confirmed" })]);
  await f.trading.updateSettings({
    timeframes: ["4h"], takeProfitPercent: 2, stopLossPercent: 1,
    confirmedOnly: true, reverseEnabled: false, minScore: 95,
  });
  await f.trading.closePosition(position.id);
  const history = f.trading.snapshot().history[0];
  assert.equal(history.timeframe, "15m");
  assert.equal(history.formation, "Double Bottom");
  assert.equal(history.signalConfidence, 83);
  assert.equal(history.signalStatus, "watching");
  assert.equal(history.signalDirection, "LONG");
  assert.equal(history.direction, "SHORT");
  assert.equal(history.openedAt, position.openedAt);
  assert.ok(history.closedAt >= history.openedAt!);
  assert.equal(history.exchange, position.exchange);
  assert.equal(history.entryPrice, position.entryPrice);
  assert.equal(history.takeProfit, position.takeProfit);
  assert.equal(history.stopLoss, position.stopLoss);
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, false);
  assert.deepEqual(restarted.snapshot().history[0], history);
});
test("a signal cannot open twice concurrently and open exposure prevents a mode switch", async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    f.trading.enter("signal-1"),
    f.trading.enter("signal-1"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.trading.snapshot().positions.length, 1);
  await assert.rejects(f.trading.updateSettings({ mode: "live" }), /Спочатку/);
});
test("position expiry survives a new server engine without a browser", async (t) => {
  const f = fixture(t);
  await f.trading.enter("signal-1");
  const book = f.store.get<any>("book:paper", null);
  book.positions[0].expiresAt = Date.now() - 1000;
  f.store.set("book:paper", book);
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, false);
  await restarted.monitor();
  assert.equal(restarted.snapshot().history[0].reason, "TIME");
});
test("an unknown live order is persisted and reconciled after restart without resubmission", async (t) => {
  const f = fixture(t, "live");
  f.broker.unknown = true;
  await assert.rejects(f.trading.enter("signal-1"));
  assert.equal(f.trading.snapshot().pending.length, 1);
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, true);
  await restarted.monitor();
  assert.equal(f.broker.submitted.length, 1);
  assert.equal(restarted.snapshot().pending.length, 0);
  assert.equal(restarted.snapshot().positions[0].status, "active");
  assert.equal(restarted.snapshot().positions[0].guards.length, 2);
});
test("failed protective orders pause entries and request a separate reduce-only close", async (t) => {
  const f = fixture(t, "live");
  f.broker.guardFailed = true;
  await f.trading.enter("signal-1");
  assert.deepEqual(
    f.broker.submitted.map((i: any) => i.kind),
    ["entry", "close"],
  );
  assert.equal(f.trading.settings().autoEntries, false);
  // Closing acknowledgement alone does not remove the position.
  assert.equal(f.trading.snapshot().positions.length, 1);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 0);
  assert.equal(f.trading.snapshot().history.length, 1);
});
test("live closing is not recorded until venue position and complete fills agree", async (t) => {
  const f = fixture(t, "live");
  await f.trading.enter("signal-1");
  const position = f.trading.snapshot().positions[0];
  f.store.set("signals", [signal({ timeframe: "4h", confidence: 55, status: "watching" })]);
  const id = position.id;
  f.broker.closingTrades = async () => [];
  await f.trading.closePosition(id);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions[0].status, "reconciling");
  assert.equal(f.trading.snapshot().history.length, 0);
  f.broker.closingTrades = async () => [
    {
      id: "fill-1",
      side: "sell",
      quantity: 0.1,
      price: 101,
      fee: 0.006,
      at: Date.now(),
    },
    {
      id: "fill-2",
      side: "sell",
      quantity: 0.15,
      price: 102,
      fee: 0.009,
      at: Date.now(),
    },
  ];
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 0);
  assert.ok(Math.abs(f.trading.snapshot().history[0].exitPrice - 101.6) < 1e-9);
  const history = f.trading.snapshot().history[0];
  assert.equal(history.signalConfidence, 90);
  assert.equal(history.signalStatus, "confirmed");
  assert.equal(history.signalDirection, "LONG");
  assert.equal(history.openedAt, position.openedAt);
  assert.equal(history.timeframe, position.timeframe);
  assert.equal(history.takeProfit, position.takeProfit);
  assert.equal(history.stopLoss, position.stopLoss);
});
test("server-level live disable cannot be bypassed by changing settings", async (t) => {
  const f = fixture(t),
    disabled = new Trading(f.store, f.market, f.vault, f.broker, false);
  await assert.rejects(
    disabled.updateSettings({ mode: "live" }),
    /ENABLE_LIVE_TRADING/,
  );
});

test("live history reconciles delayed funding without changing the authoritative wallet or resubmitting", async t => {
  const f = fixture(t, "live");
  let available = false;
  f.broker.fundingCost = async () => { if (!available) throw new Error("ledger unavailable"); return -0.02; };
  await f.trading.enter("signal-1");
  await f.trading.closePosition(f.trading.snapshot().positions[0].id);
  await f.trading.monitor();
  const provisional = f.trading.snapshot().history[0];
  assert.equal(provisional.fundingComplete, false); assert.equal(provisional.fundingCost, undefined);
  const requests = f.broker.submitted.length, balance = f.trading.snapshot().stats.balance;
  const later = Date.now() + 61000; t.mock.method(Date, "now", () => later); available = true;
  await f.trading.monitor();
  const final = f.trading.snapshot().history[0];
  assert.equal(final.fundingComplete, true); assert.equal(final.fundingCost, -0.02);
  assert.ok(Math.abs(final.netPnl - (final.grossPnl - final.fee + 0.02)) < 1e-9);
  assert.equal(f.trading.snapshot().stats.balance, balance); assert.equal(f.broker.submitted.length, requests);
});

test("server-level live disable keeps recovery read-only after a restart", async (t) => {
  const f = fixture(t, "live");
  f.broker.unknown = true;
  await assert.rejects(f.trading.enter("signal-1"));
  let guards = 0;
  f.broker.protection = async () => {
    guards++;
  };
  const disabled = new Trading(f.store, f.market, f.vault, f.broker, false);
  await disabled.monitor();
  assert.equal(guards, 0);
  assert.equal(f.broker.submitted.length, 1);
  assert.equal(disabled.snapshot().pending.length, 1);
});

test("automatic entry checks are bounded and rotate without scanning every signal privately", async (t) => {
  const f = fixture(t, "live");
  f.store.set("settings", { ...f.trading.settings(), autoEntries: true });
  f.store.set(
    "signals",
    Array.from({ length: 50 }, (_, i) => signal({ id: `signal-${i}` })),
  );
  let accountReads = 0;
  f.broker.account = async () => {
    accountReads++;
    return { free: 0, total: 1000, positions: [] };
  };
  await f.trading.monitor();
  assert.equal(accountReads, 11);
  assert.equal(f.broker.submitted.length, 0);
});

test("leverage preflight failure never creates an unknown order intent", async (t) => {
  const f = fixture(t, "live");
  f.broker.prepare = async () => {
    throw Object.assign(new Error("timeout before submission"), {
      name: "RequestTimeout",
    });
  };
  await assert.rejects(f.trading.enter("signal-1"));
  assert.equal(f.trading.snapshot().pending.length, 0);
  assert.equal(f.broker.submitted.length, 0);
});

test("cleanup recovers a protective order with a lost acknowledgement by its client id", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture", "fixture");
  const canceled: string[] = [];
  const market = {
    id: "BTCUSDT",
    symbol: "BTC/USDT:USDT",
    swap: true,
    linear: true,
    settle: "USDT",
    contractSize: 1,
  };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    fetchOrder: async (_id: any, _s: any, p: any) => {
      if (p.clientOrderId.endsWith("-sl"))
        return { id: "lost-sl-id", status: "open" };
      throw Object.assign(new Error("missing"), { name: "OrderNotFound" });
    },
    cancelOrder: async (id: string) => {
      canceled.push(id);
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.cancelProtection("binance", "BTCUSDT", [], "mon-entry");
  assert.deepEqual(canceled, ["lost-sl-id"]);
});

test("Bybit adapter attaches TP/SL to the entry with a unique client id", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("bybit", "fixture", "fixture");
  const calls: any[] = [];
  const market = {
    id: "BTCUSDT",
    symbol: "BTC/USDT:USDT",
    swap: true,
    linear: true,
    settle: "USDT",
    contractSize: 1,
  };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    priceToPrecision: (_s: any, p: number) => p.toFixed(2),
    createOrder: async (...args: any[]) => {
      calls.push(args);
      return { id: "entry", filled: 0, status: "open" };
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.submit(
    {
      id: "mon-bybit-entry",
      exchange: "bybit",
      symbol: "BTCUSDT",
      direction: "LONG",
      signal: signal({ exchange: "bybit" }),
      quantity: 0.25,
      stopLoss: 99.75,
      takeProfit: 100.45,
      createdAt: Date.now(),
      kind: "entry",
    },
    DEFAULT_SETTINGS,
  );
  assert.equal(calls[0][5].clientOrderId, "mon-bybit-entry");
  assert.equal(calls[0][5].stopLoss.triggerPrice, 99.75);
  assert.equal(calls[0][5].takeProfit.triggerPrice, 100.45);
  assert.equal(calls[0][5].positionIdx, 0);
});

function publicFixture() {
  const calls: URL[] = [];
  const fetcher = async (input: any) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/v5/market/instruments-info") {
      const page = url.searchParams.get("cursor");
      return Response.json({
        retCode: 0,
        result: {
          nextPageCursor: page ? "" : "page2",
          list: Array.from({ length: page ? 2 : 11 }, (_, i) => ({
            symbol: `COIN${page ? i + 11 : i}USDT`,
            baseCoin: `COIN${i}`,
            status: "Trading",
            contractType: "LinearPerpetual",
            quoteCoin: "USDT",
            settleCoin: "USDT",
            lotSizeFilter: {
              qtyStep: "0.001",
              minOrderQty: "0.001",
              minNotionalValue: "5",
            },
            priceFilter: { tickSize: "0.01" },
          })),
        },
      });
    }
    if (url.pathname === "/v5/market/kline") {
      const start = Math.floor(Date.now() / 60_000) * 60_000 - 100 * 60_000;
      return Response.json({
        retCode: 0,
        result: {
          list: Array.from({ length: 100 }, (_, i) => [
            String(start + i * 60_000),
            "100",
            "100",
            "100",
            "100",
            "1",
          ]).reverse(),
        },
      });
    }
    throw new Error(`Unexpected public fixture route ${url.pathname}`);
  };
  return { calls, fetcher: fetcher as typeof fetch };
}
test("Bybit listing follows pagination beyond ten coins, and scanning resumes the full universe", async (t) => {
  const { store } = storage(t),
    f = publicFixture();
  const s = {
    ...DEFAULT_SETTINGS,
    exchange: "bybit" as const,
    requestsPerSecond: 8,
    scanBatchSize: 10,
  };
  store.set("settings", s);
  const market = new MarketData(() => s, f.fetcher),
    scanner = new Scanner(store, market);
  assert.equal((await market.getMarkets("bybit")).length, 13);
  assert.equal(scanner.start(true).accepted, true);
  assert.equal(scanner.start(true).accepted, false);
  await scanner.task;
  assert.equal(store.get<any>("scanner", {}).cursor, 10);
  scanner.start(true);
  await scanner.task;
  assert.equal(store.get<any>("scanner", {}).total, 13);
  assert.ok(store.get<any>("scanner", {}).lastFullPassAt > 0);
  assert.equal(
    new Set(
      f.calls
        .filter((u) => u.pathname.endsWith("kline"))
        .map((u) => u.searchParams.get("symbol")),
    ).size,
    13,
  );
});
test("simultaneous chart reads share one request and 429 pauses further upstream traffic", async () => {
  const f = publicFixture(),
    s = {
      ...DEFAULT_SETTINGS,
      exchange: "bybit" as const,
      requestsPerSecond: 8,
    };
  const m = new MarketData(() => s, f.fetcher);
  await Promise.all([
    m.getCandles("bybit", "COIN0USDT", "1m", 100, false),
    m.getCandles("bybit", "COIN0USDT", "1m", 100, false),
  ]);
  assert.equal(f.calls.filter((u) => u.pathname.endsWith("kline")).length, 1);
  let count = 0;
  const blocked = new MarketData(() => s, (async () => {
    count++;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }) as typeof fetch);
  await assert.rejects(blocked.getMarkets("bybit"));
  await assert.rejects(blocked.getMarkets("bybit"));
  assert.equal(count, 1);
});
test("historical chart windows use exchange-specific timestamps and separate live and historical caches", async () => {
  const requests: URL[] = [];
  const endTime = 1_700_000_000_000;
  const m = new MarketData(
    () => ({ ...DEFAULT_SETTINGS, requestsPerSecond: 8 }),
    (async (input: any) => {
      const url = new URL(String(input));
      requests.push(url);
      const rows = [[endTime - 60_000, "100", "102", "99", "101", "10"]];
      return Response.json(url.hostname === "api.bybit.com"
        ? { retCode: 0, result: { list: rows } } : rows);
    }) as typeof fetch,
  );
  m.getMarkets = async () => [{ symbol: "BTCUSDT" } as any];
  await Promise.all([
    m.getCandles("binance", "BTCUSDT", "1m", 300, false, endTime),
    m.getCandles("binance", "BTCUSDT", "1m", 300, false, endTime),
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("endTime"), String(endTime));
  await m.getCandles("binance", "BTCUSDT", "1m", 300, false);
  assert.equal(requests[1].searchParams.has("endTime"), false);
  const bybit = await m.getCandles("bybit", "BTCUSDT", "15m", 300, false, endTime);
  assert.equal(requests[2].searchParams.get("end"), String(endTime));
  assert.equal(requests[2].searchParams.get("interval"), "15");
  assert.equal(bybit[0].time, endTime - 60_000);
  for (const invalid of [NaN, -1, 1.5, Date.now() + 86400_000]) {
    await assert.rejects(m.getCandles("binance", "BTCUSDT", "1m", 300, false, invalid), /час/);
  }
  assert.equal(requests.length, 3);
});
test("exchange adapter sends reduceOnly on exits and never places a spot order", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture", "fixture");
  const calls: any[] = [],
    market = {
      id: "BTCUSDT",
      symbol: "BTC/USDT:USDT",
      swap: true,
      linear: true,
      settle: "USDT",
      contractSize: 1,
    };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    createOrder: async (...args: any[]) => {
      calls.push(args);
      return { id: "1", filled: 0.25, average: 100, status: "closed" };
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.submit(
    {
      id: "mon-close",
      exchange: "binance",
      symbol: "BTCUSDT",
      direction: "LONG",
      signal: signal(),
      quantity: 0.25,
      stopLoss: 99,
      takeProfit: 101,
      createdAt: Date.now(),
      kind: "close",
    },
    DEFAULT_SETTINGS,
  );
  assert.equal(calls[0][0], "BTC/USDT:USDT");
  assert.equal(calls[0][2], "sell");
  assert.equal(calls[0][5].reduceOnly, true);
});

test("HTTP authentication, CSRF, secret redaction and cron authorization protect every operation", async (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-http-"));
  const runtime = createApplication({
    directory,
    origin: "http://127.0.0.1:3010",
    username: "admin",
    passwordHash: await hashPassword("fixture-only-password"),
    encryptionKey: randomBytes(32).toString("base64"),
    cronSecret: "c".repeat(64),
    fetcher: (async () => {
      throw new Error("Network disabled in HTTP fixture");
    }) as typeof fetch,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal((await fetch(base + "/api/state")).status, 401);
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:3010",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "admin",
      password: "fixture-only-password",
    }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(login.headers.get("set-cookie")!, /SameSite=Strict/);
  const cookie = login.headers.get("set-cookie")!.split(";")[0],
    { csrf } = await login.json();
  assert.equal(
    (
      await fetch(base + "/api/scan", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3010",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/scan", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const headers = {
    Origin: "http://127.0.0.1:3010",
    Cookie: cookie,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  const chartRequests: any[][] = [];
  runtime.market.getCandles = async (...args) => {
    chartRequests.push(args);
    return [];
  };
  const chart = await fetch(base + "/api/market/klines?exchange=bybit&symbol=BTCUSDT&interval=15m&limit=300&endTime=1700000000000", { headers: { Cookie: cookie } });
  assert.equal(chart.status, 200);
  assert.deepEqual(chartRequests[0], ["bybit", "BTCUSDT", "15m", 300, false, 1700000000000]);
  assert.equal(runtime.trading.settings().exchange, "binance");
  assert.equal((await fetch(base + "/api/market/klines?exchange=unknown", { headers: { Cookie: cookie } })).status, 400);
  assert.equal(chartRequests.length, 1);
  assert.equal(
    (
      await fetch(base + "/api/credentials/binance", {
        method: "POST",
        headers,
        body: JSON.stringify({
          apiKey: "private-http-fixture-key",
          apiSecret: "private-http-fixture-secret",
        }),
      })
    ).status,
    200,
  );
  const state = await fetch(base + "/api/state", {
    headers: { Cookie: cookie },
  });
  const stateText = await state.text();
  assert.equal(stateText.includes("private-http-fixture"), false);
  assert.match(stateText, /"configured":true/);
  assert.equal(
    (await fetch(base + "/api/cron/scan", { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/api/cron/scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${"c".repeat(64)}` },
      })
    ).status,
    202,
  );
  await runtime.scanner.task;
  assert.ok(runtime.store.get<any>("scanner", {}).lastCronAt > 0);
  assert.equal(runtime.store.get<any>("scanner", {}).lastTrigger, "cron");
});

test("explicit close rejection does not leave a phantom pending order; unknown close does",async t=>{
  const f=fixture(t,"live"); await f.trading.enter("signal-1");
  const id=f.trading.snapshot().positions[0].id;
  const submit=f.broker.submit; let rejected=0;
  f.broker.submit=async(intent:any)=>{if(intent.kind==="close" && rejected++===0)throw Object.assign(new Error("rejected"),{name:"InvalidOrder"});return submit(intent);};
  await f.trading.closePosition(id);
  assert.equal(f.trading.snapshot().pending.length,0);assert.equal(f.trading.snapshot().positions.length,1);
  await f.trading.monitor();assert.equal(f.broker.positions.length,0);
});
test("exchange account rejects malformed active positions or missing wallet instead of treating them as flat",async t=>{
  const {store}=storage(t),vault=new Vault(store,randomBytes(32).toString("base64"));vault.save("binance","fixture","fixture");
  let balance:any={USDT:{free:100,total:100}},positions:any=[];
  const client:any={loadMarkets:async()=>{},fetchBalance:async()=>balance,fetchPositions:async()=>positions};
  const gateway=new ExchangeGateway(vault,async()=>client);
  assert.equal((await gateway.account("binance")).positions.length,0);
  balance={};await assert.rejects(gateway.account("binance"),/Неповна/);
  balance={USDT:{free:100,total:100}};positions=[{contracts:1,side:"unknown",entryPrice:100}];await assert.rejects(gateway.account("binance"),/Некоректні/);
});

test("credential replacement waits for verification and never inherits the old key verification",async t=>{
  const f=fixture(t,"paper");f.vault.save("binance","old-key","old-secret");
  let release!:()=>void, started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  f.broker.account=async()=>{started();await new Promise<void>(r=>{release=r;});return {free:100,total:100,positions:[]};};
  f.broker.invalidate=()=>{};
  const verification=f.trading.verifyCredentials("binance");await ready;
  const replacement=f.trading.saveCredentials("binance","new-key","new-secret");
  assert.equal(f.vault.load("binance")!.apiKey,"old-key");release();await verification;await replacement;
  assert.equal(f.vault.load("binance")!.apiKey,"new-key");assert.equal(f.vault.status("binance").verified,false);
});

test("live history rejects conflicting duplicate fills and preserves the actual close reason",async t=>{
  const f=fixture(t,"live");await f.trading.enter("signal-1");const p=f.trading.snapshot().positions[0];
  await f.trading.closePosition(p.id);
  const fill={id:"close-duplicate",side:"sell",quantity:p.quantity,price:101,fee:0.01,at:Date.now()};
  f.broker.closingTrades=async()=>[fill,{...fill,price:102}];await f.trading.monitor();
  assert.equal(f.trading.snapshot().history.length,0);assert.equal(f.trading.snapshot().positions.length,1);
  f.broker.closingTrades=async()=>[fill,fill];const restarted=new Trading(f.store,f.market,f.vault,f.broker,true);await restarted.monitor();
  assert.equal(restarted.snapshot().history.length,1);assert.equal(restarted.snapshot().history[0].reason,"MANUAL");
});

test("empty auto-entry cycles do not consume the interval before a signal arrives",async t=>{
 const f=fixture(t,"paper");f.store.set("settings",{...f.trading.settings(),autoEntries:true});f.store.set("signals",[]);
 await f.trading.monitor();assert.equal(f.store.get<any>("book:paper",{lastEntryAt:0}).lastEntryAt,0);
 f.store.set("signals",[signal()]);await f.trading.monitor();assert.equal(f.trading.snapshot().positions.length,1);
});

test("manual order confirmation is checked inside the trading queue",async t=>{
 const f=fixture(t,"paper");await assert.rejects(f.trading.enter("signal-1","live",true),/режим змінився/);
 assert.equal(f.trading.snapshot().positions.length,0);
 await f.trading.enter("signal-1","paper",false);const p=f.trading.snapshot().positions[0];
 await assert.rejects(f.trading.closePosition(p.id,"live",true),/режим змінився/);
 assert.equal(f.trading.snapshot().positions.length,1);
 await f.trading.closePosition(p.id,"paper",false);assert.equal(f.trading.snapshot().positions.length,0);
});


test("automatic h00k source entry respects confirmation, pause and duplicate guard in both modes",async t=>{
  for (const mode of ["paper","live"] as const) {
    const f=fixture(t,mode);
    const now=Date.now(),close=Math.floor(now/60000)*60000;
    const validation={enoughData:true,finiteData:true,closedCandleOnly:true,lookAheadSafe:true,
      passed:false,confirmed:true,breakoutConfirmed:true,entryMode:"BREAKOUT",
      regularPlan:{breakoutClosedAt:close,structureActive:true,entryExpired:false,afterEntry:[]},
      confluence:{total:90}};
    const coin={symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m",quoteAsset:"USDT",
      currentPrice:100,lastUpdated:now,formationData:{contiguous:true,collectedAt:now,lastClosedAt:close},
      formations:[{id:"auto-site-1",patternKey:"double_bottom",bias:"bullish",status:"breakout",
        validation,levels:{entryPrice:100,stopLossPrice:99,targetPrice:102},detectedAt:close}]};
    const source=new HookFormationSources((async()=>Response.json({success:true,data:[coin]})) as typeof fetch);
    const bot=new Trading(f.store,f.market,f.vault,f.broker,true,source);
    await bot.updateSettings({autoEntries:true,confirmedOnly:true});
    await source.refresh(bot.settings());await bot.monitor();
    assert.equal(bot.snapshot().positions.length,0);
    validation.passed=true;source.invalidate();await source.refresh(bot.settings());
    await bot.updateSettings({autoEntries:false});await bot.monitor();
    assert.equal(bot.snapshot().positions.length,0);
    await bot.updateSettings({autoEntries:true});await bot.monitor();
    assert.equal(bot.snapshot().positions.length,1);
    assert.equal(bot.snapshot().positions[0].symbol,"BTCUSDT");
    assert.equal(f.broker.submitted.length,mode==="live"?1:0);
    await bot.monitor();assert.equal(bot.snapshot().positions.length,1);
    assert.equal(f.broker.submitted.length,mode==="live"?1:0);
  }
});
test("a cooldown-only candidate does not consume the automatic entry interval",async t=>{
  const f=fixture(t,"paper");
  await f.trading.updateSettings({autoEntries:true,entryCooldownSeconds:900});
  f.store.set("book:paper",{balance:1000,startBalance:1000,positions:[],history:[],pending:[],used:{},
    lastEntries:{BTCUSDT:Date.now()},lastEntryAt:0});
  await f.trading.monitor();
  assert.equal(f.store.get<any>("book:paper",{}).lastEntryAt,0);
  assert.equal(f.trading.snapshot().positions.length,0);
});

test("loss of an active Binance protection pauses new entries without inventing a close fill",async t=>{
  const f=fixture(t,"live");
  await f.trading.enter("signal-1");
  await f.trading.updateSettings({autoEntries:true});
  const b=f.store.get<any>("book:live",{});
  b.positions[0].protectionCheck.at=Date.now()-31000;f.store.set("book:live",b);
  f.broker.checkProtection=async()=>"missing";
  await f.trading.monitor();
  assert.equal(f.trading.settings().autoEntries,false);
  assert.equal(f.trading.snapshot().positions[0].protectionCheck?.status,"missing");
  assert.equal(f.trading.snapshot().history.length,0);
  assert.equal(f.broker.submitted.length,1);
  await assert.rejects(f.trading.enter("signal-1"),/узгодити/);
});

test("pause requested during an automatic quote read prevents order submission",async t=>{
  const f=fixture(t,"paper");
  await f.trading.updateSettings({autoEntries:true});
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{started=r;});
  f.market.getPrices=async()=>{started();await new Promise<void>(r=>{release=r;});return {at:Date.now(),data:{BTCUSDT:100}};};
  const cycle=f.trading.monitor();await ready;
  const pause=f.trading.updateSettings({autoEntries:false});
  release();await cycle;await pause;
  assert.equal(f.trading.snapshot().positions.length,0);
  assert.equal(f.trading.settings().autoEntries,false);
});

test("manual confirmation rejects a changed reverse direction",async t=>{
 const f=fixture(t,"paper");await f.trading.updateSettings({reverseEnabled:true});
 await assert.rejects(f.trading.enter("signal-1","paper",false,"LONG"),/Напрямок/);
 assert.equal(f.trading.snapshot().positions.length,0);
 await f.trading.enter("signal-1","paper",false,"SHORT");
 assert.equal(f.trading.snapshot().positions[0].direction,"SHORT");
});

test("late fee reconciliation matches original entry and exact exit fills without changing wallet",async t=>{
 const f=fixture(t,"live");await f.trading.enter("signal-1");
 const p=f.trading.snapshot().positions[0];await f.trading.closePosition(p.id);
 const at=Date.now(),exit={id:"exit-a",orderId:"close-a",side:"sell",quantity:p.quantity,price:101,fee:0,feeKnown:false,at};
 f.broker.closingTrades=async()=>[exit];await f.trading.monitor();
 const provisional=f.trading.snapshot().history[0];assert.equal(provisional.feesComplete,false);
 const balance=f.trading.snapshot().stats.balance,orders=f.broker.submitted.length;
 f.broker.closingTrades=async()=>[{id:"entry-a",orderId:p.entryOrderId,side:"buy",quantity:p.quantity,price:100,fee:.012,feeKnown:true,at:p.openedAt},{...exit,fee:.016,feeKnown:true}];
 t.mock.method(Date,"now",()=>at+61000);await f.trading.monitor();
 const final=f.trading.snapshot().history[0];assert.equal(final.feesComplete,true);assert.ok(Math.abs(final.fee-.028)<1e-9);
 assert.equal(f.trading.snapshot().stats.balance,balance);assert.equal(f.broker.submitted.length,orders);
});


test("malformed live entry fill is retained for reconciliation and never adopted",async t=>{
 const f=fixture(t,"live"),submit=f.broker.submit;
 f.broker.submit=async(intent:any)=>{const fill=await submit(intent);return {...fill,filled:intent.quantity*2};};
 await assert.rejects(f.trading.enter("signal-1"));
 const state=f.trading.snapshot();
 assert.equal(state.positions.length,0);assert.equal(state.pending.length,1);
 assert.equal(state.settings.autoEntries,false);assert.equal(f.broker.submitted.length,1);
});
test("one failed pending-order read does not interrupt reconciliation of other orders",async t=>{
 const f=fixture(t,"live");
 const b=f.store.get<any>("book:live",null)??{balance:1000,startBalance:1000,positions:[],history:[],pending:[],used:{},lastEntries:{},lastEntryAt:0};
 const base={kind:"entry",exchange:"binance",symbol:"BTCUSDT",createdAt:Date.now(),quantity:.25,direction:"LONG",signal:signal(),stopLoss:99,takeProfit:102};
 b.pending=[{...base,id:"offline"},{...base,id:"canceled"}];f.store.set("book:live",b);
 const reads:string[]=[];f.broker.read=async(intent:any)=>{reads.push(intent.id);if(intent.id==="offline")throw Error("offline");return {id:"cancel",status:"canceled",filled:0,average:0,fee:0}};
 await f.trading.monitor();
 assert.deepEqual(reads,["offline","canceled"]);
 assert.deepEqual(f.trading.snapshot().pending.map(x=>x.id),["offline"]);
 assert.equal(f.broker.submitted.length,0);
});
