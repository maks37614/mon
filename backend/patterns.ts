import { createHash } from "node:crypto";
import { evaluateStrategy, strategyPreset } from "../src/chart/strategyEngine";
import {
  tfMs,
  type Candle,
  type Exchange,
  type Settings,
  type Signal,
} from "./config";

export function detectFormations(
  candles: Candle[],
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  settings: Settings,
): Signal[] {
  if (candles.length < 40) return [];
  const last = candles.at(-1)!;
  const series = candles.map((c) => ({
    t: c.time,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  }));
  const base = strategyPreset("patterns_wide")!;
  const preset = {
    ...base,
    config: {
      ...base.config,
      patternTfs: [timeframe],
      patternMinScore: settings.minScore,
      onlyConfirmed: settings.confirmedOnly,
      allPatterns: true,
    },
  };
  const result = evaluateStrategy(preset, {
    series: { [timeframe]: series },
    chartCandles: series,
    levels: [],
    densities: [],
    book: { b: [], a: [] },
    oiHistory: [],
    fundingHistory: [],
    fundingRate: 0,
    currentPrice: last.close,
  });
  const events = result.events.map((e) => ({
    name: e.subtype || e.label,
    direction: e.direction,
    confidence: e.score,
    confirmed: e.state === "confirmed",
    price: e.p || last.close,
    reasons: e.reasons.join("; "),
  }));
  // Flags require a measurable impulse, a smaller consolidation, and a real closing breakout.
  const impulse = candles.slice(-30, -15),
    flag = candles.slice(-15, -1);
  if (impulse.length === 15 && flag.length === 14) {
    const movement = impulse.at(-1)!.close - impulse[0].open;
    const high = Math.max(...flag.map((c) => c.high)),
      low = Math.min(...flag.map((c) => c.low));
    const ratio = Math.abs(movement) / impulse[0].open;
    const tight = high - low < Math.abs(movement) * 0.6;
    const direction = movement > 0 ? "bullish" : "bearish";
    const confirmed = movement > 0 ? last.close > high : last.close < low;
    if (ratio >= 0.015 && tight && confirmed)
      events.push({
        name: movement > 0 ? "Bull Flag" : "Bear Flag",
        direction,
        confidence: 80,
        confirmed: true,
        price: movement > 0 ? high : low,
        reasons: `Імпульс ${(ratio * 100).toFixed(2)}%, консолідація та закриття за її межею`,
      });
  }
  return events
    .filter((e) => settings.formationTypes.includes(e.name))
    .flatMap((e) => {
      let direction = e.direction;
      if (direction === "neutral") {
        const event = result.events.find(
          (x) => (x.subtype || x.label) === e.name,
        );
        const lines = event?.lines || [];
        const upper = lines.find((l) => l.label === "upper")?.p1;
        const lower = lines.find((l) => l.label === "lower")?.p1;
        if (upper && last.close > upper) direction = "bullish";
        else if (lower && last.close < lower) direction = "bearish";
        else return [];
      }
      const sign = direction === "bullish" ? 1 : -1;
      return [
        {
          id: createHash("sha256")
            .update(`${exchange}:${symbol}:${timeframe}:${e.name}:${last.time}`)
            .digest("hex")
            .slice(0, 24),
          exchange,
          symbol,
          timeframe,
          formation: e.name,
          direction: sign > 0 ? ("LONG" as const) : ("SHORT" as const),
          entryPrice: e.price,
          currentPrice: last.close,
          stopLoss: last.close * (1 - (sign * settings.stopLossPercent) / 100),
          takeProfit:
            last.close * (1 + (sign * settings.takeProfitPercent) / 100),
          confidence: e.confidence,
          status: e.confirmed ? ("confirmed" as const) : ("watching" as const),
          candleAt: last.time + tfMs(timeframe),
          detectedAt: Date.now(),
          description: e.reasons,
        },
      ];
    });
}
