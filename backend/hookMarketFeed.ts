import type { Exchange, Candle, Signal, Settings } from './config';
import { FORMATION_ANALYSIS_VERSION } from './config';
import { MarketData } from './market';
import type { Store } from './store';
import type { ExecutionBook } from './paperModel';

type ExternalFormation = {
  id: string; nameEn: string; confidence: number;
  validation?: { enoughData: boolean; finiteData: boolean };
};
type Coin = {
  symbol: string; exchange: Exchange; marketType: string; timeframe: string;
  formations: ExternalFormation[];
  formationData?: { collectedAt: number; lastClosedAt: number; contiguous: boolean };
};
type Depth = {
  instrument: string; source: string;
  book: { status: string; dataValid: boolean; sequenceGap: boolean;
    lastReceivedAt: number; timestamp: number; bestBid: number; bestAsk: number;
    bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[];
  };
  densities: { side: 'BID'|'ASK'; price: number; notionalUsd: number;
    classification: string; ageSeconds: number; qualityScore?: number }[];
  sampledAt: number;
};
type Feed = { version: number; success: boolean; generatedAt: number;
  snapshots: { key: string; generatedAt: number; data: Coin[] }[];
  density: Depth[];
  market: { quotes: { exchange: Exchange; marketType: string; symbol: string;
    price: number; updatedAt: number | null }[] };
};
const instrument = (exchange: Exchange, symbol: string) => exchange + ':futures:' + symbol;
const finitePrice = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export class HookMarketClient {
  private feed: Feed | null = null;
  private acquiredAt = 0;
  private pending: Promise<Feed> | null = null;
  constructor(private origin: string, private token: string, private fetcher: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)))
      throw new Error('HOOK_MARKET_FEED_URL must be HTTPS or localhost');
    if (url.pathname !== '/' || url.search || url.hash || token.length < 32)
      throw new Error('Invalid hook feed URL or token');
    this.origin = url.origin;
  }
  private async get(path: string) {
    const response = await this.fetcher(this.origin + path, {
      headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) throw new Error('h00k feed unavailable (HTTP ' + response.status + ')');
    return response.json() as Promise<any>;
  }
  async snapshot(force = false): Promise<Feed> {
    if (!force && this.feed && Date.now()-this.acquiredAt < 2000) return this.feed;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const data = await this.get('/api/mon/feed');
      if (data.version !== 1 || data.success !== true ||
        !Array.isArray(data.snapshots) || !Array.isArray(data.density) ||
        !Array.isArray(data.market?.quotes) ||
        !Number.isSafeInteger(data.generatedAt) ||
        Date.now()-data.generatedAt > 15000 || data.generatedAt>Date.now()+2000)
        throw new Error('Invalid or stale h00k feed');
      this.feed = data as Feed;
      this.acquiredAt = Date.now();
      return this.feed;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  invalidate() { this.feed = null; this.acquiredAt = 0; }
  async candles(exchange: Exchange, symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    if (!/^[A-Z0-9]{3,40}$/.test(symbol) || !['1m','5m'].includes(timeframe) ||
      !Number.isInteger(limit) || limit < 30 || limit > 900)
      throw new Error('Unsupported h00k candle request');
    const query = new URLSearchParams({ exchange, symbol, timeframe, limit: String(limit) });
    const raw = await this.get('/api/mon/candles?' + query);
    const tf = timeframe === '1m' ? 60000 : 300000;
    if (raw.version !== 1 || raw.success !== true || raw.exchange !== exchange ||
      raw.symbol !== symbol || raw.timeframe !== timeframe || raw.marketType !== 'futures' ||
      raw.contiguous !== true || !Array.isArray(raw.candles) || raw.candles.length < 30 ||
      raw.candles.length > limit || !Number.isSafeInteger(raw.collectedAt) ||
      Date.now()-raw.collectedAt > 15000 || raw.collectedAt > Date.now()+2000)
      throw new Error('Unverified h00k candles');
    const candles: Candle[] = raw.candles.map((row: any) => ({
      time: Number(row.time)*1000, open: row.open, high: row.high,
      low: row.low, close: row.close, volume: row.volume,
    }));
    if (!candles.every((c,i) => Number.isSafeInteger(c.time) &&
      [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.low > 0 && c.open > 0 && c.close > 0 && c.volume >= 0 &&
      c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close) &&
      c.time + tf <= raw.collectedAt &&
      (!i || c.time - candles[i-1].time === tf)) ||
      raw.lastClosedAt !== candles[candles.length-1].time + tf ||
      raw.collectedAt - raw.lastClosedAt > tf + 15000)
      throw new Error('h00k candles have gaps or invalid exchange values');
    return candles;
  }
  /** Shared fail-closed rule: screening and execution must agree on which books are usable. */
  private isVerifiedBook(item: Depth | undefined, now: number): item is Depth {
    const book = item?.book;
    return Boolean(book && item?.source === 'exchange-websocket' &&
      book.status === 'LIVE' && book.dataValid === true && book.sequenceGap === false &&
      Number.isSafeInteger(book.lastReceivedAt) && Number.isSafeInteger(book.timestamp) &&
      now >= book.lastReceivedAt && now - book.lastReceivedAt <= 5000 &&
      now >= book.timestamp && now - book.timestamp <= 5000 &&
      finitePrice(book.bestBid) && finitePrice(book.bestAsk) && book.bestAsk > book.bestBid &&
      Array.isArray(book.bids) && book.bids.length > 0 &&
      Array.isArray(book.asks) && book.asks.length > 0 &&
      [...book.bids, ...book.asks].every(level =>
        finitePrice(level.price) && finitePrice(level.quantity)));
  }
  /** Only scan formation candidates that currently have genuine synchronized depth.
   * This does not open sockets, add symbols or query the exchange.
   */
  async liveBookSymbols(exchange: Exchange): Promise<Set<string>> {
    const feed = await this.snapshot(true);
    const now = Date.now();
    const prefix = exchange + ':futures:';
    return new Set(feed.density
      .filter(item => item.instrument.startsWith(prefix) &&
        /^[A-Z0-9]{3,40}$/.test(item.instrument.slice(prefix.length)) &&
        this.isVerifiedBook(item, now))
      .map(item => item.instrument.slice(prefix.length)));
  }
  async book(exchange: Exchange, symbol: string): Promise<Depth> {
    const feed = await this.snapshot(true);
    const item = feed.density.find(d => d.instrument === instrument(exchange, symbol));
    if (!this.isVerifiedBook(item, Date.now()))
      throw new Error('No fresh synchronized h00k order book for ' + symbol);
    return item;
  }
  async verifiedDensity(exchange: Exchange, symbol: string, side: 'BID'|'ASK', price: number): Promise<boolean> {
    if (!finitePrice(price)) return false;
    try {
      const item = await this.book(exchange,symbol);
      return item.densities.some(d => d.side === side &&
        finitePrice(d.price) && finitePrice(d.notionalUsd) &&
        Math.abs(d.price-price)/price*100 <= 0.8 &&
        d.classification === 'PERSISTENT_LIQUIDITY' &&
        d.ageSeconds >= 15 && Number(d.qualityScore) >= 45);
    } catch { return false; }
  }
}

export class HookMarketData extends MarketData {
  constructor(settings: () => Settings, public readonly hook: HookMarketClient) { super(settings); }
  override getCandles(exchange: Exchange, symbol: string, timeframe: string,
    limit: number, closedOnly: boolean, endTime?: number): Promise<Candle[]> {
    if (!closedOnly || endTime !== undefined)
      return Promise.reject(new Error('h00k feed supports verified closed recent candles only'));
    return this.hook.candles(exchange,symbol,timeframe,limit);
  }
  override async getExecutionBook(exchange: Exchange, symbol: string): Promise<ExecutionBook> {
    const row = (await this.hook.book(exchange,symbol)).book;
    return { at: row.lastReceivedAt,
      bids: row.bids.map(x=>[x.price,x.quantity] as [number,number]),
      asks: row.asks.map(x=>[x.price,x.quantity] as [number,number]) };
  }
  override async getPrices(exchange: Exchange): Promise<{at:number;data:Record<string,number>}> {
    const feed = await this.hook.snapshot(true);
    const now = Date.now();
    const entries = feed.market.quotes.filter(q => q.exchange === exchange &&
      q.marketType === 'futures' && finitePrice(q.price) &&
      q.updatedAt !== null && q.updatedAt !== undefined &&
      now-q.updatedAt >= 0 && now-q.updatedAt <= 15000);
    if (!entries.length) throw new Error('No fresh h00k market prices');
    return { at: Math.min(...entries.map(q=>q.updatedAt!)),
      data: Object.fromEntries(entries.map(q=>[q.symbol,q.price])) };
  }
}

/** In this mode no market-wide scan runs in mon. The source remains the h00k formation cache. */
export class HookFormationSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private store: Store, private hook: HookMarketClient) {}
  start() {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(()=>void this.sync(),20000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async sync() {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    try {
      const feed = await this.hook.snapshot(true);
      const available = new Map<string,Signal>();
      for (const snapshot of feed.snapshots) {
        if (!Number.isSafeInteger(snapshot.generatedAt) || now-snapshot.generatedAt > 180000 ||
          snapshot.generatedAt>now+2000 || !Array.isArray(snapshot.data)) continue;
        for (const coin of snapshot.data) {
          if (!coin || coin.marketType !== 'futures' ||
            !['binance','bybit'].includes(coin.exchange) ||
            !/^[A-Z0-9]{3,40}$/.test(coin.symbol) ||
            !['1m','5m','15m','1h','4h','1d'].includes(coin.timeframe) ||
            !coin.formationData?.contiguous ||
            !Number.isSafeInteger(coin.formationData.collectedAt) ||
            !Number.isSafeInteger(coin.formationData.lastClosedAt) ||
            now-coin.formationData.collectedAt < 0 ||
            now-coin.formationData.collectedAt > 180000 ||
            coin.formationData.lastClosedAt > coin.formationData.collectedAt ||
            !Array.isArray(coin.formations)) continue;
          for (const formation of coin.formations) {
            if (!formation || typeof formation.id !== 'string' ||
              typeof formation.nameEn !== 'string' ||
              !Number.isFinite(formation.confidence) ||
              formation.confidence < 0 || formation.confidence > 100 ||
              !formation.validation?.enoughData || !formation.validation.finiteData) continue;
            // h00k supplies a symbol universe, never an entry or execution price.
            const key = [coin.exchange,coin.symbol,coin.timeframe,formation.id].join(':');
            available.set(key,{ id: 'hook:' + key, exchange:coin.exchange,
              symbol:coin.symbol,timeframe:coin.timeframe, formation:formation.nameEn,
              direction:'LONG', entryPrice:0,currentPrice:0,stopLoss:0,takeProfit:0,
              confidence:Math.round(formation.confidence),
              analysisVersion:FORMATION_ANALYSIS_VERSION,status:'watching',
              candleAt:coin.formationData.collectedAt,detectedAt:coin.formationData.collectedAt,
              description:'h00k.top: verified formation universe only; Ev-Test must confirm entry' });
          }
        }
      }
      this.store.set('signals',[...available.values()].slice(0,600));
      this.store.set('hook:source',{source:'h00k.top',connected:true,lastSync:Date.now(),total:available.size});
    } catch (error: any) {
      this.hook.invalidate();
      this.store.set('signals',[]);
      this.store.set('builder:edwin:signals',[]);
      this.store.set('hook:source',{source:'h00k.top',connected:false,lastSync:Date.now(),
        error:String(error?.message||'Invalid market feed').slice(0,180)});
    } finally { this.running=false; }
  }
}
