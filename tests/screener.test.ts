import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DEFAULT_SETTINGS, tfMs, type Candle, type Signal } from "../backend/config";
import { formationIsVisible, signalAllowsEntry } from "../backend/formationState";
import { detectFormations } from "../backend/patterns";
import { Scanner } from "../backend/scanner";
import { Store } from "../backend/store";
import { Trading } from "../backend/trading";
import { Vault } from "../backend/security";
import { scanIsOverdue, screenerEmptyState } from "../src/screenerStatus";

function storage(t: any) {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-screener-"));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function doubleBottom(timeframe: string, closedAt = Date.now() - 1000): Candle[] {
  const anchors = [[0, 105], [12, 110], [20, 100], [28, 106], [36, 100], [43, 107], [49, 108]];
  return Array.from({ length: 50 }, (_, i) => {
    const left = [...anchors].reverse().find(([at]) => at <= i)!;
    const right = anchors.find(([at]) => at > i) || left;
    const close = left[1] + (right[1] - left[1]) * (i - left[0]) / Math.max(1, right[0] - left[0]);
    return { time: closedAt - (50 - i) * tfMs(timeframe), open: close, close,
      high: close + 0.1, low: close - 0.1, volume: 100 };
  });
}

test("a confirmed double bottom is detected from candles with the configured filters", () => {
  const detected = detectFormations(doubleBottom("1m"), "binance", "BTCUSDT", "1m", DEFAULT_SETTINGS);
  assert.ok(detected.some((signal) => signal.formation === "Double Bottom" && signal.status === "confirmed"));
  assert.ok(detected.every((signal) => signal.confidence >= DEFAULT_SETTINGS.minScore));
});

test("higher-timeframe formations remain visible while expired entries stay blocked", async (t) => {
  const store = storage(t);
  const settings = { ...DEFAULT_SETTINGS, timeframes: ["1h"], autoEntries: true };
  store.set("settings", settings);
  const detected = detectFormations(doubleBottom("1h", Date.now() - 5 * 60_000), "binance", "BTCUSDT", "1h", settings);
  assert.ok(detected.length);
  store.set("signals", detected);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  const trading = new Trading(store, {} as any, vault, {} as any, false);
  const state = trading.snapshot();
  assert.equal(state.signals.length, 0);
  assert.equal(state.formations.length, detected.length);
  assert.ok(state.formations.every((signal) => signal.canEnter === false));
  await assert.rejects(trading.enter(detected[0].id), /застарів/);
  const at = detected[0].candleAt;
  assert.equal(formationIsVisible(detected[0], settings, at + tfMs("1h") + 1), false);
  assert.equal(signalAllowsEntry(detected[0], settings, at + 60_000), true);
  assert.equal(formationIsVisible({ ...detected[0], timeframe: "4h" }, settings), false);
});

test("scanner interleaves timeframes and retains visible results outside the current batch", async (t) => {
  const store = storage(t);
  const settings = { ...DEFAULT_SETTINGS, timeframes: ["5m", "1h", "4h"], scanBatchSize: 10 };
  store.set("settings", settings);
  const retained = detectFormations(doubleBottom("4h", Date.now() - 5 * 60_000), "binance", "ZEDUSDT", "4h", settings)[0];
  assert.ok(retained);
  store.set("signals", [retained]);
  const calls: string[] = [];
  const market: any = {
    getMarkets: async () => Array.from({ length: 10 }, (_, i) => ({ symbol: i === 9 ? "ZEDUSDT" : `COIN${i}USDT` })),
    getCandles: async (_exchange: string, symbol: string, timeframe: string) => {
      calls.push(`${symbol}:${timeframe}`);
      return doubleBottom(timeframe, Date.now() - 5 * 60_000);
    },
    status: () => ({}),
  };
  const scanner = new Scanner(store, market);
  scanner.start();
  await scanner.task;
  assert.deepEqual(calls.slice(0, 3), ["COIN0USDT:5m", "COIN0USDT:1h", "COIN0USDT:4h"]);
  assert.equal(calls.length, 10);
  const state = store.get<any>("scanner", {});
  assert.equal(state.cursor, 10);
  assert.equal(state.successful, 10);
  assert.ok(state.detected > 0);
  assert.ok(store.get<Signal[]>("signals", []).some((signal) => signal.id === retained.id));
});

test("market-list and candle failures are reported as failures rather than empty successful scans", async (t) => {
  const store = storage(t);
  const market: any = { getMarkets: async () => { throw new Error("API binance: HTTP 503"); } };
  const scanner = new Scanner(store, market);
  scanner.start();
  await scanner.task;
  const failedListing = store.get<any>("scanner", {});
  assert.ok(failedListing.lastStartedAt > 0);
  assert.ok(failedListing.finishedAt >= failedListing.lastStartedAt);
  assert.match(failedListing.error, /503/);
  assert.equal(scanner.start().reason, "interval");
  market.getMarkets = async () => Array.from({ length: 10 }, (_, i) => ({ symbol: `COIN${i}USDT` }));
  market.getCandles = async () => { throw new Error("API binance: HTTP 502"); };
  market.status = () => ({});
  scanner.start(true);
  await scanner.task;
  const failedCandles = store.get<any>("scanner", {});
  assert.equal(failedCandles.successful, 0);
  assert.equal(failedCandles.failed, 10);
  assert.equal(failedCandles.errors.length, 3);
  assert.match(failedCandles.error, /502/);
});

test("cron heartbeat survives an already-running batch and its progress writes", async (t) => {
  const store = storage(t);
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const market: any = {
    getMarkets: async () => [{ symbol: "BTCUSDT" }],
    getCandles: async () => { started(); await waiting; return []; },
    status: () => ({}),
  };
  const scanner = new Scanner(store, market);
  scanner.start();
  await begun;
  assert.equal(scanner.start(false, "cron").reason, "running");
  const heartbeat = store.get<any>("scanner", {}).lastCronAt;
  assert.ok(heartbeat > 0);
  release();
  await scanner.task;
  assert.equal(store.get<any>("scanner", {}).lastCronAt, heartbeat);
  assert.equal(store.get<any>("scanner", {}).lastTrigger, "manual");
});

test("flag formations respect the minimum score rather than bypassing the filter", () => {
  const candles: Candle[] = Array.from({ length: 60 }, (_, i) => {
    let open = 100, close = 100;
    if (i >= 30 && i <= 44) { open += (i - 30) * 0.2; close = open + 0.1; }
    if (i >= 45) open = close = 102.5;
    if (i === 59) close = 103;
    return { time: Date.now() - (60 - i) * 60_000, open, close,
      high: Math.max(open, close) + 0.05, low: Math.min(open, close) - 0.05, volume: 100 };
  });
  const settings = { ...DEFAULT_SETTINGS, formationTypes: ["Bull Flag"], minScore: 80 };
  assert.equal(detectFormations(candles, "binance", "BTCUSDT", "1m", settings).length, 1);
  assert.deepEqual(detectFormations(candles, "binance", "BTCUSDT", "1m", { ...settings, minScore: 95 }), []);
});

test("empty screener explains loading, API errors, missing cron, search, and genuine no-match results", () => {
  const now = Date.now();
  assert.match(screenerEmptyState({ running: true }, DEFAULT_SETTINGS, "external", false, 0, now).title, /триває/);
  assert.match(screenerEmptyState({ error: "API 503" }, DEFAULT_SETTINGS, "external", false, 0, now).detail, /503/);
  assert.match(screenerEmptyState({}, DEFAULT_SETTINGS, "external", false, 0, now).title, /ще не/);
  assert.match(screenerEmptyState({ lastStartedAt: now - 10 * 60_000 }, DEFAULT_SETTINGS, "external", false, 0, now).detail, /cron-job/);
  assert.match(screenerEmptyState({}, DEFAULT_SETTINGS, "external", true, 4, now).title, /пошуком/);
  assert.match(screenerEmptyState({ lastStartedAt: now - 1000 }, DEFAULT_SETTINGS, "external", false, 0, now).detail, /75\/100/);
  assert.equal(scanIsOverdue({ running: true, lastStartedAt: now - 10 * 60_000 }, DEFAULT_SETTINGS, now), false);
});
