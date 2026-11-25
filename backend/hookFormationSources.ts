import type { Exchange, Settings, Signal } from "./config";

export const HOOK_FORMATION_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const MAX_AGE = 120_000;
type Source = "regular" | "early";
type Key = { exchange: Exchange; symbol: string; timeframe: string };
type Row = { symbol: string; until: number };
type Snapshot = { rows: Map<string, number>; checkedAt: number };
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
    const patterns = source === "regular" ? coin.formations : coin.earlyFormations;
    if (!Array.isArray(patterns) || !patterns.some((p: any) => p && typeof p.id === "string" && p.id.length > 0 &&
        p.source !== "screener_24h_preview" &&
        (p.bias === "bullish" || p.bias === "bearish") &&
        (source === "regular" ? p.validation?.enoughData === true && p.validation?.finiteData === true
          : p.stage === "forming" || p.stage === "potential"))) continue;
    rows.push({ symbol: coin.symbol, until: coin.lastUpdated + MAX_AGE });
  }
  return rows;
}

export class HookFormationSources {
  private snapshots = new Map<string, Snapshot>();
  private jobs = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
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
    if (cached && this.now() - cached.checkedAt < 45_000) return Promise.resolve();
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
        const now = this.now();
        this.snapshots.set(key, {rows:new Map(readHookCandidates(data,exchange,timeframe,source,now).map(r=>[r.symbol,r.until])),checkedAt:now});
        this.errors.delete(key);
      } catch (error) {
        // Never keep a last-good allowlist after a failed refresh.
        this.snapshots.delete(key);
        this.errors.set(key, error instanceof Error ? error.message : "Джерело недоступне");
      }
    })().finally(()=>this.jobs.delete(key));
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
  has(key: Key, settings: Settings, source: Source) {
    if (!enabled(settings,source) || key.exchange !== settings.exchange || !settings.timeframes.includes(key.timeframe)) return false;
    const snapshot = this.snapshots.get(scope(key.exchange,key.timeframe,source));
    const now = this.now();
    return !!snapshot && fresh(snapshot.checkedAt,now) && (snapshot.rows.get(key.symbol) ?? 0) > now;
  }
  allows(key: Key, settings: Settings) { return this.has(key,settings,"regular") || this.has(key,settings,"early"); }
  allowsEntry(signal: Signal, settings: Settings) {
    return this.has(signal,settings,"regular") || (signal.status === "confirmed" && this.has(signal,settings,"early"));
  }
  diagnostics() { return Object.fromEntries(this.errors); }
}
