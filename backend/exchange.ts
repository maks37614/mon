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
  maxHoldingSeconds?: number;
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
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from<0 || to<from)
      throw new Error("Некоректний інтервал funding");
    if (to - from > 90 * 86400_000) throw new Error("Історія funding потребує окремого архіву");
    const c = await this.paperRead(() => this.client(exchange)), seen = new Map<string,{at:number;value:number}>(); let cost = 0;
    for (let start = from; start <= to; start += 7 * 86400_000) {
      const end = Math.min(to, start + 7 * 86400_000 - 1);
      let cursor = ""; const cursors = new Set<string>();
      do {
        const raw = await this.paperRead<any>(async () => exchange === "binance"
          ? await c.fapiPrivateGetIncome({ symbol: symbolId, incomeType: "FUNDING_FEE", startTime: start, endTime: end, limit: 1000 })
          : await c.privateGetV5ExecutionList({ category: "linear", symbol: symbolId, execType: "Funding", startTime: start, endTime: end, limit: 100, ...(cursor ? { cursor } : {}) }));
        if(exchange==="bybit" && raw?.retCode!=null && Number(raw.retCode)!==0) throw new Error("Bybit не підтвердив історію funding");
        const rows = exchange === "binance" ? raw : raw?.result?.list;
        if (!Array.isArray(rows) || (exchange === "binance" && rows.length >= 1000)) throw new Error("Історія funding неповна");
        for (const row of rows) {
          const rawAt=exchange==="binance"?row?.time:row?.execTime;
          const rawId=exchange==="binance"?row?.tranId:row?.execId;
          const rawValue=exchange==="binance"?row?.income:row?.execFee;
          const at=Number(rawAt),value=Number(rawValue),id=String(rawId??"");
          if(rawAt==null || rawAt==="" || rawValue==null || rawValue==="" || !id ||
             !Number.isSafeInteger(at) || !Number.isFinite(value) || typeof row?.symbol!=="string")
            throw new Error("Некоректне біржове нарахування funding");
          if(row.symbol!==symbolId || at<from || at>to) continue;
          if((exchange==="binance" && row.asset!=="USDT") ||
             (exchange==="bybit" && row.feeCurrency!=null && row.feeCurrency!=="USDT"))
            throw new Error("Валюта funding не підтверджена як USDT");
          const previous=seen.get(id);
          if(previous) {
            if(previous.at!==at || previous.value!==value) throw new Error("Суперечливі дублікати funding");
            continue;
          }
          seen.set(id,{at,value});cost+=exchange==="binance"?-value:value;
          if(!Number.isFinite(cost)) throw new Error("Некоректна сума funding");
        }
        const next=exchange==="bybit"?raw.result?.nextPageCursor:"";
        if(next!=null && typeof next!=="string") throw new Error("Некоректний курсор funding");
        cursor=next||"";
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
    promise.catch(() => { if (this.clients.get(exchange) === promise) this.clients.delete(exchange); });
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
    // Never interpret an incomplete account response as a flat account.
    if (!Array.isArray(positions) || !balance?.USDT ||
      balance.USDT.free == null || balance.USDT.total == null ||
      !Number.isFinite(Number(balance.USDT.free)) || !Number.isFinite(Number(balance.USDT.total)))
      throw new Error("Неповна відповідь балансу або позицій біржі");
    if (positions.some((p: any) => !p || p.contracts == null ||
      !Number.isFinite(Number(p.contracts)) || Number(p.contracts) < 0 ||
      (Number(p.contracts) > 0 && (!["long","short"].includes(p.side) ||
        !Number.isFinite(Number(p.contractSize ?? 1)) || Number(p.contractSize ?? 1) <= 0 ||
        !Number.isFinite(Number(p.entryPrice)) || Number(p.entryPrice) <= 0 ||
        !Number.isFinite(Number(p.markPrice || p.lastPrice || p.entryPrice)) ||
        Number(p.markPrice || p.lastPrice || p.entryPrice) <= 0))))
      throw new Error("Некоректні дані відкритої позиції біржі");
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
          stopLoss: Number(p.info?.stopLoss ?? p.stopLossPrice ?? 0),
          takeProfit: Number(p.info?.takeProfit ?? p.takeProfitPrice ?? 0),
          protectionReported: (p.info?.stopLoss != null || p.stopLossPrice != null) &&
            (p.info?.takeProfit != null || p.takeProfitPrice != null),
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
  async expectedProtection(intent:Intent) {
    const client=await this.client(intent.exchange),symbol=this.symbol(client,intent.symbol);
    const stopLoss=Number(client.priceToPrecision(symbol,intent.stopLoss));
    const takeProfit=Number(client.priceToPrecision(symbol,intent.takeProfit));
    if(!Number.isFinite(stopLoss) || stopLoss<=0 || !Number.isFinite(takeProfit) || takeProfit<=0 ||
       (intent.direction==="LONG"?stopLoss>=takeProfit:stopLoss<=takeProfit))
      throw new Error("Некоректні округлені захисні рівні");
    return {stopLoss,takeProfit};
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
        existing.status !== "open"
      )
        throw new Error("Захисний ордер не підтверджено");
      onSaved(String(existing.id), type);
    }
  }
  private validateBinanceGuard(client:any,symbol:string,intent:Intent,quantity:number,suffix:string,order:any) {
    const info=order.info??{},market=client.market(symbol);
    const expectedPrice=Number(client.priceToPrecision(symbol,suffix==="sl"?intent.stopLoss:intent.takeProfit));
    const rawPrice=info.triggerPrice??info.stopPrice??order.triggerPrice??order.stopPrice;
    const price=Number(rawPrice);
    const side=String(info.side??order.side??"").toLowerCase();
    const type=String(info.orderType??info.type??order.type??"").toUpperCase();
    const reduceOnly=info.reduceOnly??order.reduceOnly;
    const rawQuantity=info.quantity??info.origQty??order.amount;
    const amount=Number(rawQuantity)*Number(market.contractSize||1);
    const matches=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-12,Math.abs(b)*1e-9);
    if(info.symbol!=null && info.symbol!==intent.symbol ||
       order.symbol!=null && order.symbol!==symbol ||
       (info.clientAlgoId??info.clientOrderId??order.clientOrderId)!==`${intent.id}-${suffix}` ||
       side!==(intent.direction==="LONG"?"sell":"buy") ||
       type!==(suffix==="sl"?"STOP_MARKET":"TAKE_PROFIT_MARKET") ||
       !(reduceOnly===true || reduceOnly==="true") ||
       info.workingType!=="CONTRACT_PRICE" || info.positionSide!=="BOTH" ||
       !matches(price,expectedPrice) || !(expectedPrice>0) ||
       !matches(amount,quantity)) throw new Error("Параметри захисного ордера Binance не підтверджені");
  }
  /** Read only. A failed request is not evidence that a guard is missing. */
  async checkProtection(intent: Intent, guardIds: string[],quantity=intent.quantity): Promise<"verified"|"missing"> {
    if(intent.exchange!=="binance") throw new Error("Перевірка захисту потребує даних позиції Bybit");
    const client=await this.client(intent.exchange),symbol=this.symbol(client,intent.symbol);
    for(const suffix of ["sl","tp"]) {
      let order:any;
      try {
        order=await client.fetchOrder(undefined,symbol,{clientOrderId:`${intent.id}-${suffix}`,trigger:true});
      } catch(error:any) {
        if(error?.name==="OrderNotFound") return "missing";
        throw error;
      }
      if(!order || !order.id || (order.symbol && order.symbol!==symbol))
        throw new Error("Неповна відповідь перевірки захисного ордера");
      if(["closed","canceled","expired","rejected"].includes(order.status)) return "missing";
      if(order.status!=="open") throw new Error("Невідомий статус захисного ордера");
      if(guardIds.length!==2 || new Set(guardIds).size!==2 || !guardIds.includes(String(order.id)))
        throw new Error("Ідентифікатор захисного ордера не збігається");
      this.validateBinanceGuard(client,symbol,intent,quantity,suffix,order);
    }
    return "verified";
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
    if (!Array.isArray(trades) || trades.length >= 1000)
      throw new Error("Історія виконань неповна; потрібна додаткова звірка");
    if (trades.some((t:any)=>!t || t.id == null || String(t.id)==="" ||
      !Number.isFinite(t.timestamp) || (t.symbol && t.symbol!==symbol)))
      throw new Error("Некоректна історія виконань");
    const fills = trades.filter((t: any) => t.timestamp >= since - 1000);
    return fills.map((t: any) => ({
      id: String(t.id),
      orderId: String(t.order || ""),
      side: t.side,
      quantity: Number(t.amount) * Number(c.market(symbol).contractSize || 1),
      price: Number(t.price),
      fee: t.fee?.currency === "USDT" && t.fee.cost != null && Number.isFinite(Number(t.fee.cost)) ? Number(t.fee.cost) : 0,
      feeKnown: t.fee?.currency === "USDT" && t.fee.cost != null && Number.isFinite(Number(t.fee.cost)),
      at: t.timestamp,
    }));
  }
}
