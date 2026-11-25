import { FORMATION_ANALYSIS_VERSION, tfMs, type Exchange, type Settings, type Signal } from "./config";
import { formationIsVisible, signalAllowsEntry } from "./formationState";

export const HOOK_FORMATION_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const MAX_AGE = 120_000;
const REFRESH_MS = 45_000;
type Source = "regular" | "early";
type Key = { exchange: Exchange; symbol: string; timeframe: string };
type Row = { symbol: string; until: number; signal: Signal };
type Snapshot = { rows: Map<string, Row>; checkedAt: number };
const TYPES: Record<string,string> = {
  double_top:"Double Top", double_bottom:"Double Bottom", asc_triangle:"Ascending Triangle",
  desc_triangle:"Descending Triangle", bull_flag:"Bull Flag", bear_flag:"Bear Flag",
  hammer:"Hammer / Bullish Pinbar", shooting_star:"Shooting Star", bull_engulfing:"Bullish Engulfing",
  bear_engulfing:"Bearish Engulfing", level_breakout:"Level Breakout", volatility_squeeze:"Volatility Squeeze",
};
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const score = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const sameSignal = (a: Signal,b: Signal) =>
  a.id === b.id && a.source === b.source && a.sourceFormationId === b.sourceFormationId &&
  a.sourceStatus === b.sourceStatus && a.exchange === b.exchange && a.symbol === b.symbol &&
  a.timeframe === b.timeframe && a.formation === b.formation && a.direction === b.direction &&
  a.status === b.status && a.confidence === b.confidence && a.entryPrice === b.entryPrice &&
  a.stopLoss === b.stopLoss && a.takeProfit === b.takeProfit && a.candleAt === b.candleAt;
const scope = (exchange: Exchange, timeframe: string, source: Source) => [exchange, timeframe, source].join(":");
const enabled = (settings: Settings, source: Source) => source === "regular" ? settings.hookRegularFormations !== false : settings.hookEarlyFormations === true;
const fresh = (at: unknown, now: number): at is number => typeof at === "number" && Number.isFinite(at) && at <= now + 2000 && now - at <= MAX_AGE;

/** Do not infer eligibility from a ticker, a spot pair, or an unformed result. */
export function readHookCandidates(data: unknown, exchange: Exchange, timeframe: string, source: Source, now = Date.now()): Row[] {
  if (!Array.isArray(data)) throw new Error("Некоректний список формацій h00k");
  const rows: Row[] = [];
  for (const coin of data) {
    if (!coin || coin.exchange !== exchange || coin.marketType !== "futures" || coin.timeframe !== timeframe ||
        coin.quoteAsset !== "USDT" || typeof coin.symbol !== "string" || !/^[A-Z0-9]{1,30}USDT$/.test(coin.symbol) ||
        !fresh(coin.lastUpdated, now) || !Number.isFinite(coin.currentPrice) || coin.currentPrice <= 0) continue;
    const proof = coin.formationData;
    const interval = tfMs(timeframe);
    if (!interval || proof?.contiguous !== true || !fresh(proof.collectedAt, now) ||
        proof.collectedAt > coin.lastUpdated || !Number.isSafeInteger(proof.lastClosedAt) ||
        proof.lastClosedAt <= 0 || proof.lastClosedAt > proof.collectedAt ||
        proof.lastClosedAt % interval !== 0 || now - proof.lastClosedAt > interval + 90_000) continue;
    const patterns = source === "regular" ? coin.formations : coin.earlyFormations;
    if (!Array.isArray(patterns)) continue;
    for (const pattern of patterns) {
      if (!pattern || typeof pattern.id !== "string" || !pattern.id || pattern.id.length > 300 ||
          pattern.source === "screener_24h_preview" ||
          !Object.hasOwn(TYPES,pattern.patternKey) ||
          (pattern.bias !== "bullish" && pattern.bias !== "bearish")) continue;
      const early = source === "early";
      const v = pattern.validation;
      const direction = pattern.bias === "bullish" ? "LONG" : "SHORT";
      const sourceStatus = early ? pattern.stage : pattern.status;
      if (early ? !["forming","potential"].includes(sourceStatus) :
        !["forming","ready_to_break","breakout","retest"].includes(sourceStatus) ||
        v?.enoughData !== true || v?.finiteData !== true || v?.closedCandleOnly !== true || v?.lookAheadSafe !== true) continue;
      // Match the site's displayed "Вхід підтверджено" (validation.passed), not just a breakout label.
      const confirmed = !early && ["breakout","retest"].includes(sourceStatus) &&
        v.passed === true && v.confirmed === true && v.breakoutConfirmed === true &&
        ["BREAKOUT","RETEST"].includes(v.entryMode);
      const entryPrice = early ? pattern.breakoutEntry : pattern.levels?.entryPrice;
      const stopLoss = early ? pattern.breakoutStopLoss : pattern.levels?.stopLossPrice;
      const takeProfit = early ? pattern.target : pattern.levels?.targetPrice;
      if (!positive(entryPrice) || !positive(stopLoss) || !positive(takeProfit) ||
          (direction === "LONG" ? !(stopLoss < entryPrice && entryPrice < takeProfit) : !(takeProfit < entryPrice && entryPrice < stopLoss))) continue;
      const rawScore = v?.confluence?.total ?? pattern.confidence;
      if (!early && !score(rawScore)) continue;
      const detectedAt = early ? pattern.observedAt : pattern.detectedAt;
      if (!positive(detectedAt) || detectedAt > now + 2000) continue;
      const decisionAt = confirmed ? (sourceStatus === "retest" ? v.regularPlan?.retestClosedAt : v.regularPlan?.breakoutClosedAt) : proof.lastClosedAt;
      if (!positive(decisionAt) || decisionAt > proof.lastClosedAt || decisionAt % interval !== 0) continue;
      const signal: Signal = {
        id: JSON.stringify([source, exchange, coin.symbol, timeframe, pattern.id]),
        source: early ? "hook_early" : "hook_regular", sourceFormationId: pattern.id, sourceStatus,
        exchange, symbol:coin.symbol, timeframe, formation:TYPES[pattern.patternKey], direction,
        entryPrice, stopLoss, takeProfit, currentPrice:coin.currentPrice,
        confidence: early ? 0 : rawScore, analysisVersion:FORMATION_ANALYSIS_VERSION,
        status: confirmed ? "confirmed" : "watching", candleAt:decisionAt, detectedAt,
        description: String(early ? pattern.explanation ?? "" : pattern.description ?? "").slice(0,1000),
      };
      rows.push({symbol:coin.symbol,signal,until:Math.min(coin.lastUpdated+MAX_AGE,proof.collectedAt+MAX_AGE,proof.lastClosedAt+interval+90_000)});
    }
  }
  return rows;
}

export class HookFormationSources {
  private snapshots = new Map<string, Snapshot>();
  private jobs = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private generation = 0;
  invalidate() {
    this.generation++;
    this.snapshots.clear();
    this.jobs.clear();
    this.errors.clear();
  }
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetcher(new URL(path, "https://h00k.top"), {
      ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error("h00k HTTP " + response.status);
    const body = await response.json();
    if (body?.success !== true) throw new Error("Некоректна відповідь h00k");
    return body;
  }
  private refreshScope(exchange: Exchange, timeframe: string, source: Source) {
    const key = scope(exchange, timeframe, source);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const cached = this.snapshots.get(key);
    if (cached && this.now() - cached.checkedAt < REFRESH_MS) return Promise.resolve();
    const generation = this.generation;
    const job = (async () => {
      try {
        let data: unknown;
        if (source === "regular") {
          const query = new URLSearchParams({exchange, timeframe, marketType:"futures", minVolume:"0"});
          data = (await this.request("/api/screener/scan?" + query)).data;
        } else {
          const params = { exchange, marketType:"futures", timeframe, minVolumeUsd:0 };
          const { scan } = await this.request("/api/screener/early/start", {
            method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(params),
          });
          if (!scan || scan.params?.exchange !== exchange || scan.params?.marketType !== "futures" ||
              scan.params?.timeframe !== timeframe || !["running","completed"].includes(scan.status) ||
              !Array.isArray(scan.missingSources) || scan.missingSources.length || scan.failed > 0)
            throw new Error("Ранній пошук ще не готовий або неповний");
          data = scan.data;
        }
        if (generation !== this.generation) return;
        const now = this.now();
        this.snapshots.set(key, {rows:new Map(readHookCandidates(data,exchange,timeframe,source,now).map(r=>[r.signal.id,r])),checkedAt:now});
        this.errors.delete(key);
      } catch (error) {
        // Never keep a last-good allowlist after a failed refresh.
        if (generation !== this.generation) return;
        this.snapshots.delete(key);
        this.errors.set(key, error instanceof Error ? error.message : "Джерело недоступне");
      }
    })().finally(()=>{ if (generation === this.generation) this.jobs.delete(key); });
    this.jobs.set(key,job);
    return job;
  }
  async refresh(settings: Settings) {
    const tasks: Promise<void>[] = [];
    for (const tf of settings.timeframes) {
      if (!(HOOK_FORMATION_TIMEFRAMES as readonly string[]).includes(tf)) continue;
      for (const source of ["regular","early"] as const) if (enabled(settings,source))
        tasks.push(this.refreshScope(settings.exchange,tf,source));
    }
    await Promise.all(tasks);
  }
  private activeRows(settings: Settings, source: Source): Row[] {
    if (!enabled(settings,source)) return [];
    const now=this.now();
    return settings.timeframes.flatMap(tf=>{
      const snapshot=this.snapshots.get(scope(settings.exchange,tf,source));
      if (!snapshot || now < snapshot.checkedAt || now-snapshot.checkedAt >= REFRESH_MS) return [];
      return [...snapshot.rows.values()].filter(row=>row.until>now);
    });
  }
  has(key: Key, settings: Settings, source: Source) {
    return this.activeRows(settings,source).some(r=>r.signal.exchange===key.exchange && r.symbol===key.symbol && r.signal.timeframe===key.timeframe);
  }
  allows(key: Key, settings: Settings) { return this.has(key,settings,"regular") || this.has(key,settings,"early"); }
  signals(settings: Settings) {
    return (["regular","early"] as const).flatMap(source=>this.activeRows(settings,source).map(row=>row.signal))
      .filter(signal=>formationIsVisible(signal,settings,this.now()));
  }
  allowsEntry(signal: Signal, settings: Settings) {
    // Early candidates have no confirmed entry or calibrated score on h00k. Never manufacture either.
    if (signal.source !== "hook_regular" || !signalAllowsEntry(signal,settings,this.now())) return false;
    return this.activeRows(settings,"regular").some(row=>sameSignal(signal,row.signal));
  }
  diagnostics() { return Object.fromEntries(this.errors); }
  counts(settings: Settings) {
    return Object.fromEntries((["regular","early"] as const).map(source=>[source,new Set(this.activeRows(settings,source).map(r=>r.symbol)).size]));
  }
}
