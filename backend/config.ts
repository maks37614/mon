import { DEFAULT_TRADING_SCHEDULE, validateTradingSchedule } from "./tradingSchedule";

export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export const FORMATION_ANALYSIS_VERSION = 2;
export const FORMATIONS = [
  "Double Top",
  "Double Bottom",
  "H&S",
  "Inverse H&S",
  "Ascending Triangle",
  "Descending Triangle",
  "Symmetric Triangle",
  "Rising Wedge",
  "Falling Wedge",
  "Bull Flag",
  "Bear Flag",
];
export type Exchange = "binance" | "bybit";
export type Mode = "paper" | "live";
export type Settings = typeof DEFAULT_SETTINGS;
export const DEFAULT_SETTINGS = {
  exchange: "binance" as Exchange,
  mode: "paper" as Mode,
  timeframes: ["1m"] as string[],
  formationTypes: [...FORMATIONS],
  candleLimit: 300,
  scanBatchSize: 200,
  requestsPerSecond: 4,
  scanIntervalSeconds: 60,
  entryIntervalSeconds: 60,
  entryCooldownSeconds: 900,
  maxHoldingSeconds: 300,
  maxSignalAgeSeconds: 180,
  minScore: 75,
  confirmedOnly: true,
  autoEntries: false,
  reverseEnabled: false,
  tradingSchedule: structuredClone(DEFAULT_TRADING_SCHEDULE),
  maxPositions: 5,
  initialBalance: 1000,
  orderNotionalUsdt: 25,
  leverage: 1,
  takeProfitPercent: 0.45,
  stopLossPercent: 0.25,
  slippageTolerancePercent: 0.2,
  takerFeePercent: 0.06,
};
export const tfMs = (tf: string) =>
  ({
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  })[tf] || 0;

export function validateSettings(input: unknown, previous: Settings): Settings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Некоректні налаштування");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !Object.hasOwn(DEFAULT_SETTINGS, k)))
    throw new Error("Невідомий параметр");
  const s = { ...DEFAULT_SETTINGS, ...previous, ...raw } as Settings;
  if (
    !["binance", "bybit"].includes(s.exchange) ||
    !["paper", "live"].includes(s.mode)
  )
    throw new Error("Невідома біржа або режим");
  if (
    !Array.isArray(s.timeframes) ||
    !s.timeframes.length ||
    s.timeframes.some((t) => !(TIMEFRAMES as readonly string[]).includes(t))
  )
    throw new Error("Оберіть підтримувані таймфрейми");
  if (
    !Array.isArray(s.formationTypes) ||
    !s.formationTypes.length ||
    s.formationTypes.some((t) => !FORMATIONS.includes(t))
  )
    throw new Error("Оберіть типи формацій");
  s.timeframes = [...new Set(s.timeframes)];
  s.formationTypes = [...new Set(s.formationTypes)];
  const ranges: Record<string, [number, number, boolean?]> = {
    candleLimit: [100, 1000, true],
    scanBatchSize: [10, 1000, true],
    requestsPerSecond: [1, 8, true],
    scanIntervalSeconds: [60, 86400, true],
    entryIntervalSeconds: [5, 86400, true],
    entryCooldownSeconds: [0, 86400, true],
    maxHoldingSeconds: [0, 604800, true],
    maxSignalAgeSeconds: [30, 86400, true],
    minScore: [50, 100, true],
    maxPositions: [1, 20, true],
    initialBalance: [10, 1e7],
    orderNotionalUsdt: [5, 100_000],
    leverage: [1, 20, true],
    takeProfitPercent: [0.05, 50],
    stopLossPercent: [0.05, 25],
    slippageTolerancePercent: [0.01, 5],
    takerFeePercent: [0, 1],
  };
  for (const [k, [min, max, integer]] of Object.entries(ranges)) {
    const n = raw[k] ?? s[k as keyof Settings];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    )
      throw new Error(`Параметр ${k}: дозволено ${min}–${max}`);
  }
  for (const k of ["confirmedOnly", "autoEntries", "reverseEnabled"])
    if (typeof s[k as keyof Settings] !== "boolean")
      throw new Error(`Параметр ${k} має бути логічним`);
  s.tradingSchedule = validateTradingSchedule(s.tradingSchedule);
  return s;
}

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Market = {
  symbol: string;
  base: string;
  quantityStep: number;
  minQuantity: number;
  minNotional: number;
  tickSize: number;
};
export type Signal = {
  id: string;
  exchange: Exchange;
  symbol: string;
  timeframe: string;
  formation: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  analysisVersion?: number;
  scoreParts?: { structure: number; breakout: number; volume: number };
  status: "confirmed" | "watching";
  candleAt: number;
  detectedAt: number;
  description: string;
};
