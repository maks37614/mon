import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION, type Settings, type Signal } from "../backend/config";
import { Store } from "../backend/store";
import { Vault } from "../backend/security";
import { Trading } from "../backend/trading";
import { depthFill, liquidationPrice, liquidatable, maintenance, type ExecutionBook } from "../backend/paperModel";
import { MarketData } from "../backend/market";
import { ExchangeGateway } from "../backend/exchange";
import { PaperFeed } from "../backend/paperFeed";
import { paperVenue } from "./paperFixture";
import { tradeHistoryCsv } from "../src/tradeHistoryCsv";

const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function fixture(t: TestContext, settings: Partial<Settings> = {}) {
  let now = Date.parse("2026-10-26T07:59:00Z"), price = 100, mark = 100;
  t.mock.method(Date, "now", () => now);
  const directory = mkdtempSync(path.join(process.cwd(), ".test-paper-")), store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.set("settings", { ...DEFAULT_SETTINGS, paperLatencyMs: 0, leverage: 10, entryCooldownSeconds: 0, ...settings });
  const signal: Signal = { id: "signal", exchange: settings.exchange || "binance", symbol: "BTCUSDT", timeframe: "1m", formation: "Double Bottom", direction: "LONG",
    entryPrice: 100, currentPrice: 100, stopLoss: 99.75, takeProfit: 100.45, confidence: 90, analysisVersion: FORMATION_ANALYSIS_VERSION,
    status: "confirmed", candleAt: now - 1000, detectedAt: now, description: "Fixture" };
  store.set("signals", [signal]);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  const market: any = {
    getPrices: async () => ({ at: now, data: { BTCUSDT: price } }),
    getMarkets: async () => [{ symbol: "BTCUSDT", quantityStep: 0.001, minQuantity: 0.001, minNotional: 5, tickSize: 0.01 }],
  };
  const broker: any = { submit: async () => { throw new Error("Paper must never send an order"); } };
  paperVenue(market, broker, () => price);
  market.getContractState = async () => ({ at: now, last: price, mark, nextFundingAt: (Math.floor(now / 28800_000) + 1) * 28800_000 });
  const trading = new Trading(store, market, vault, broker, false);
  return { store, trading, broker, market, vault, signal,
    at: (value: string) => { now = Date.parse(value); },
    prices: (last: number, m = last) => { price = last; mark = m; },
    restart: () => new Trading(store, market, vault, broker, false) };
}

test("depth execution walks both sides, rejects stale, crossed, malformed and insufficient books", () => {
  const book: ExecutionBook = { at: Date.now(), bids: [[99, 1], [98, 2]], asks: [[101, 1], [102, 2]] };
  approx(depthFill(book, "buy", 2), 101.5); approx(depthFill(book, "sell", 2), 98.5);
  assert.throws(() => depthFill(book, "buy", 4), /ліквідність/);
  assert.throws(() => depthFill({ ...book, at: Date.now() - 2001 }, "buy", 1), /застарів/);
  assert.throws(() => depthFill({ ...book, bids: [[101, 1]] }, "buy", 1));
  assert.throws(() => depthFill({ ...book, asks: [[102, 1], [101, 1]] }, "buy", 1));
  assert.throws(() => depthFill({ ...book, asks: [[NaN, 1]] }, "buy", 1));
});

test("paper entry/exit uses depth VWAP and exact two-sided fees without subtracting slippage twice", async t => {
  const f = fixture(t);
  f.market.getExecutionBook = async () => ({ at: Date.now(), bids: [[99.9, 100]], asks: [[100.05, 0.1], [100.15, 100]] });
  await f.trading.enter("signal");
  const p = f.trading.snapshot().positions[0];
  assert.ok(p.entryPrice > 100.05); assert.ok(p.entryPrice * p.quantity <= 25 + 1e-8);
  approx(p.paper!.initialMargin, p.entryPrice * p.quantity / 10);
  f.market.getExecutionBook = async () => ({ at: Date.now(), bids: [[100.9, 0.1], [100.7, 100]], asks: [[101, 100]] });
  await f.trading.closePosition(p.id);
  const h = f.trading.snapshot().history[0];
  const exit = (100.9 * 0.1 + 100.7 * (p.quantity - 0.1)) / p.quantity;
  approx(h.exitPrice, exit); approx(h.entryFee!, p.entryPrice * p.quantity * 0.0006);
  approx(h.exitFee!, exit * p.quantity * 0.0006);
  approx(h.netPnl, (exit - p.entryPrice) * p.quantity - h.entryFee! - h.exitFee!);
  approx(f.trading.snapshot().stats.balance - 1000, h.netPnl);
  assert.equal(h.executionSource, "orderbook-vwap");
  assert.ok(tradeHistoryCsv([h]).includes("Funding USDT"));
});

for (const reverseEnabled of [false, true]) test(`settled funding is signed, durable and never applied twice; reverse=${reverseEnabled}`, async t => {
  const f = fixture(t, { reverseEnabled });
  await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  f.at("2026-10-26T08:00:10Z");
  f.market.getFundingEvents = async () => [{ at: Date.parse("2026-10-26T08:00:00Z"), rate: 0.001, price: 101, priceSource: "settlement-mark" }];
  await f.trading.monitor();
  const expected = 101 * p.quantity * 0.001 * (reverseEnabled ? -1 : 1);
  let current = f.trading.snapshot().positions[0]; approx(current.paper!.fundingCost, expected);
  approx(current.paper!.marginBalance!, p.paper!.initialMargin); // Paid from available wallet first.
  const balance = f.trading.snapshot().stats.balance;
  const restarted = f.restart(); await restarted.monitor();
  approx(restarted.snapshot().stats.balance, balance);
  assert.equal(restarted.snapshot().positions[0].paper!.fundingEvents.length, 1);
  await restarted.closePosition(p.id);
  const h = restarted.snapshot().history[0];
  approx(h.fundingCost!, expected); approx(h.netPnl, h.grossPnl - h.fee - expected);
  approx(restarted.snapshot().stats.balance - 1000, h.netPnl);
});

test("a filled close waiting for delayed funding survives restart with its original price and time", async t => {
  const f = fixture(t); await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  f.at("2026-10-26T08:00:10Z"); f.prices(101);
  f.market.getFundingEvents = async () => [];
  await assert.rejects(f.trading.closePosition(p.id), /ще не опубліковане/);
  const pending = f.trading.snapshot().positions[0];
  assert.equal(pending.status, "closing"); assert.ok(pending.paper!.closeFill);
  assert.equal(f.trading.snapshot().history.length, 0);
  const frozen = pending.paper!.closeFill!;
  f.at("2026-10-26T08:01:10Z"); f.prices(90);
  f.market.getFundingEvents = async () => [{ at: Date.parse("2026-10-26T08:00:00Z"), rate: 0.001, price: 100, priceSource: "settlement-mark" }];
  const restarted = f.restart(); await restarted.monitor();
  const h = restarted.snapshot().history[0];
  assert.equal(h.exitPrice, frozen.price); assert.equal(h.closedAt, frozen.at);
  approx(h.netPnl, h.grossPnl - h.fee - h.fundingCost!);
});

test("no depth or fee data cannot consume a new signal or create a free fill", async t => {
  const f = fixture(t);
  f.broker.takerRate = async () => { throw new Error("fee unavailable"); };
  await assert.rejects(f.trading.enter("signal"), /fee unavailable/);
  assert.equal(f.trading.snapshot().positions.length, 0);
  assert.equal(Object.keys(f.store.get<any>("book:paper", { used: {} }).used).length, 0);
  f.broker.takerRate = async () => ({ rate: 0.0006, source: "account-api", at: Date.now() });
  f.market.getExecutionBook = async () => ({ at: Date.now(), bids: [[99.9, 0.01]], asks: [[100.1, 0.01]] });
  await assert.rejects(f.trading.enter("signal"), /ліквідність/);
  assert.equal(f.trading.snapshot().positions.length, 0);
});

test("an exit with no depth retains its first trigger and retries without inventing a fill", async t => {
  const f = fixture(t); await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  const normalBook = f.market.getExecutionBook;
  f.prices(101); f.market.getExecutionBook = async () => { throw new Error("depth unavailable"); };
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().history.length, 0);
  assert.equal(f.trading.snapshot().positions[0].paper!.closeTrigger!.reason, "TP");
  f.prices(99); f.market.getExecutionBook = normalBook;
  await f.trading.monitor(); assert.equal(f.trading.snapshot().history[0].reason, "TP");
  assert.ok(f.trading.snapshot().history[0].exitPrice < p.entryPrice);
});

test("mark price liquidates an isolated position while last price never touched its stop", async t => {
  const f = fixture(t, { stopLossPercent: 20 }); await f.trading.enter("signal");
  const p = f.trading.snapshot().positions[0];
  assert.ok(p.paper!.liquidationPrice > 80 && p.paper!.liquidationPrice < 100);
  f.prices(100, 89); await f.trading.monitor();
  const h = f.trading.snapshot().history[0];
  assert.equal(h.reason, "LIQUIDATION"); assert.equal(h.executionSource, "isolated-bankruptcy-model");
  approx(h.netPnl, -p.paper!.initialMargin - p.entryFee);
  approx(f.trading.snapshot().stats.balance - 1000, h.netPnl);
});

test("liquidation formula agrees with maintenance and funding collateral on both sides", async t => {
  const f = fixture(t); await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  for (const direction of ["LONG", "SHORT"] as const) {
    const position = { ...p, direction }, state = { ...p.paper!, marginBalance: 1 };
    const threshold = liquidationPrice(position, state);
    assert.ok(threshold > 0);
    assert.ok(Math.abs(1 + (threshold - p.entryPrice) * p.quantity * (direction === "LONG" ? 1 : -1)
      - maintenance(state.tiers, threshold * p.quantity) - (state.closeFeeReserve || 0)) < 1e-8);
    assert.equal(liquidatable(position, state, threshold * (direction === "LONG" ? 0.999 : 1.001)), true);
  }
});

test("Bybit isolated initial/maintenance margin includes the closing fee reserve on both directions", async t => {
  const f = fixture(t, { exchange: "bybit" }); await f.trading.enter("signal");
  const p = f.trading.snapshot().positions[0], state = p.paper!;
  approx(state.closeFeeReserve!, p.entryPrice * p.quantity * (1 - 1 / 10) * state.takerRate);
  approx(state.initialMargin, p.entryPrice * p.quantity / 10 + state.closeFeeReserve!);
  approx(state.liquidationPrice, p.entryPrice * (1 - 1 / 10) / (1 - state.tiers[0].rate));
  for (const direction of ["LONG", "SHORT"] as const) {
    const sign = direction === "LONG" ? 1 : -1;
    const reserve = p.entryPrice * p.quantity * (1 - sign / 10) * state.takerRate;
    const collateral = p.entryPrice * p.quantity / 10 + reserve;
    const model = { ...state, closeFeeReserve: reserve, initialMargin: collateral, marginBalance: collateral };
    const threshold = liquidationPrice({ ...p, direction }, model);
    approx(threshold, p.entryPrice * (1 - sign / 10) / (1 - sign * state.tiers[0].rate));
  }
});

test("settings changes do not replace manual entry/exit commission and per-position leverage", async t => {
  const f = fixture(t, { paperFeeMode: "manual", takerFeePercent: 0.1 });
  f.broker.takerRate = async () => { throw new Error("manual mode must not read private fees"); };
  await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  await f.trading.updateSettings({ takerFeePercent: 0.9, paperFeeMode: "account", paperLatencyMs: 500 });
  await f.trading.closePosition(p.id); const h = f.trading.snapshot().history[0];
  approx(h.fee, (h.entryPrice + h.exitPrice) * h.quantity * 0.001);
  assert.equal(h.paper!.feeSource, "manual"); assert.equal(h.paper!.latencyMs, 0); assert.equal(h.paper!.leverage, 10);
});

test("automatic fees refresh on exit while preserving the original entry tariff", async t => {
  const f = fixture(t); await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  f.broker.takerRate = async () => ({ rate: 0.0008, at: Date.now(), source: "account-api" });
  await f.trading.closePosition(p.id); const h = f.trading.snapshot().history[0];
  approx(h.entryFee!, h.entryPrice * h.quantity * 0.0006); approx(h.exitFee!, h.exitPrice * h.quantity * 0.0008);
  assert.equal(h.paper!.takerRate, 0.0006); assert.equal(h.paper!.closeFill!.takerRate, 0.0008);
});

test("a stale mark or excessive book slippage cannot create a new paper position", async t => {
  const f = fixture(t);
  const state = f.market.getContractState;
  f.market.getContractState = async () => ({ ...(await state()), at: Date.now() - 6000 });
  await assert.rejects(f.trading.enter("signal"), /свіжих/);
  f.market.getContractState = state;
  f.market.getExecutionBook = async () => ({ at: Date.now(), bids: [[99, 100]], asks: [[101, 100]] });
  await assert.rejects(f.trading.enter("signal"), /відхилення/);
  assert.equal(f.trading.snapshot().positions.length, 0);
});

test("funding debits collateral only when free wallet is exhausted", async t => {
  const f = fixture(t, { initialBalance: 10, orderNotionalUsdt: 25 });
  await f.trading.enter("signal"); const p = f.trading.snapshot().positions[0];
  const b = f.store.get<any>("book:paper", null); b.balance = p.paper!.initialMargin + 0.01; f.store.set("book:paper", b);
  f.at("2026-10-26T08:00:10Z");
  f.market.getFundingEvents = async () => [{ at: Date.parse("2026-10-26T08:00:00Z"), rate: 0.001, price: 100, priceSource: "settlement-mark" }];
  await f.trading.monitor(); const state = f.trading.snapshot().positions[0].paper!;
  approx(state.marginBalance!, p.paper!.initialMargin - (p.quantity * 100 * 0.001 - 0.01));
});

test("a transient websocket stop crossing is latched before the price rebounds", async t => {
  const f = fixture(t); await f.trading.enter("signal");
  (f.trading as any).paperTick("binance", "BTCUSDT", { at: Date.now(), mark: 100, last: 99 });
  (f.trading as any).paperTick("binance", "BTCUSDT", { at: Date.now(), mark: 100, last: 101 });
  await f.trading.stop(); // Waits for the already queued monitor, without opening sockets.
  assert.equal(f.trading.snapshot().history[0].reason, "SL");
});

test("a websocket crossing arriving during REST fallback is not overwritten by the response", async t => {
  const f = fixture(t); await f.trading.enter("signal");
  const state = f.market.getContractState;
  f.market.getContractState = async () => {
    (f.trading as any).paperTick("binance", "BTCUSDT", { at: Date.now(), mark: 100, last: 99 });
    (f.trading as any).paperTick("binance", "BTCUSDT", { at: Date.now(), mark: 100, last: 100 });
    return state();
  };
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().history[0].reason, "SL");
});

test("old positions migrate with a visible legacy warning rather than a reconstructed entry", async t => {
  const f = fixture(t); await f.trading.enter("signal"); const b = f.store.get<any>("book:paper", null);
  delete b.positions[0].paper; f.store.set("book:paper", b);
  await f.trading.monitor(); const p = f.trading.snapshot().positions[0];
  assert.ok(p.paper!.warnings.includes("legacy-entry-not-reconstructed"));
  await f.trading.closePosition(p.id); assert.ok(f.trading.snapshot().history[0].paper!.warnings.includes("legacy-entry-not-reconstructed"));
});

test("websocket adapter uses current Binance routes, Bybit delta fields and rejects stale/invalid frames", () => {
  class Socket extends EventTarget {
    readyState = 1; sent: string[] = []; closed = false;
    send(s: string) { this.sent.push(s); } close() { this.closed = true; }
    message(value: any) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  }
  const sockets: Socket[] = [], urls: string[] = [], ticks: any[] = [];
  const feed = new PaperFeed((e, s, tick) => ticks.push({ e, s, ...tick }), () => {}, url => {
    urls.push(url); const socket = new Socket(); sockets.push(socket); return socket as any;
  });
  try {
    feed.sync([{ exchange: "binance", symbol: "BTCUSDT" }, { exchange: "bybit", symbol: "BTCUSDT" }]);
    assert.ok(urls[0].includes("/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s"));
    sockets[1].dispatchEvent(new Event("open")); assert.ok(sockets[1].sent[0].includes("tickers.BTCUSDT"));
    sockets[0].message({ data: { e: "aggTrade", E: Date.now(), s: "BTCUSDT", p: "100" } });
    sockets[1].message({ topic: "tickers.BTCUSDT", ts: Date.now(), data: { symbol: "BTCUSDT", markPrice: "101" } });
    sockets[0].message({ data: { e: "aggTrade", E: Date.now() - 6000, s: "BTCUSDT", p: "1" } });
    sockets[0].message({ data: { e: "aggTrade", E: Date.now(), s: "BTCUSDT", p: "Infinity" } });
    assert.equal(ticks.length, 2); assert.equal(ticks[1].mark, 101); assert.equal(ticks[1].last, undefined);
    feed.sync([{ exchange: "bybit", symbol: "BTCUSDT" }]); assert.ok(sockets[0].closed);
  } finally { feed.stop(); }
  assert.ok(sockets.every(s => s.closed));
});

test("public market adapters parse actual book timestamps, normalized risk units, funding and Bybit mark candles", async () => {
  const market = new MarketData(() => ({ ...DEFAULT_SETTINGS, requestsPerSecond: 1e6 }), async (input: any) => {
    const url = new URL(String(input)); let result: any;
    if (url.pathname === "/fapi/v1/depth") return Response.json({ E: Date.now(), bids: [["99", "2"]], asks: [["101", "3"]] });
    if (url.pathname === "/v5/market/risk-limit") result = { list: [{ symbol: "BTCUSDT", riskLimitValue: "100000", maintenanceMargin: "0.5", initialMargin: "1", maxLeverage: "100", mmDeduction: "0" }] };
    else if (url.pathname === "/v5/market/funding/history") result = { list: [{ fundingRateTimestamp: "28800000", fundingRate: "0.001" }] };
    else if (url.pathname === "/v5/market/mark-price-kline") result = { list: [["28800000", "100", "101", "99", "100"]] };
    else throw new Error(url.pathname);
    return Response.json({ retCode: 0, result });
  });
  const book = await market.getExecutionBook("binance", "BTCUSDT"); assert.equal(depthFill(book, "buy", 1), 101);
  const tiers = await market.getPublicRiskTiers("BTCUSDT"); approx(tiers[0].rate, 0.005);
  const events = await market.getFundingEvents("bybit", "BTCUSDT", 28800000, 28800001);
  assert.deepEqual(events, [{ at: 28800000, rate: 0.001, price: 100, priceSource: "mark-kline-open-estimate" }]);
});

test("account fee and risk reads never prepare or submit orders; live funding signs follow each venue", async t => {
  const f = fixture(t); f.vault.save("binance", "fake", "fake"); f.vault.save("bybit", "fake", "fake");
  let fees = 0;
  const gateway = new ExchangeGateway(f.vault, async () => ({
    loadMarkets: async () => {}, markets: { "BTC/USDT:USDT": { symbol: "BTC/USDT:USDT", id: "BTCUSDT", swap: true, linear: true, settle: "USDT" } },
    fetchTradingFee: async () => { fees++; return { taker: 0.00055 }; },
    fapiPrivateGetLeverageBracket: async () => [{ symbol: "BTCUSDT", notionalCoef: 2, brackets: [{ notionalCap: 50000, maintMarginRatio: 0.005, cum: 0, initialLeverage: 100 }] }],
    fapiPrivateGetIncome: async () => [{ symbol: "BTCUSDT", time: 1000, tranId: "1", income: "-0.5", asset: "USDT" }],
    privateGetV5ExecutionList: async () => ({ result: { list: [{ symbol: "BTCUSDT", execTime: "1000", execId: "1", execFee: "-0.5" }] } }),
  }));
  approx((await gateway.takerRate("binance", "BTCUSDT")).rate, 0.00055);
  await gateway.takerRate("binance", "BTCUSDT"); assert.equal(fees, 1);
  await gateway.takerRate("binance", "BTCUSDT", true); assert.equal(fees, 2);
  assert.equal((await gateway.riskTiers("BTCUSDT"))[0].cap, 100000);
  approx(await gateway.fundingCost("binance", "BTCUSDT", 0, 2000), 0.5);
  approx(await gateway.fundingCost("bybit", "BTCUSDT", 0, 2000), -0.5);
});

test("private paper-data errors redact exchange messages before they reach the user or logs", async t => {
  const f = fixture(t); f.vault.save("binance", "fake", "fake");
  const gateway = new ExchangeGateway(f.vault, async () => ({
    loadMarkets: async () => { throw Object.assign(new Error("https://exchange.invalid?signature=private-fixture"), { name: "AuthenticationError" }); },
  }));
  await assert.rejects(gateway.takerRate("binance", "BTCUSDT"), { message: "Біржа: AuthenticationError" });
});
