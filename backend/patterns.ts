import { createHash } from "node:crypto";
import { evaluateStrategy, strategyPreset } from "../src/chart/strategyEngine";
import {
  FORMATION_ANALYSIS_VERSION,
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
  return result.events
    .filter((e) => settings.formationTypes.includes(e.subtype || e.label) &&
      e.score >= settings.minScore && (!settings.confirmedOnly || e.state === "confirmed"))
    .flatMap((e) => {
      const direction = e.direction, name = e.subtype || e.label;
      if (direction === "neutral") return [];
      const sign = direction === "bullish" ? 1 : -1;
      const entryPrice = e.p || last.close;
      return [
        {
          id: createHash("sha256")
            .update(`${exchange}:${symbol}:${timeframe}:${e.patternId || `${name}:${e.t}`}`)
            .digest("hex")
            .slice(0, 24),
          exchange,
          symbol,
          timeframe,
          formation: name,
          direction: sign > 0 ? ("LONG" as const) : ("SHORT" as const),
          entryPrice,
          currentPrice: last.close,
          stopLoss: entryPrice * (1 - (sign * settings.stopLossPercent) / 100),
          takeProfit:
            entryPrice * (1 + (sign * settings.takeProfitPercent) / 100),
          confidence: e.score,
          scoreParts: e.scoreParts,
          analysisVersion: FORMATION_ANALYSIS_VERSION,
          status: e.state === "confirmed" ? ("confirmed" as const) : ("watching" as const),
          candleAt: e.t + tfMs(timeframe),
          detectedAt: Date.now(),
          description: e.reasons.join("; "),
        },
      ];
    });
}
