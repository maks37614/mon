import { FORMATION_ANALYSIS_VERSION, type Settings, type Signal } from "./config";
import { formationIsVisible } from "./formationState";
import type { EdwinSignal } from "./edwinStrategy";

export const EV_TEST_ID = "ev-test-v1" as const;

/** Ev-Test never discovers symbols itself. Every entry must be backed by the existing formation screener. */
export function selectEvTestCandidates(
  formations: Signal[],
  strategySignals: EdwinSignal[],
  settings: Settings,
  now = Date.now(),
): Signal[] {
  const eligible = new Set(formations.filter((signal) => formationIsVisible(signal, settings, now))
    .map((signal) => settings.exchange + ":" + signal.symbol));
  return strategySignals
    .filter((signal) => {
      const ageLimit = Math.min(settings.maxSignalAgeSeconds * 1000, signal.timeframe === "1m" ? 90_000 : 180_000);
      return signal.strategyId === EV_TEST_ID
        && signal.exchange === settings.exchange
        && eligible.has(signal.exchange + ":" + signal.symbol)
        && Number.isSafeInteger(signal.candleAt)
        && now - signal.candleAt >= 0 && now - signal.candleAt <= ageLimit
        && Number.isFinite(signal.entryPrice) && signal.entryPrice > 0
        && Number.isFinite(signal.stopLoss) && signal.stopLoss > 0
        && Number.isFinite(signal.takeProfit) && signal.takeProfit > 0
        && Number.isFinite(signal.positionFraction) && signal.positionFraction > 0 && signal.positionFraction <= 1
        && (signal.direction === "LONG"
          ? signal.stopLoss < signal.entryPrice && signal.entryPrice < signal.takeProfit
          : signal.stopLoss > signal.entryPrice && signal.entryPrice > signal.takeProfit);
    })
    .map((signal): Signal => ({
      id: signal.id,
      strategyId: EV_TEST_ID,
      positionFraction: signal.positionFraction,
      exchange: signal.exchange,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      formation: signal.pattern,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      currentPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      confidence: 80, // Classification score, not likelihood of winning.
      analysisVersion: FORMATION_ANALYSIS_VERSION,
      status: "confirmed",
      candleAt: signal.candleAt,
      detectedAt: signal.detectedAt,
      description: "Ev-Test | Зона " + signal.zone + " | " + signal.description,
    }));
}
