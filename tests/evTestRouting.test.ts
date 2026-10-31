import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION, type Signal } from "../backend/config";
import { EV_TEST_ID, selectEvTestCandidates } from "../backend/evTestRouting";
import { EDWIN_DEFAULTS, detectEdwinSetups, type EdwinSignal } from "../backend/edwinStrategy";

const now = Date.now();
function formation(symbol: string): Signal {
  return {
    id: symbol + ":source", exchange: "binance", symbol, timeframe: "1m",
    formation: "Double Top", direction: "LONG", entryPrice: 100, currentPrice: 100,
    stopLoss: 99.75, takeProfit: 102.5, confidence: 90,
    analysisVersion: FORMATION_ANALYSIS_VERSION, status: "confirmed",
    candleAt: now - 30_000, detectedAt: now - 30_000, description: "fixture",
  };
}
function ev(symbol: string, candleAt = now - 30_000): EdwinSignal {
  return {
    id: symbol + ":ev", strategyId: EV_TEST_ID,
    exchange: "binance", symbol, timeframe: "1m", zone: 3,
    pattern: "Пробій локального хая", direction: "LONG", candleAt, detectedAt: now,
    entryPrice: 100, stopLoss: 99.5, takeProfit: 102.5,
    positionFraction: 0.5, description: "test",
  };
}
test("Ev-Test can only trade symbols currently selected by existing formation screener", () => {
  const selection = selectEvTestCandidates(
    [formation("BTCUSDT")], [ev("BTCUSDT"), ev("SOLUSDT")],
    DEFAULT_SETTINGS, now,
  );
  assert.equal(selection.length, 1);
  assert.equal(selection[0].symbol, "BTCUSDT");
  assert.equal(selection[0].formation, "Пробій локального хая");
  assert.equal(selection[0].strategyId, EV_TEST_ID);
  assert.equal(selection[0].positionFraction, 0.5);
});
test("Ev-Test cannot execute old candles, unknown exchanges or invalid stops", () => {
  const valid = formation("BTCUSDT");
  const bad = { ...ev("BTCUSDT"), stopLoss: 101 };
  assert.equal(selectEvTestCandidates([valid], [bad], DEFAULT_SETTINGS, now).length, 0);
  assert.equal(selectEvTestCandidates([valid], [ev("BTCUSDT", now - 100_000)], DEFAULT_SETTINGS, now).length, 0);
  assert.equal(selectEvTestCandidates([valid], [{ ...ev("BTCUSDT"), exchange: "bybit" }], DEFAULT_SETTINGS, now).length, 0);
  assert.equal(selectEvTestCandidates([], [ev("BTCUSDT")], DEFAULT_SETTINGS, now).length, 0);
});
test("Ev-Test source requires correct strategy ID and does not invent signals on flat charts", () => {
  assert.equal(EV_TEST_ID, "ev-test-v1");
  const bars = Array.from({ length: 100 }, (_, i) =>
    ({ time: i * 60_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 }));
  assert.deepEqual(detectEdwinSetups("binance", "BTCUSDT", bars, [], EDWIN_DEFAULTS), []);
});
