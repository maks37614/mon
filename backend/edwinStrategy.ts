import type { Candle, Exchange } from "./config";

/** This module only produces observations. It never creates orders or alters Trading. */
export type EdwinSettings = {
  enabled: boolean;
  scanIntervalSeconds: number;
  symbolsPerBatch: number;
  proximityPercent: number;
  breakoutBufferPercent: number;
  minimumTouches: number;
  stopLossPercent: number;
  takeProfitPercent: number;
};

export const EDWIN_DEFAULTS: EdwinSettings = {
  enabled: false,
  scanIntervalSeconds: 60,
  symbolsPerBatch: 30,
  proximityPercent: 4,
  breakoutBufferPercent: 0.08,
  minimumTouches: 3,
  stopLossPercent: 0.5,
  takeProfitPercent: 2.5,
};

export const EDWIN_STRATEGY = {
  id: "edwin-breakouts-v1",
  name: "Edwin — рівні, пробої та трендові",
  description: "Евристичний пошук сетапів лекції на закритих 1m / 5m свічках. Не є доказом прибутковості.",
  implemented: [
    "Пробій рівня (зона 2)",
    "Наторговка перед рівнем (зона 3)",
    "Каскад максимумів / мінімумів (зона 4)",
    "Пробій наклонки / трендової (зони 3–4)",
    "Повторний пробій лою (зона 5)",
    "Перший перехай / перелой після імпульсу (зона 1)",
    "Продовження після імпульсної наторговки (зона 1)",
  ],
  unsupported: [
    "Стакан, щільності, реальна ліквідність і зняття стопів",
    "Суб’єктивна якість сетапу та поведінка конкретної монети",
    "Автоматичне виконання або збільшення торгових позицій",
  ],
} as const;

export function validateEdwinSettings(input: unknown, previous: EdwinSettings): EdwinSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Некоректні налаштування стратегії");
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !(key in EDWIN_DEFAULTS))) throw new Error("Невідомий параметр стратегії");
  const next = { ...previous, ...source } as EdwinSettings;
  if (typeof next.enabled !== "boolean") throw new Error("enabled має бути логічним");
  const numeric: Record<Exclude<keyof EdwinSettings, "enabled">, [number, number, boolean]> = {
    scanIntervalSeconds: [60, 3600, true],
    symbolsPerBatch: [5, 80, true],
    proximityPercent: [1, 8, false],
    breakoutBufferPercent: [0.02, 0.5, false],
    minimumTouches: [3, 6, true],
    stopLossPercent: [0.2, 2, false],
    takeProfitPercent: [0.5, 10, false],
  };
  for (const [key, [min, max, integer]] of Object.entries(numeric)) {
    const value = next[key as keyof EdwinSettings];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error("Некоректний параметр " + key + " (від " + min + " до " + max + ")");
  }
  if (next.takeProfitPercent < next.stopLossPercent * 1.5)
    throw new Error("Ціль має бути не меншою за 1.5 стопа");
  return next;
}

export type EdwinSignal = {
  id: string;
  strategyId: "edwin-breakouts-v1";
  exchange: Exchange;
  symbol: string;
  timeframe: "1m" | "5m";
  zone: number;
  pattern: string;
  direction: "LONG" | "SHORT";
  candleAt: number;
  detectedAt: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  description: string;
};

type Direction = EdwinSignal["direction"];
const pct = (a: number, b: number) => b > 0 ? Math.abs(a / b - 1) * 100 : Infinity;
const maxHigh = (rows: Candle[]) => Math.max(...rows.map((c) => c.high));
const minLow = (rows: Candle[]) => Math.min(...rows.map((c) => c.low));

function pivots(rows: Candle[], side: "high" | "low"): { index: number; value: number }[] {
  const result: { index: number; value: number }[] = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const value = rows[i][side];
    if ([1, 2].every((offset) => side === "high"
      ? value > rows[i - offset].high && value >= rows[i + offset].high
      : value < rows[i - offset].low && value <= rows[i + offset].low)) result.push({ index: i, value });
  }
  return result;
}

function lineBreak(rows: Candle[], side: "high" | "low", touches: number, buffer: number):
  { direction: Direction; value: number } | null {
  if (rows.length < 30) return null;
  const previous = rows.slice(0, -1);
  const swings = pivots(previous, side).slice(-9);
  if (swings.length < touches) return null;
  const selected = swings.slice(-touches);
  const first = selected[0];
  const last = selected[selected.length - 1];
  const slope = (last.value - first.value) / (last.index - first.index || 1);
  if (side === "high" && slope >= 0) return null;
  if (side === "low" && slope <= 0) return null;
  const estimate = (at: number) => first.value + slope * (at - first.index);
  if (selected.some((point) => pct(point.value, estimate(point.index)) > 0.65)) return null;
  const priorLine = estimate(rows.length - 2);
  const currentLine = estimate(rows.length - 1);
  const prior = rows[rows.length - 2].close, current = rows[rows.length - 1].close;
  if (side === "high" && prior <= priorLine * (1 + buffer) && current > currentLine * (1 + buffer))
    return { direction: "LONG", value: currentLine };
  if (side === "low" && prior >= priorLine * (1 - buffer) && current < currentLine * (1 - buffer))
    return { direction: "SHORT", value: currentLine };
  return null;
}

export function detectEdwinSetups(
  exchange: Exchange,
  symbol: string,
  oneMinute: Candle[],
  fiveMinute: Candle[],
  settings: EdwinSettings,
): EdwinSignal[] {
  const all: EdwinSignal[] = [];
  const buffer = settings.breakoutBufferPercent / 100;
  const now = Date.now();
  function add(rows: Candle[], timeframe: "1m" | "5m", zone: number, pattern: string, direction: Direction, description: string) {
    if (rows.length < 30) return;
    const latest = rows[rows.length - 1];
    const entry = latest.close;
    if (!Number.isFinite(entry) || entry <= 0) return;
    const factor = direction === "LONG" ? 1 : -1;
    all.push({
      id: [EDWIN_STRATEGY.id, exchange, symbol, timeframe, pattern, direction, latest.time].join(":"),
      strategyId: EDWIN_STRATEGY.id,
      exchange, symbol, timeframe, zone, pattern, direction,
      candleAt: latest.time,
      detectedAt: now,
      entryPrice: entry,
      stopLoss: entry * (1 - factor * settings.stopLossPercent / 100),
      takeProfit: entry * (1 + factor * settings.takeProfitPercent / 100),
      description,
    });
  }

  const slow = fiveMinute;
  if (slow.length >= 90) {
    const before = slow.slice(-90, -2);
    const high = maxHigh(before), low = minLow(before);
    const previous = slow[slow.length - 2], latest = slow[slow.length - 1];
    if (previous.close <= high * (1 + buffer) && latest.close > high * (1 + buffer))
      add(slow, "5m", 2, "Пробій верхнього рівня", "LONG", "Закрита 5m свічка пробила максимум попередніх 88 свічок.");
    if (previous.close >= low * (1 - buffer) && latest.close < low * (1 - buffer))
      add(slow, "5m", 5, "Повторний пробій лою", "SHORT", "Закрита 5m свічка пройшла історичний локальний мінімум; підтвердження структури потрібне вручну.");

    const consolidation = slow.slice(-9, -1);
    const rangeHigh = maxHigh(consolidation), rangeLow = minLow(consolidation);
    const rangePercent = pct(rangeHigh, rangeLow);
    if (rangePercent >= 0.25 && rangePercent <= 2 && pct(rangeHigh, high) <= settings.proximityPercent
        && latest.close > rangeHigh * (1 + buffer) && previous.close <= rangeHigh * (1 + buffer))
      add(slow, "5m", 3, "Пробій наторговки перед рівнем", "LONG", "Вихід з вузького 5m діапазону в межах заданої відстані до опору.");
    if (rangePercent >= 0.25 && rangePercent <= 2 && pct(rangeLow, low) <= settings.proximityPercent
        && latest.close < rangeLow * (1 - buffer) && previous.close >= rangeLow * (1 - buffer))
      add(slow, "5m", 3, "Пробій наторговки перед підтримкою", "SHORT", "Вихід з вузького 5m діапазону перед підтримкою.");

    const recent = slow.slice(-85, -1);
    for (const side of ["high", "low"] as const) {
      const points = pivots(recent, side);
      for (const anchor of points.slice(-8)) {
        const nearby = points.filter((point) => pct(point.value, anchor.value) <= 0.45);
        if (nearby.length < settings.minimumTouches) continue;
        if (nearby.at(-1)!.index - nearby[0].index < 5) continue;
        const level = side === "high" ? Math.max(...nearby.map((p) => p.value)) : Math.min(...nearby.map((p) => p.value));
        if (side === "high" && previous.close <= level * (1 + buffer) && latest.close > level * (1 + buffer))
          add(slow, "5m", 4, "Пробій каскаду хаїв", "LONG", "Щонайменше " + settings.minimumTouches + " близьких локальних максимумів і підтверджений пробій.");
        if (side === "low" && previous.close >= level * (1 - buffer) && latest.close < level * (1 - buffer))
          add(slow, "5m", 4, "Пробій каскаду лоїв", "SHORT", "Щонайменше " + settings.minimumTouches + " близьких локальних мінімумів і підтверджений пробій.");
        break;
      }
    }
    for (const side of ["high", "low"] as const) {
      const line = lineBreak(slow.slice(-70), side, settings.minimumTouches, buffer);
      if (line) add(slow, "5m", 4, "Пробій наклонки / трендової", line.direction, "Злам похилої лінії із " + settings.minimumTouches + "+ локальними дотиками на 5m.");
    }
  }

  const fast = oneMinute;
  if (fast.length >= 55) {
    const last = fast[fast.length - 1], prev = fast[fast.length - 2];
    const impulseStart = fast[fast.length - 9];
    const impulseEnd = fast[fast.length - 4];
    const impulsePercent = (impulseEnd.close / impulseStart.open - 1) * 100;
    if (Math.abs(impulsePercent) >= 7) {
      const direction: Direction = impulsePercent > 0 ? "LONG" : "SHORT";
      const segment = fast.slice(-5, -1);
      if (direction === "LONG" && minLow(segment) > impulseStart.open && last.close > maxHigh(segment) * (1 + buffer) && prev.close <= maxHigh(segment) * (1 + buffer))
        add(fast, "1m", 1, "Перший перехай після імпульсу", "LONG", "Імпульс 7%+ на 1m і пробій короткої корекції.");
      if (direction === "SHORT" && maxHigh(segment) < impulseStart.open && last.close < minLow(segment) * (1 - buffer) && prev.close >= minLow(segment) * (1 - buffer))
        add(fast, "1m", 1, "Перший перелой після імпульсу", "SHORT", "Імпульс 7%+ на 1m і пробій короткої корекції.");
    }
    const base = fast.slice(-30, -14);
    const consolidation = fast.slice(-14, -1);
    const priorMovePercent = (base[base.length - 1].close / base[0].open - 1) * 100;
    const band = pct(maxHigh(consolidation), minLow(consolidation));
    if (Math.abs(priorMovePercent) >= 5 && band <= 2) {
      const upper = maxHigh(consolidation), lower = minLow(consolidation);
      if (priorMovePercent > 0 && prev.close <= upper * (1 + buffer) && last.close > upper * (1 + buffer))
        add(fast, "1m", 1, "Продовження пампу з наторговки", "LONG", "Після імпульсу сформовано 1m діапазон; вихід угору.");
      if (priorMovePercent < 0 && prev.close >= lower * (1 - buffer) && last.close < lower * (1 - buffer))
        add(fast, "1m", 1, "Продовження дампу з наторговки", "SHORT", "Після імпульсу сформовано 1m діапазон; вихід униз.");
    }
    const move = (maxHigh(fast.slice(-45)) / minLow(fast.slice(-45)) - 1) * 100;
    if (move >= 15) {
      for (const side of ["high", "low"] as const) {
        const line = lineBreak(fast.slice(-45), side, settings.minimumTouches, buffer);
        if (line) add(fast, "1m", 1, "Злам трендової після сильного руху", line.direction, "Сильна волатильність 15%+ і підтверджений пробій 1m трендової.");
      }
    }
  }

  return [...new Map(all.map((signal) => [signal.id, signal])).values()].slice(0, 12);
}
