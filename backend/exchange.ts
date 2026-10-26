import type { Exchange, Signal, Settings } from "./config";
import type { Vault } from "./security";
import { validTiers, type RiskTier } from "./paperModel";

export const exchangeError = (error: any) =>
  `Біржа: ${String(error?.name || "ExchangeError")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 64)}`;
export const definitiveRejection = (e: any) =>
  [
    "AuthenticationError",
    "PermissionDenied",
    "InsufficientFunds",
    "InvalidOrder",
    "BadRequest",
    "BadSymbol",
    "AccountSuspended",
  ].includes(e?.name);
export type Fill = {
  id: string;
  clientOrderId?: string;
  filled: number;
  average: number;
  status: string;
  fee: number;
  at?: number;
};
export type Intent = {
  id: string;
  exchange: Exchange;
  symbol: string;
  direction: "LONG" | "SHORT";
  signal: Signal;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: number;
  orderId?: string;
  kind: "entry" | "close";
  positionId?: string;
  reason?: string;
  error?: string;
};

export class ExchangeGateway {
  private clients = new Map<Exchange, Promise<any>>();
  private paperCache = new Map<string, { at: number; value: any }>();
  constructor(
    private vault: Vault,
    private factory?: (exchange: Exchange, credentials: any) => Promise<any>,
  ) {}
  invalidate(exchange: Exchange) {
    this.clients.delete(exchange);
    for (const key of this.paperCache.keys()) if (key.startsWith(exchange + ":")) this.paperCache.delete(key);
  }
  private async paperRead<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { throw new Error(exchangeError(error)); }
  }
  async takerRate(exchange: Exchange, symbolId: string, refresh = false): Promise<{ rate: number; at: number; source: string }> {
    const key = `${exchange}:fee:${symbolId}`, cached = this.paperCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 600_000) return cached.value;
    if (!this.vault.status(exchange).configured) throw new Error("Для автоматичної комісії збережіть API-ключ із правами читання або оберіть ручний тариф");
    const c = await this.paperRead(() => this.client(exchange)), symbol = this.symbol(c, symbolId);
    const raw = await this.paperRead<any>(() => c.fetchTradingFee(symbol)), rate = Number(raw.taker);
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.01) throw new Error("Біржа не повернула коректний taker-тариф");
    const value = { rate, at: Date.now(), source: "account-api" };
    this.paperCache.set(key, { at: value.at, value }); return value;
  }
  async riskTiers(symbolId: string): Promise<RiskTier[]> {
    const key = `binance:risk:${symbolId}`, cached = this.paperCache.get(key);
    if (cached && Date.now() - cached.at < 600_000) return cached.value;
    if (!this.vault.status("binance").configured) throw new Error("Binance потребує API-ключ читання для біржових рівнів маржі симулятора");
    const c = await this.paperRead(() => this.client("binance"));
    const raw = await this.paperRead<any>(() => c.fapiPrivateGetLeverageBracket({ symbol: symbolId }));
    const row = Array.isArray(raw) ? raw.find((r: any) => r.symbol === symbolId) : raw;
    const coefficient = Number(row?.notionalCoef || 1);
    if (!(coefficient > 0)) throw new Error("Некоректний коефіцієнт рівнів маржі");
    const value = validTiers((row?.brackets || []).map((r: any) => ({
      cap: Number(r.notionalCap) * coefficient, rate: Number(r.maintMarginRatio),
      deduction: Number(r.cum) * coefficient, maxLeverage: Number(r.initialLeverage),
    })));
    this.paperCache.set(key, { at: Date.now(), value }); return value;
  }
  async fundingCost(exchange: Exchange, symbolId: string, from: number, to: number): Promise<number> {
    if (to - from > 90 * 86400_000) throw new Error("Історія funding потребує окремого архіву");
    const c = await this.paperRead(() => this.client(exchange)), seen = new Set<string>(); let cost = 0;
    for (let start = from; start <= to; start += 7 * 86400_000) {
      const end = Math.min(to, start + 7 * 86400_000 - 1);
      let cursor = ""; const cursors = new Set<string>();
      do {
        const raw = await this.paperRead<any>(async () => exchange === "binance"
          ? await c.fapiPrivateGetIncome({ symbol: symbolId, incomeType: "FUNDING_FEE", startTime: start, endTime: end, limit: 1000 })
          : await c.privateGetV5ExecutionList({ category: "linear", symbol: symbolId, execType: "Funding", startTime: start, endTime: end, limit: 100, ...(cursor ? { cursor } : {}) }));
        const rows = exchange === "binance" ? raw : raw.result?.list;
        if (!Array.isArray(rows) || (exchange === "binance" && rows.length >= 1000)) throw new Error("Історія funding неповна");
        for (const row of rows) {
          const at = Number(exchange === "binance" ? row.time : row.execTime);
          if (at < from || at > to || row.symbol !== symbolId) continue;
          const id = String(exchange === "binance" ? row.tranId : row.execId);
          const value = Number(exchange === "binance" ? row.income : row.execFee);
          if (!id || id === "undefined" || !Number.isFinite(at) || !Number.isFinite(value) ||
            (exchange === "binance" && row.asset !== "USDT")) throw new Error("Некоректне біржове нарахування funding");
          if (seen.has(id)) continue;
          seen.add(id); cost += exchange === "binance" ? -value : value;
        }
        cursor = exchange === "bybit" ? raw.result?.nextPageCursor || "" : "";
        if (cursor && cursors.has(cursor)) throw new Error("Повторний курсор funding");
        cursors.add(cursor);
        if (cursors.size > 100) throw new Error("Забагато сторінок funding");
      } while (cursor);
    }
    return cost;
  }
  private async client(exchange: Exchange) {
    if (this.clients.has(exchange)) return this.clients.get(exchange)!;
    const promise = (async () => {
      const credentials = this.vault.load(exchange);
      if (!credentials) throw new Error("API-ключі не налаштовано");
      let client: any;
      if (this.factory) client = await this.factory(exchange, credentials);
      else {
        // Load only the selected exchange, rather than every CCXT adapter, to save RAM.
        const root = import.meta.resolve("ccxt");
        const module = await import(
          new URL(
            exchange === "binance" ? "./src/binanceusdm.js" : "./src/bybit.js",
            root,
          ).href
        );
        client = new module.default({
          ...credentials,
          enableRateLimit: true,
          timeout: 12_000,
          maxRetriesOnFailure: 0,
          options: {
            defaultType: "swap",
            defaultSubType: "linear",
            adjustForTimeDifference: true,
            fetchMarkets: { types: ["linear"] },
          },
        });
      }
      await client.loadMarkets();
      return client;
    })();
    this.clients.set(exchange, promise);
    promise.catch(() => this.clients.delete(exchange));
    return promise;
  }
  private symbol(client: any, symbol: string) {
    const market = Object.values(client.markets).find(
      (m: any) => m.id === symbol && m.swap && m.linear && m.settle === "USDT",
    ) as any;
    if (!market) throw new Error("USDT perpetual контракт не підтримується");
    return market.symbol as string;
  }
  async account(exchange: Exchange) {
    const client = await this.client(exchange);
    const [balance, positions] = await Promise.all([
      client.fetchBalance({ type: "swap" }),
      client.fetchPositions(undefined, { settleCoin: "USDT" }),
    ]);
    if (
      positions.some(
        (p: any) => p.hedged === true || Number(p.info?.positionIdx || 0) !== 0,
      )
    )
      throw new Error(
        "Потрібен режим позицій One-way; Hedge Mode не підтримується",
      );
    if (exchange === "binance" && client.has?.fetchPositionMode) {
      const mode = await client.fetchPositionMode();
      if (mode.hedged) throw new Error("Потрібен режим позицій One-way");
    }
    return {
      free: Number(balance.USDT?.free || 0),
      total: Number(balance.USDT?.total || 0),
      positions: positions
        .filter((p: any) => Number(p.contracts) > 0)
        .map((p: any) => ({
          symbol: p.info?.symbol || client.market(p.symbol).id,
          quantity: Number(p.contracts) * Number(p.contractSize || 1),
          direction: p.side === "long" ? "LONG" : "SHORT",
          entryPrice: Number(p.entryPrice),
          currentPrice: Number(p.markPrice || p.lastPrice || p.entryPrice),
          stopLoss: Number(p.stopLossPrice || 0),
          takeProfit: Number(p.takeProfitPrice || 0),
        })),
    };
  }
  async quantity(
    exchange: Exchange,
    symbol: string,
    price: number,
    notional: number,
  ) {
    const c = await this.client(exchange),
      unified = this.symbol(c, symbol),
      m = c.market(unified);
    const quantity = Number(
      c.amountToPrecision(
        unified,
        notional / price / Number(m.contractSize || 1),
      ),
    );
    const actualNotional = quantity * Number(m.contractSize || 1) * price;
    if (
      !quantity ||
      quantity < Number(m.limits?.amount?.min || 0) ||
      actualNotional < Number(m.limits?.cost?.min || 0) ||
      actualNotional > notional * 1.001
    )
      throw new Error(
        "Сума ордера менша за мінімум біржі або не відповідає кроку кількості",
      );
    return quantity * Number(m.contractSize || 1);
  }
  private fill(raw: any): Fill {
    const fees = raw.fees?.length ? raw.fees : raw.fee ? [raw.fee] : [];
    return {
      id: String(raw.id || ""),
      clientOrderId: raw.clientOrderId,
      filled: Number(raw.filled || 0),
      average: Number(raw.average || 0),
      status: raw.status || "unknown",
      fee: fees
        .filter((f: any) => f.currency === "USDT")
        .reduce((a: number, f: any) => a + Number(f.cost || 0), 0),
      at: Number(raw.lastTradeTimestamp || raw.timestamp || Date.now()),
    };
  }
  async prepare(exchange: Exchange, symbolId: string, leverage: number) {
    const client = await this.client(exchange),
      symbol = this.symbol(client, symbolId);
    try {
      await client.setLeverage(leverage, symbol);
    } catch (e: any) {
      if (!String(e?.message || "").includes("110043")) throw e;
    }
  }
  async submit(intent: Intent, settings: Settings): Promise<Fill> {
    const client = await this.client(intent.exchange),
      symbol = this.symbol(client, intent.symbol);
    const m = client.market(symbol),
      amount = intent.quantity / Number(m.contractSize || 1);
    const closing = intent.kind === "close";
    const side = (intent.direction === "LONG") !== closing ? "buy" : "sell";
    const params: any = {
      clientOrderId: intent.id,
      ...(closing ? { reduceOnly: true } : {}),
      ...(intent.exchange === "bybit"
        ? { positionIdx: 0 }
        : { positionSide: "BOTH" }),
    };
    if (!closing && intent.exchange === "bybit") {
      params.stopLoss = {
        triggerPrice: Number(client.priceToPrecision(symbol, intent.stopLoss)),
      };
      params.takeProfit = {
        triggerPrice: Number(
          client.priceToPrecision(symbol, intent.takeProfit),
        ),
      };
      params.tpslMode = "Full";
      params.slTriggerBy = "LastPrice";
      params.tpTriggerBy = "LastPrice";
    }
    if (intent.exchange === "binance") params.newOrderRespType = "RESULT";
    const order = await client.createOrder(
      symbol,
      "market",
      side,
      amount,
      undefined,
      params,
    );
    const result = this.fill(order);
    result.filled *= Number(m.contractSize || 1);
    return result;
  }
  async read(intent: Intent): Promise<Fill | null> {
    const client = await this.client(intent.exchange),
      symbol = this.symbol(client, intent.symbol);
    const params =
      intent.exchange === "binance"
        ? { clientOrderId: intent.id }
        : { acknowledged: true, orderLinkId: intent.id };
    try {
      const order = await client.fetchOrder(intent.orderId, symbol, params);
      const result = this.fill(order);
      result.filled *= Number(client.market(symbol).contractSize || 1);
      return result;
    } catch (e: any) {
      if (e?.name === "OrderNotFound") return null;
      throw e;
    }
  }
  async protection(
    intent: Intent,
    quantity: number,
    onSaved: (id: string, type: string) => void,
  ) {
    const client = await this.client(intent.exchange),
      symbol = this.symbol(client, intent.symbol);
    if (intent.exchange === "bybit") return; // TP/SL was attached atomically to the opening order.
    for (const [type, price, suffix] of [
      ["stopLossPrice", intent.stopLoss, "sl"],
      ["takeProfitPrice", intent.takeProfit, "tp"],
    ] as const) {
      const id = `${intent.id}-${suffix}`;
      let existing: any;
      try {
        existing = await client.fetchOrder(undefined, symbol, {
          clientOrderId: id,
          trigger: true,
        });
      } catch (e: any) {
        if (e?.name !== "OrderNotFound") throw e;
      }
      if (!existing)
        existing = await client.createOrder(
          symbol,
          "market",
          intent.direction === "LONG" ? "sell" : "buy",
          quantity / Number(client.market(symbol).contractSize || 1),
          undefined,
          {
            [type]: Number(client.priceToPrecision(symbol, price)),
            reduceOnly: true,
            positionSide: "BOTH",
            clientOrderId: id,
            workingType: "CONTRACT_PRICE",
          },
        );
      if (
        !existing.id ||
        existing.status === "rejected" ||
        existing.status === "canceled"
      )
        throw new Error("Захисний ордер не підтверджено");
      onSaved(String(existing.id), type);
    }
  }
  async cancelProtection(
    exchange: Exchange,
    symbolId: string,
    guardIds: string[],
    entryClientId?: string,
  ) {
    if (exchange !== "binance") return;
    const c = await this.client(exchange),
      symbol = this.symbol(c, symbolId);
    const ownedIds = new Set(guardIds);
    // Recover guards whose creation succeeded but whose acknowledgement was lost.
    if (entryClientId)
      for (const suffix of ["sl", "tp"]) {
        try {
          const order = await c.fetchOrder(undefined, symbol, {
            clientOrderId: `${entryClientId}-${suffix}`,
            trigger: true,
          });
          if (order.id) ownedIds.add(String(order.id));
        } catch (e: any) {
          if (e?.name !== "OrderNotFound") throw e;
        }
      }
    for (const id of ownedIds)
      try {
        await c.cancelOrder(id, symbol, { trigger: true });
      } catch (e: any) {
        if (e?.name === "OrderNotFound") continue;
        if (e?.name === "InvalidOrder") {
          const existing = await c.fetchOrder(id, symbol, { trigger: true });
          if (["closed", "canceled", "expired"].includes(existing.status))
            continue;
        }
        throw e;
      }
  }
  async closingTrades(
    exchange: Exchange,
    symbolId: string,
    since: number,
    direction: string,
  ): Promise<
    {
      id: string;
      orderId: string;
      side: string;
      quantity: number;
      price: number;
      fee: number;
      feeKnown: boolean;
      at: number;
    }[]
  > {
    const c = await this.client(exchange),
      symbol = this.symbol(c, symbolId);
    const trades = await c.fetchMyTrades(symbol, since - 1000, 1000);
    const fills = trades.filter((t: any) => t.timestamp >= since - 1000);
    return fills.map((t: any) => ({
      id: String(t.id),
      orderId: String(t.order || ""),
      side: t.side,
      quantity: Number(t.amount) * Number(c.market(symbol).contractSize || 1),
      price: Number(t.price),
      fee: t.fee?.currency === "USDT" ? Number(t.fee.cost || 0) : 0,
      feeKnown: t.fee?.currency === "USDT",
      at: t.timestamp,
    }));
  }
}
