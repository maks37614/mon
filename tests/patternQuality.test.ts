import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, tfMs, type Candle } from "../backend/config";
import { detectFormations } from "../backend/patterns";
import { evaluateStrategy, strategyPreset } from "../src/chart/strategyEngine";

function candlesFrom(anchors: number[][], length: number, scale = 1): Candle[] {
  const end = 1_790_000_000_000;
  return Array.from({ length }, (_, i) => {
    const left = [...anchors].reverse().find(([at]) => at <= i)!;
    const right = anchors.find(([at]) => at > i) || left;
    const close = (left[1] + (right[1] - left[1]) * (i - left[0]) / Math.max(1, right[0] - left[0])) * scale;
    return { time: end + i * 60_000, open: close, close,
      high: close + 0.05 * scale, low: close - 0.05 * scale, volume: 100 };
  });
}
const bottomAnchors = [[0, 105], [12, 110], [20, 100], [28, 106], [36, 100], [43, 107], [49, 108]];
const settings = { ...DEFAULT_SETTINGS, minScore: 50, confirmedOnly: false };
function bottom(candles: Candle[]) {
  return detectFormations(candles, "binance", "BTCUSDT", "1m", settings)
    .find(signal => signal.formation === "Double Bottom");
}
function events(candles: Candle[]) {
  const series = candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
  const base = strategyPreset("patterns_wide")!;
  return evaluateStrategy({ ...base, config: { ...base.config, patternTfs: ["1m"], patternMinScore: 0 } }, {
    series: { "1m": series }, chartCandles: series, levels: [], densities: [], book: { a: [], b: [] },
    oiHistory: [], fundingHistory: [], fundingRate: 0, currentPrice: series.at(-1)!.c,
  }).events;
}

test("an unconfirmed formation cannot receive a perfect confirmed score", () => {
  const developing = bottom(candlesFrom([...bottomAnchors.slice(0, 5), [43, 104], [49, 105]], 50));
  assert.ok(developing);
  assert.equal(developing.status, "watching");
  assert.ok(developing.confidence <= 60, `Unconfirmed score: ${developing.confidence}`);
});

test("ordinary volume and a clean double bottom do not automatically mean 100/100", () => {
  const signal = bottom(candlesFrom(bottomAnchors, 50));
  assert.ok(signal);
  assert.ok(signal.confidence >= 75 && signal.confidence < 100, `Score: ${signal.confidence}`);
});

test("the breakout candle and signal identity do not move forward on every rescan", () => {
  const candles = candlesFrom(bottomAnchors, 50);
  const signal = bottom(candles)!;
  assert.ok(signal);
  const expected = candles.find((c, i) => i > 36 && c.close > 106.05)!.time + tfMs("1m");
  assert.equal(signal.candleAt, expected);
  const extended = [...candles, { ...candles.at(-1)!, time: candles.at(-1)!.time + 60_000, close: 108.1, high: 108.2 }];
  const rescanned = bottom(extended)!;
  assert.equal(rescanned.candleAt, signal.candleAt);
  assert.equal(rescanned.id, signal.id);
});

test("a large mismatch relative to pattern depth is not a double bottom", () => {
  const malformed = candlesFrom(bottomAnchors.map(([i, p]) => [i, i === 36 ? 103 : p]), 50);
  assert.equal(bottom(malformed), undefined);
});

const triangleAnchors = [[0, 105], [10, 110], [16, 100], [22, 109], [28, 101], [34, 108],
  [40, 102], [46, 107], [52, 103], [58, 106], [62, 104.5], [63, 103.5]];
test("a symmetric triangle breaking downward uses its lower trendline as entry", () => {
  const triangle = events(candlesFrom(triangleAnchors, 64)).find(e => e.subtype === "Symmetric Triangle");
  assert.ok(triangle);
  assert.equal(triangle.direction, "bearish");
  assert.equal(triangle.state, "confirmed");
  const lower = triangle.lines!.find(line => line.label === "lower")!;
  assert.ok(Math.abs(triangle.p! - lower.p1) < 0.1, `Entry ${triangle.p}, lower ${lower.p1}`);
});

test("trendlines that have crossed their apex cannot produce a fresh perfect triangle", () => {
  const crossed = candlesFrom([...triangleAnchors, [76, 103]], 77);
  assert.equal(events(crossed).some(e => e.subtype === "Symmetric Triangle"), false);
});

test("scores are independent of a coin's price scale", () => {
  const base = bottom(candlesFrom(bottomAnchors, 50))!;
  const cheap = bottom(candlesFrom(bottomAnchors, 50, 0.000001))!;
  assert.ok(base && cheap);
  assert.equal(cheap.confidence, base.confidence);
});

const headAnchors = [[0, 104], [8, 102], [16, 110], [24, 104], [32, 115], [40, 104], [48, 110], [55, 103], [59, 102]];
const ascending = [[0, 105], [10, 110], [16, 100], [22, 110], [28, 102], [34, 110], [40, 104],
  [46, 110], [52, 106], [58, 110], [62, 108.5], [63, 111]];
const rising = [[0, 105], [10, 110], [16, 100], [22, 111], [28, 102], [34, 112], [40, 104],
  [46, 113], [52, 106], [58, 114], [62, 110], [63, 107]];
const mirror = (candles: Candle[]) => candles.map(c => ({ ...c, open: 220 - c.open, close: 220 - c.close,
  high: 220 - c.low, low: 220 - c.high }));
function flag(): Candle[] {
  return Array.from({ length: 60 }, (_, i) => {
    let open = 100, close = 100;
    if (i >= 30 && i <= 44) { open += (i - 30) * .2; close = open + .1; }
    if (i >= 45) open = close = 102.5;
    if (i === 59) close = 103;
    return { time: 1_790_000_000_000 + i * 60_000, open, close,
      high: Math.max(open, close) + .05, low: Math.min(open, close) - .05, volume: 100 };
  });
}
const cases: [string, Candle[], string][] = [
  ["Double Bottom", candlesFrom(bottomAnchors, 50), "LONG"],
  ["Double Top", mirror(candlesFrom(bottomAnchors, 50)), "SHORT"],
  ["H&S", candlesFrom(headAnchors, 60), "SHORT"],
  ["Inverse H&S", mirror(candlesFrom(headAnchors, 60)), "LONG"],
  ["Ascending Triangle", candlesFrom(ascending, 64), "LONG"],
  ["Descending Triangle", mirror(candlesFrom(ascending, 64)), "SHORT"],
  ["Symmetric Triangle", candlesFrom(triangleAnchors, 64), "SHORT"],
  ["Symmetric Triangle", mirror(candlesFrom(triangleAnchors, 64)), "LONG"],
  ["Rising Wedge", candlesFrom(rising, 64), "SHORT"],
  ["Falling Wedge", mirror(candlesFrom(rising, 64)), "LONG"],
  ["Bull Flag", flag(), "LONG"],
  ["Bear Flag", mirror(flag()), "SHORT"],
];
for (const [formation, candles, direction] of cases) {
  test(`${formation} ${direction} has the correct direction, levels, bounded score and exact filter`, () => {
    const signal = detectFormations(candles, "binance", "BTCUSDT", "1m", { ...settings, confirmedOnly: true })
      .find(s => s.formation === formation);
    assert.ok(signal, `Missing ${formation}`);
    assert.equal(signal.direction, direction);
    assert.equal(signal.status, "confirmed");
    const parts = signal.scoreParts!;
    assert.ok(parts);
    assert.ok(Number.isInteger(signal.confidence) && signal.confidence >= 0 && signal.confidence <= 100);
    assert.ok(parts.structure >= 0 && parts.structure <= 60 && parts.breakout >= 0 && parts.breakout <= 25 && parts.volume >= 0 && parts.volume <= 15);
    assert.equal(parts.structure + parts.breakout + parts.volume, signal.confidence);
    const sign = direction === "LONG" ? 1 : -1;
    assert.ok(sign * (signal.takeProfit - signal.entryPrice) > 0);
    assert.ok(sign * (signal.entryPrice - signal.stopLoss) > 0);
    const strict = { ...settings, minScore: signal.confidence + 1, formationTypes: [formation] };
    assert.deepEqual(detectFormations(candles, "binance", "BTCUSDT", "1m", strict), []);
    assert.ok(detectFormations(candles, "binance", "BTCUSDT", "1m", { ...strict, minScore: signal.confidence }).length);
  });
}

test("breakout volume changes only its own score component and flags do not have a fixed score", () => {
  for (const candles of [candlesFrom(bottomAnchors, 50), flag()]) {
    const formation = candles.length === 50 ? "Double Bottom" : "Bull Flag";
    const first = detectFormations(candles, "binance", "BTCUSDT", "1m", settings).find(s => s.formation === formation)!;
    const at = candles.findIndex(c => c.time + 60_000 === first.candleAt);
    const stronger = candles.map((c, i) => i === at ? { ...c, volume: 200 } : c);
    const second = detectFormations(stronger, "binance", "BTCUSDT", "1m", settings).find(s => s.formation === formation)!;
    assert.equal(second.scoreParts!.structure, first.scoreParts!.structure);
    assert.equal(second.scoreParts!.breakout, first.scoreParts!.breakout);
    assert.equal(second.confidence - first.confidence, 10);
    assert.equal(first.id, second.id);
  }
});

test("a breakout that returned inside the formation is excluded instead of renewed", () => {
  const candles = candlesFrom(bottomAnchors, 50);
  const next = { ...candles.at(-1)!, time: candles.at(-1)!.time + 60_000, open: 105, close: 105, low: 104.9, high: 105.1 };
  assert.equal(bottom([...candles, next]), undefined);
});

test("malformed or duplicate candles cannot produce a score", () => {
  const candles = candlesFrom(bottomAnchors, 50);
  for (const corrupt of [{ close: NaN }, { high: 0 }, { volume: -1 }, { time: candles[48].time }]) {
    const malformed = candles.map((c, i) => i === 49 ? { ...c, ...corrupt } : c);
    assert.deepEqual(events(malformed), []);
  }
});
