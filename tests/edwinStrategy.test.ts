import test from "node:test";
import assert from "node:assert/strict";
import { EDWIN_DEFAULTS, EDWIN_STRATEGY, detectEdwinSetups, validateEdwinSettings } from "../backend/edwinStrategy";
import type { Candle } from "../backend/config";

const candles = (count: number, interval: number, close: number): Candle[] =>
  Array.from({ length: count }, (_, index) => ({
    time: (index + 1) * interval,
    open: close, high: close * 1.002,
    low: close * 0.998, close, volume: 1000,
  }));

test("Edwin strategy is disabled until explicitly enabled", () => {
  assert.equal(EDWIN_DEFAULTS.enabled, false);
  assert.equal(EDWIN_STRATEGY.id, "edwin-breakouts-v1");
});

test("Edwin settings validate and reject unknown or excessive risk settings", () => {
  const enabled = validateEdwinSettings({ enabled: true, symbolsPerBatch: 15 }, EDWIN_DEFAULTS);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.symbolsPerBatch, 15);
  assert.equal(EDWIN_DEFAULTS.enabled, false);
  assert.throws(() => validateEdwinSettings({ orderNotionalUsdt: 1_000_000 }, EDWIN_DEFAULTS), /Невідомий/);
  assert.throws(() => validateEdwinSettings({ symbolsPerBatch: 5000 }, EDWIN_DEFAULTS), /symbolsPerBatch/);
  assert.throws(() => validateEdwinSettings({ stopLossPercent: 2, takeProfitPercent: 0.5 }, EDWIN_DEFAULTS), /Ціль/);
});

test("Edwin analyzer requires closed 5m breakout and never emits order instructions", () => {
  const one = candles(60, 60_000, 100);
  const five = candles(99, 300_000, 100);
  five.push({
    time: 100 * 300_000,
    open: 100, high: 103, low: 99.8, close: 102, volume: 1900,
  });
  const signals = detectEdwinSetups("binance", "BTCUSDT", one, five, EDWIN_DEFAULTS);
  const breakout = signals.find((signal) => signal.pattern === "Пробій верхнього рівня");
  assert.ok(breakout);
  assert.equal(breakout.direction, "LONG");
  assert.equal(breakout.zone, 2);
  assert.equal(breakout.entryPrice, 102);
  assert.ok(breakout.stopLoss < breakout.entryPrice);
  assert.ok(breakout.takeProfit > breakout.entryPrice);
  assert.equal("orderNotionalUsdt" in breakout, false);
  assert.equal("leverage" in breakout, false);
});

test("Edwin analyzer does not signal when nothing is breaking", () => {
  const one = candles(80, 60_000, 100);
  const five = candles(100, 300_000, 100);
  assert.equal(detectEdwinSetups("binance", "BTCUSDT", one, five, EDWIN_DEFAULTS).length, 0);
  assert.deepEqual(detectEdwinSetups("bybit", "ETHUSDT", [], [], EDWIN_DEFAULTS), []);
});
