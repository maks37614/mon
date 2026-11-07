/** Read-only, strictly bounded h00k.top selection. Binance market data never goes through h00k. */
const H00K_QUOTES_URL = "https://h00k.top/api/market/quotes?exchange=binance&marketType=futures&minVolume=2000000";
const SYMBOL = /^[A-Z0-9]{3,30}USDT$/;
export const AUTO_MAX_COINS = 10;
export const AUTO_REFRESH_MS = 300_000;

export function parseSiteCoins(payload: unknown, now = Date.now()): string[] {
  if (!payload || typeof payload !== "object") throw new Error("h00k: порожня відповідь");
  const row = payload as Record<string, any>;
  if (row.success !== true || row.partial === true ||
    !Array.isArray(row.sources) || !Array.isArray(row.data)) {
    throw new Error("h00k: неповні або недоступні ринкові дані");
  }
  const sources = row.sources.filter((s: any) =>
    s?.exchange === "binance" && s?.marketType === "futures");
  const source = sources[0];
  if (sources.length !== 1 || source.status !== "live" ||
    !Number.isFinite(source.updatedAt) ||
    source.updatedAt > now + 2_000 || now - source.updatedAt > 60_000) {
    throw new Error("h00k: Binance Futures не має свіжих котирувань");
  }
  const selected = new Map<string, { symbol: string; volatility: number; volume: number }>();
  for (const coin of row.data) {
    if (coin?.exchange !== "binance" || coin.marketType !== "futures" ||
      coin.quoteAsset !== "USDT" || coin.isActiveCoin !== true ||
      typeof coin.symbol !== "string" || !SYMBOL.test(coin.symbol) ||
      !Number.isFinite(coin.price) || coin.price <= 0 ||
      !Number.isFinite(coin.volumeUsd) || coin.volumeUsd < 2_000_000 ||
      !Number.isFinite(coin.volatility24hPct) || coin.volatility24hPct < 4) continue;
    const next = { symbol: coin.symbol, volatility: coin.volatility24hPct, volume: coin.volumeUsd };
    const previous = selected.get(next.symbol);
    if (!previous || next.volume > previous.volume) selected.set(next.symbol, next);
  }
  return [...selected.values()]
    .sort((a,b) => b.volatility - a.volatility || b.volume - a.volume || a.symbol.localeCompare(b.symbol))
    .slice(0, AUTO_MAX_COINS).map(coin => coin.symbol);
}

/** One site GET per five minutes at most, with failure-closed entry authorization. */
export class SiteUniverse {
  private symbols: string[] = [];
  private lastAttempt = 0;
  private lastSuccess = 0;
  private error: string | null = null;
  private pending: Promise<string[]> | null = null;
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}

  status() {
    return {
      provider: "h00k.top",
      source: "binance:futures",
      selected: [...this.symbols],
      lastAttempt: this.lastAttempt || null,
      lastSuccess: this.lastSuccess || null,
      refreshMs: AUTO_REFRESH_MS,
      fresh: this.lastSuccess > 0 && this.now() - this.lastSuccess <= AUTO_REFRESH_MS + 60_000 && !this.error,
      error: this.error,
    };
  }
  allows(symbol: string): boolean {
    return this.status().fresh && this.symbols.includes(symbol);
  }
  async current(): Promise<string[]> {
    if (this.pending) return this.pending;
    if (this.lastAttempt && this.now() - this.lastAttempt < AUTO_REFRESH_MS) {
      if (!this.status().fresh) throw new Error(this.error || "h00k: список недоступний");
      return [...this.symbols];
    }
    this.lastAttempt = this.now();
    this.pending = (async () => {
      try {
        const response = await this.fetcher(H00K_QUOTES_URL, {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error("h00k: HTTP " + response.status);
        const symbols = parseSiteCoins(await response.json(), this.now());
        if (symbols.length === 0) throw new Error("h00k: немає відповідних активних монет");
        this.symbols = symbols;
        this.lastSuccess = this.now();
        this.error = null;
        return [...symbols];
      } catch (e: any) {
        this.symbols = [];
        this.lastSuccess = 0;
        this.error = String(e.message || e).slice(0,180);
        throw new Error(this.error!);
      }
    })();
    try { return await this.pending; }
    finally { this.pending = null; }
  }
}
