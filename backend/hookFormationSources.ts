import { FORMATION_ANALYSIS_VERSION, tfMs, type Exchange, type Settings, type Signal } from "./config";
import { formationIsVisible, signalAllowsEntry } from "./formationState";

export const HOOK_FORMATION_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const MAX_AGE = 120_000;
const REFRESH_MS = 45_000;
const POLL_MS = 30_000;
type Source = "regular" | "early";
type Key = { exchange: Exchange; symbol: string; timeframe: string };
type Row = { symbol: string; until: number; signal: Signal; blocked: boolean; blockReasons: string[] };
type Snapshot = { rows: Map<string, Row>; checkedAt: number; receivedCoins: number; receivedPatterns: number; responseMs: number };
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
const scope = (exchange: Exchange, timeframe: string, source: Source, minVolumeUsd: number) => [exchange, timeframe, source, minVolumeUsd].join(":");
const enabled = (settings: Settings, source: Source) => source === "regular" ? settings.hookRegularFormations !== false : settings.hookEarlyFormations === true;
const fresh = (at: unknown, now: number): at is number => typeof at === "number" && Number.isFinite(at) && at <= now + 2000 && now - at <= MAX_AGE;

/** Do not infer eligibility from a ticker, a spot pair, or an unformed result. */
export function readHookCandidates(data: unknown, exchange: Exchange, timeframe: string, source: Source, now = Date.now(), minVolumeUsd = 0): Row[] {
  if (!Array.isArray(data)) throw new Error("Некоректний список формацій h00k");
  const rows: Row[] = [];
  for (const coin of data) {
    if (!coin || coin.exchange !== exchange || coin.marketType !== "futures" || coin.timeframe !== timeframe ||
        coin.quoteAsset !== "USDT" || typeof coin.symbol !== "string" || !/^[A-Z0-9]{1,30}USDT$/.test(coin.symbol) ||
        !fresh(coin.lastUpdated, now) || !Number.isFinite(coin.currentPrice) || coin.currentPrice <= 0 ||
        (minVolumeUsd > 0 && (!Number.isFinite(coin.volume24hUsd) || coin.volume24hUsd < minVolumeUsd))) continue;
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
        v.entryMode === (sourceStatus === "retest" ? "RETEST" : "BREAKOUT");
      const entryPrice = early ? pattern.breakoutEntry : pattern.levels?.entryPrice;
      const stopLoss = early ? pattern.breakoutStopLoss : pattern.levels?.stopLossPrice;
      const takeProfit = early ? pattern.target : pattern.levels?.targetPrice;
      if (!positive(entryPrice) || !positive(stopLoss) || !positive(takeProfit) ||
          (direction === "LONG" ? !(stopLoss < entryPrice && entryPrice < takeProfit) : !(takeProfit < entryPrice && entryPrice < stopLoss))) continue;
      const rawScore = v?.confluence?.total ?? pattern.confidence;
      if (!early && !score(rawScore)) continue;
      const rawDetectedAt = early ? pattern.observedAt : pattern.detectedAt;
      // Early candidate observedAt comes from Kline.time (epoch seconds); regular IDs use milliseconds.
      if (!positive(rawDetectedAt)) continue;
      const detectedAt = early && rawDetectedAt < 10_000_000_000 ? rawDetectedAt*1000 : rawDetectedAt;
      if (!Number.isSafeInteger(detectedAt) || detectedAt > now + 2000) continue;
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
      // Turning off confirmed-only is not permission to revive invalidated plans.
      const plan = v?.regularPlan;
      const invalidated = Array.isArray(plan?.afterEntry) && plan.afterEntry.some((bar: unknown) =>
        !Array.isArray(bar) || bar.length !== 2 || !positive(bar[0]) || !positive(bar[1]) || bar[0] < bar[1] ||
        (direction === "LONG" ? bar[1] <= stopLoss || bar[0] >= takeProfit : bar[0] >= stopLoss || bar[1] <= takeProfit));
      const blockReasons:string[]=[];
      if(early) blockReasons.push("Рання формація — лише спостереження");
      if(invalidated) blockReasons.push("Після сигналу досягнуто стоп або ціль, чи дані свічок некоректні");
      if(plan?.entryExpired===true) blockReasons.push("Торговий план h00k прострочено");
      if(v?.breakoutConfirmed===true && plan?.structureActive===false) blockReasons.push("Пробитий рівень втрачено");
      if(v?.entryMode==="WAIT_RETEST") blockReasons.push("Очікування ретесту h00k");
      if(v?.confluence?.flow?.entryBlockedByFlow===true) blockReasons.push("Потік угод блокує вхід");
      if(!isInsideHookPlan(signal,coin.currentPrice)) blockReasons.push("Поточна ціна поза планом h00k");
      const blocked=blockReasons.length>0;
      rows.push({symbol:coin.symbol,signal,blocked,blockReasons,until:Math.min(coin.lastUpdated+MAX_AGE,proof.collectedAt+MAX_AGE,proof.lastClosedAt+interval+90_000)});
    }
  }
  return rows;
}

export function isInsideHookPlan(signal: Signal, price: number) {
  return positive(price) && (signal.direction === "LONG"
    ? price > signal.stopLoss && price < signal.takeProfit
    : price < signal.stopLoss && price > signal.takeProfit);
}

export class HookFormationSources {
  private snapshots = new Map<string, Snapshot>();
  private jobs = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private generation = 0;
  private retryAt = new Map<string, number>();
  private earlyJobs = new Map<string,string>();
  invalidate() {
    this.generation++;
    this.snapshots.clear();
    this.jobs.clear();
    this.errors.clear();
    this.retryAt.clear();
    this.earlyJobs.clear();
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
  private refreshScope(exchange: Exchange, timeframe: string, source: Source, minVolumeUsd:number) {
    const key = scope(exchange, timeframe, source, minVolumeUsd);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    if (this.now() < (this.retryAt.get(key) ?? 0)) return Promise.resolve();
    const cached = this.snapshots.get(key);
    if (cached && this.now() >= cached.checkedAt && this.now() - cached.checkedAt < POLL_MS) return Promise.resolve();
    const generation = this.generation;
    const job = (async () => {
      try {
        const started=this.now();
        let data: unknown;
        if (source === "regular") {
          const query = new URLSearchParams({exchange, timeframe, marketType:"futures", minVolume:String(minVolumeUsd)});
          const body=await this.request("/api/screener/scan?" + query);
          data=body.data;
          if (body.count!==undefined && (!Array.isArray(data) || body.count!==data.length))
            throw new Error("Неповна відповідь звичайних формацій h00k");
        } else {
          const params = { exchange, marketType:"futures", timeframe, minVolumeUsd };
          const known=this.earlyJobs.get(key);
          const {scan}=known
            ? await this.request("/api/screener/early/status?"+new URLSearchParams({id:known}))
            : await this.request("/api/screener/early/start", {
                method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(params),
              });
          if (generation!==this.generation) return;
          if (!scan || scan.params?.exchange !== exchange || scan.params?.marketType !== "futures" ||
              scan.params?.timeframe !== timeframe ||
              (scan.params.minVolumeUsd!==undefined && scan.params.minVolumeUsd!==minVolumeUsd) ||
              (known && scan.id!==known) || !["running","completed"].includes(scan.status) ||
              !Array.isArray(scan.missingSources) || scan.missingSources.length || scan.failed > 0)
            throw new Error("Ранній пошук ще не готовий або неповний");
          if (scan.status==="running" && typeof scan.id==="string" && /^[a-f0-9-]{36}$/i.test(scan.id))
            this.earlyJobs.set(key,scan.id);
          else this.earlyJobs.delete(key); // A completed job is refreshed through the normal shared cache.
          data = scan.data;
        }
        if (generation !== this.generation) return;
        const now = this.now();
        const candidates=readHookCandidates(data,exchange,timeframe,source,now,minVolumeUsd);
        const rows=new Map<string,Row>(), conflicting=new Set<string>();
        for(const row of candidates) {
          const id=row.signal.id, previous=rows.get(id);
          if (previous && (!sameSignal(previous.signal,row.signal) || previous.blocked!==row.blocked)) {
            conflicting.add(id); rows.delete(id);
          } else if (!conflicting.has(id)) {
            rows.set(id,previous ? {...row,until:Math.min(previous.until,row.until)} : row);
          }
        }
        if (conflicting.size) throw new Error("Суперечливі дублікати формацій h00k");
        const list=data as any[];
        const receivedPatterns=list.reduce((sum,coin)=>{
          const patterns=source==="regular"?coin?.formations:coin?.earlyFormations;
          return sum+(Array.isArray(patterns)?patterns.length:0);
        },0);
        this.snapshots.set(key, {rows,checkedAt:now,receivedCoins:list.length,receivedPatterns,responseMs:Math.max(0,now-started)});
        // Bound the number of snapshots even when callers change filters without invalidating.
        while (this.snapshots.size>24) this.snapshots.delete(this.snapshots.keys().next().value!);
        this.errors.delete(key);
        this.retryAt.delete(key);
      } catch (error) {
        // Never keep a last-good allowlist after a failed refresh.
        if (generation !== this.generation) return;
        this.snapshots.delete(key);
        this.earlyJobs.delete(key);
        this.retryAt.set(key,this.now()+15_000);
        this.errors.set(key, error instanceof Error ? (error.name==="TimeoutError" || error.name==="AbortError" ? "Час очікування API h00k вичерпано" : error.message.slice(0,200)) : "Джерело недоступне");
        while (this.errors.size>24) this.errors.delete(this.errors.keys().next().value!);
        while (this.retryAt.size>24) this.retryAt.delete(this.retryAt.keys().next().value!);
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
        tasks.push(this.refreshScope(settings.exchange,tf,source,settings.hookMinVolumeUsd ?? 0));
    }
    await Promise.all(tasks);
  }
  private activeRows(settings: Settings, source: Source): Row[] {
    if (!enabled(settings,source)) return [];
    const now=this.now();
    return settings.timeframes.flatMap(tf=>{
      const snapshot=this.snapshots.get(scope(settings.exchange,tf,source,settings.hookMinVolumeUsd ?? 0));
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
    return this.activeRows(settings,"regular").some(row=>!row.blocked && sameSignal(signal,row.signal));
  }
  entryReasons(signal:Signal,settings:Settings):string[] {
    if(signal.source==="hook_early") return ["Рання формація — лише спостереження"];
    if(signal.source!=="hook_regular") return ["Невідоме джерело формації"];
    const row=this.activeRows(settings,"regular").find(r=>sameSignal(signal,r.signal));
    if(!row) return ["Формація h00k більше не актуальна"];
    const reasons=[...row.blockReasons];
    if(settings.confirmedOnly && signal.status!=="confirmed") reasons.push("Вхід h00k ще не підтверджено");
    if(this.now()-signal.candleAt>settings.maxSignalAgeSeconds*1000) reasons.push("Перевищено максимальний вік сигналу");
    if(!signalAllowsEntry(signal,settings,this.now()) && !reasons.length) reasons.push("Не відповідає фільтрам входу");
    return reasons;
  }
  diagnostics(settings?:Settings) { if(!settings) return Object.fromEntries(this.errors); const keys=new Set(settings.timeframes.flatMap(tf=>(["regular","early"] as const).filter(source=>enabled(settings,source)).map(source=>scope(settings.exchange,tf,source,settings.hookMinVolumeUsd??0)))); return Object.fromEntries([...this.errors].filter(([key])=>keys.has(key))); }
  coverage(settings:Settings) {
    const now=this.now();
    return settings.timeframes.flatMap(timeframe=>(["regular","early"] as const).filter(source=>enabled(settings,source)).map(source=>{
      const key=scope(settings.exchange,timeframe,source,settings.hookMinVolumeUsd ?? 0), snapshot=this.snapshots.get(key);
      const supported=(HOOK_FORMATION_TIMEFRAMES as readonly string[]).includes(timeframe);
      const active=!!snapshot && now>=snapshot.checkedAt && now-snapshot.checkedAt<REFRESH_MS;
      const rows=active?[...snapshot!.rows.values()].filter(row=>row.until>now):[];
      return {key,timeframe,source,supported,checkedAt:snapshot?.checkedAt??null,responseMs:snapshot?.responseMs??null,
        refreshing:this.jobs.has(key),fresh:active,receivedCoins:snapshot?.receivedCoins??null,
        receivedPatterns:snapshot?.receivedPatterns??null,validPatterns:rows.length,
        visiblePatterns:rows.filter(row=>formationIsVisible(row.signal,settings,now)).length,
        eligiblePatterns:rows.filter(row=>!row.blocked && signalAllowsEntry(row.signal,settings,now)).length,
        error:supported?this.errors.get(key)??null:"Таймфрейм не підтримується джерелом h00k"};
    }));
  }
  counts(settings: Settings) {
    return Object.fromEntries((["regular","early"] as const).map(source=>[source,new Set(this.activeRows(settings,source).map(r=>r.symbol)).size]));
  }
}
