import { Mutex } from "./store";
import { validTiers, type RiskTier, type ExecutionBook, type ContractState, type FundingEvent } from "./paperModel";
import {
  tfMs,
  type Exchange,
  type Market,
  type Candle,
  type Settings,
} from "./config";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class MarketData {
  private pacing = new Mutex();
  private nextRequest = 0;
  private blocked = new Map<Exchange, number>();
  private markets = new Map<Exchange, { expires: number; data: Market[] }>();
  private prices = new Map<
    Exchange,
    { at: number; data: Record<string, number> }
  >();
  private cache = new Map<string, { expires: number; data: Candle[] }>();
  private inflight = new Map<string, Promise<any>>();
  constructor(
    private settings: () => Settings,
    private fetcher: typeof fetch = fetch,
    private weightBudget = 1000,
  ) {}
  status() {
    return Object.fromEntries(this.blocked);
  }
  private async request(
    exchange: Exchange,
    pathname: string,
    query: Record<string, string | number> = {},
  ) {
    const blockedUntil = this.blocked.get(exchange) || 0;
    if (blockedUntil > Date.now())
      throw new Error(
        `API ${exchange}: пауза до ${new Date(blockedUntil).toISOString()}`,
      );
    await this.pacing.run(async () => {
      await delay(Math.max(0, this.nextRequest - Date.now()));
      this.nextRequest = Date.now() + 1000 / this.settings().requestsPerSecond;
    });
    if ((this.blocked.get(exchange) || 0) > Date.now())
      throw new Error("API тимчасово призупинено через ліміт запитів");
    const base =
      exchange === "binance"
        ? "https://fapi.binance.com"
        : "https://api.bybit.com";
    const url = new URL(pathname, base);
    for (const [k, v] of Object.entries(query))
      url.searchParams.set(k, String(v));
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (
      exchange === "binance" &&
      Number(response.headers.get("x-mbx-used-weight-1m") || 0) >=
        this.weightBudget
    )
      this.blocked.set(
        exchange,
        Math.ceil(Date.now() / 60_000) * 60_000 + 1000,
      );
    if ([418, 429].includes(response.status)) {
      const retry = Number(response.headers.get("retry-after")) || 60;
      this.blocked.set(
        exchange,
        Date.now() + Math.max(60, Math.min(retry, 86400)) * 1000,
      );
      throw new Error(
        `API ${exchange}: ліміт запитів, HTTP ${response.status}`,
      );
    }
    if (!response.ok)
      throw new Error(`API ${exchange}: HTTP ${response.status}`);
    const data = await response.json();
    if (exchange === "bybit" && data.retCode !== 0) {
      if ([10006, 10018].includes(data.retCode))
        this.blocked.set(exchange, Date.now() + 60_000);
      throw new Error(`API Bybit: код ${data.retCode}`);
    }
    return data;
  }
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.inflight.has(key)) return this.inflight.get(key)!;
    const promise = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  getMarkets(exchange: Exchange): Promise<Market[]> {
    const cached = this.markets.get(exchange);
    if (cached && cached.expires > Date.now())
      return Promise.resolve(cached.data);
    return this.once(`markets:${exchange}`, async () => {
      const result: Market[] = [];
      if (exchange === "binance") {
        const data = await this.request(exchange, "/fapi/v1/exchangeInfo");
        for (const m of data.symbols || []) {
          if (
            m.status !== "TRADING" ||
            m.contractType !== "PERPETUAL" ||
            m.quoteAsset !== "USDT" ||
            m.marginAsset !== "USDT"
          )
            continue;
          const lot = m.filters.find((x: any) => x.filterType === "MARKET_LOT_SIZE") || m.filters.find((x: any) => x.filterType === "LOT_SIZE");
          const price = m.filters.find(
            (x: any) => x.filterType === "PRICE_FILTER",
          );
          const notional = m.filters.find(
            (x: any) => x.filterType === "MIN_NOTIONAL",
          );
          result.push({
            symbol: m.symbol,
            base: m.baseAsset,
            quantityStep: Number(lot?.stepSize),
            minQuantity: Number(lot?.minQty),
            minNotional: Number(notional?.notional || 5),
            tickSize: Number(price?.tickSize),
            maxQuantity: Number(lot?.maxQty),
          });
        }
      } else {
        let cursor = "";
        const seen = new Set<string>();
        do {
          const data = await this.request(
            exchange,
            "/v5/market/instruments-info",
            {
              category: "linear",
              status: "Trading",
              limit: 1000,
              ...(cursor ? { cursor } : {}),
            },
          );
          for (const m of data.result?.list || [])
            if (
              m.status === "Trading" &&
              m.contractType === "LinearPerpetual" &&
              m.quoteCoin === "USDT" &&
              m.settleCoin === "USDT"
            )
              result.push({
                symbol: m.symbol,
                base: m.baseCoin,
                quantityStep: Number(m.lotSizeFilter.qtyStep),
                minQuantity: Number(m.lotSizeFilter.minOrderQty),
                minNotional: Number(m.lotSizeFilter.minNotionalValue || 5),
                tickSize: Number(m.priceFilter.tickSize),
                maxQuantity: Number(m.lotSizeFilter.maxMktOrderQty),
              });
          cursor = data.result?.nextPageCursor || "";
          if (cursor && seen.has(cursor))
            throw new Error("Bybit повернув повторний курсор сторінки");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      const unique = [
        ...new Map(
          result
            .filter(
              (m) =>
                /^[A-Z0-9]{3,40}$/.test(m.symbol) &&
                m.quantityStep > 0 &&
                m.tickSize > 0,
            )
            .map((m) => [m.symbol, m]),
        ).values(),
      ].sort((a, b) => a.symbol.localeCompare(b.symbol));
      if (!unique.length)
        throw new Error("Біржа не повернула активні USDT perpetual контракти");
      this.markets.set(exchange, {
        expires: Date.now() + 3600_000,
        data: unique,
      });
      return unique;
    });
  }
  getPrices(
    exchange: Exchange,
  ): Promise<{ at: number; data: Record<string, number> }> {
    const cached = this.prices.get(exchange);
    if (cached && Date.now() - cached.at < 5000) return Promise.resolve(cached);
    return this.once(`prices:${exchange}`, async () => {
      const raw =
        exchange === "binance"
          ? await this.request(exchange, "/fapi/v2/ticker/price")
          : await this.request(exchange, "/v5/market/tickers", {
              category: "linear",
            });
      const list = exchange === "binance" ? raw : raw.result?.list;
      const data: Record<string, number> = {};
      for (const row of list || []) {
        const p = Number(exchange === "binance" ? row.price : row.lastPrice);
        if (Number.isFinite(p) && p > 0) data[row.symbol] = p;
      }
      if (!Object.keys(data).length)
        throw new Error("Порожня відповідь котирувань");
      const value = { at: Date.now(), data };
      this.prices.set(exchange, value);
      return value;
    });
  }
  async getExecutionBook(exchange: Exchange, symbol: string): Promise<ExecutionBook> {
    const raw = exchange === "binance"
      ? await this.request(exchange, "/fapi/v1/depth", { symbol, limit: 1000 })
      : await this.request(exchange, "/v5/market/orderbook", { category: "linear", symbol, limit: 1000 });
    const row = exchange === "binance" ? raw : raw.result;
    return { at: Number(exchange === "binance" ? raw.T || raw.E : row.ts),
      bids: (row.bids || row.b || []).map((x: any[]) => x.map(Number)),
      asks: (row.asks || row.a || []).map((x: any[]) => x.map(Number)) };
  }
  async getContractState(exchange: Exchange, symbol: string): Promise<ContractState> {
    if (exchange === "binance") {
      const [mark, last] = await Promise.all([
        this.request(exchange, "/fapi/v1/premiumIndex", { symbol }),
        this.request(exchange, "/fapi/v2/ticker/price", { symbol }),
      ]);
      return { at: Number(mark.time), mark: Number(mark.markPrice), last: Number(last.price), nextFundingAt: Number(mark.nextFundingTime) };
    }
    const raw = await this.request(exchange, "/v5/market/tickers", { category: "linear", symbol });
    const row = raw.result?.list?.find((x: any) => x.symbol === symbol);
    if (!row) throw new Error("Немає параметрів контракту");
    return { at: Number(raw.time), mark: Number(row.markPrice), last: Number(row.lastPrice), nextFundingAt: Number(row.nextFundingTime) };
  }
  async getPublicRiskTiers(symbol: string): Promise<RiskTier[]> {
    const rows: any[] = []; let cursor = ""; const seen = new Set<string>();
    do {
      const raw = await this.request("bybit", "/v5/market/risk-limit", { category: "linear", symbol, ...(cursor ? { cursor } : {}) });
      rows.push(...(raw.result?.list || []).filter((x: any) => x.symbol === symbol));
      cursor = raw.result?.nextPageCursor || "";
      if (cursor && seen.has(cursor)) throw new Error("Повторна сторінка рівнів ризику");
      seen.add(cursor);
      if (seen.size > 100) throw new Error("Забагато сторінок рівнів ризику");
    } while (cursor);
    return validTiers(rows.map(r => {
      const normalized = Number(r.initialMargin) * Number(r.maxLeverage);
      const scale = normalized > 2 ? 100 : 1;
      if (Math.abs(normalized / scale - 1) > 0.05) throw new Error("Невідомі одиниці ставки маржі Bybit");
      return { cap: Number(r.riskLimitValue), rate: Number(r.maintenanceMargin) / scale,
        deduction: Number(r.mmDeduction || 0), maxLeverage: Number(r.maxLeverage) };
    }));
  }
  async getFundingEvents(exchange: Exchange, symbol: string, from: number, to: number): Promise<FundingEvent[]> {
    const events: FundingEvent[] = [];
    // Bounded daily windows avoid the opposite pagination directions of the venues.
    if (to - from > 32 * 86400_000) throw new Error("Потрібне поетапне відновлення funding");
    for (let start = from; start <= to; start += 86400_000) {
      const end = Math.min(to, start + 86400_000 - 1);
      const raw = exchange === "binance"
        ? await this.request(exchange, "/fapi/v1/fundingRate", { symbol, startTime: start, endTime: end, limit: 1000 })
        : await this.request(exchange, "/v5/market/funding/history", { category: "linear", symbol, startTime: start, endTime: end, limit: 200 });
      const rows = exchange === "binance" ? raw : raw.result?.list;
      if (!Array.isArray(rows) || rows.length >= (exchange === "binance" ? 1000 : 200)) throw new Error("Історія funding неповна");
      for (const row of rows) {
        const at = Number(row.fundingTime || row.fundingRateTimestamp), rate = Number(row.fundingRate);
        if (at < from || at > to) continue;
        let price = Number(row.markPrice), priceSource = "settlement-mark";
        if (exchange === "bybit") {
          const candle = await this.request(exchange, "/v5/market/mark-price-kline", { category: "linear", symbol, interval: "1", start: at, end: at + 59999, limit: 1 });
          const bar = candle.result?.list?.find((x: any[]) => Number(x[0]) === at);
          price = Number(bar?.[1]); priceSource = "mark-kline-open-estimate";
        }
        if (!Number.isFinite(at) || !Number.isFinite(rate) || !Number.isFinite(price) || price <= 0) throw new Error("Некоректне нарахування funding");
        events.push({ at, rate, price, priceSource });
      }
    }
    return [...new Map(events.map(e => [e.at, e])).values()].sort((a, b) => a.at - b.at);
  }
  async getCandles(
    exchange: Exchange,
    symbol: string,
    timeframe: string,
    limit: number,
    closedOnly: boolean,
    endTime?: number,
  ): Promise<Candle[]> {
    if (
      !/^[A-Z0-9]{3,40}$/.test(symbol) ||
      !tfMs(timeframe) ||
      !Number.isInteger(limit) ||
      limit < 30 ||
      limit > 1000
    )
      throw new Error("Некоректні параметри свічок");
    if (
      endTime !== undefined &&
      (!Number.isSafeInteger(endTime) || endTime <= 0 || endTime > Date.now())
    )
      throw new Error("Некоректний час історичних свічок");
    const markets = await this.getMarkets(exchange);
    if (!markets.some((m) => m.symbol === symbol))
      throw new Error("Контракт відсутній на вибраній біржі");
    const key = `${exchange}:${symbol}:${timeframe}:${limit}:${closedOnly}:${endTime ?? "latest"}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    return this.once(key, async () => {
      const bybitTf: Record<string, string> = {
        "1m": "1",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "4h": "240",
        "1d": "D",
      };
      const raw =
        exchange === "binance"
          ? await this.request(exchange, "/fapi/v1/klines", {
              symbol,
              interval: timeframe,
              limit,
              ...(endTime === undefined ? {} : { endTime }),
            })
          : await this.request(exchange, "/v5/market/kline", {
              category: "linear",
              symbol,
              interval: bybitTf[timeframe],
              limit,
              ...(endTime === undefined ? {} : { end: endTime }),
            });
      const rows = exchange === "binance" ? raw : raw.result?.list;
      if (!Array.isArray(rows)) throw new Error("Некоректна відповідь свічок");
      const data: Candle[] = rows
        .map((k) => ({
          time: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }))
        .filter(
          (c) =>
            Object.values(c).every(Number.isFinite) &&
            c.close > 0 &&
            c.high >= c.low &&
            (!closedOnly || c.time + tfMs(timeframe) <= Date.now()),
        )
        .sort((a, b) => a.time - b.time);
      const ttl = closedOnly
        ? Math.max(
            1000,
            Math.min(60_000, tfMs(timeframe) - (Date.now() % tfMs(timeframe))),
          )
        : 5000;
      this.cache.delete(key);
      this.cache.set(key, { expires: Date.now() + ttl, data });
      while (this.cache.size > 800)
        this.cache.delete(this.cache.keys().next().value!);
      return data;
    });
  }
}
