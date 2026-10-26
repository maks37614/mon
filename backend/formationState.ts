import { tfMs, type Settings, type Signal } from "./config";

export function formationIsVisible(signal: Signal, settings: Settings, now = Date.now()) {
  const visibleFor = Math.max(tfMs(signal.timeframe), settings.maxSignalAgeSeconds * 1000);
  return signal.exchange === settings.exchange &&
    settings.timeframes.includes(signal.timeframe) &&
    settings.formationTypes.includes(signal.formation) &&
    signal.confidence >= settings.minScore &&
    (!settings.confirmedOnly || signal.status === "confirmed") &&
    signal.candleAt <= now + 2000 && now - signal.candleAt <= visibleFor;
}

export function signalAllowsEntry(signal: Signal, settings: Settings, now = Date.now()) {
  return formationIsVisible(signal, settings, now) &&
    now - signal.candleAt <= settings.maxSignalAgeSeconds * 1000;
}
