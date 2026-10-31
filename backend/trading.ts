import { randomBytes } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  FORMATION_ANALYSIS_VERSION,
  validateSettings,
  type Settings,
  type Signal,
  type TradeHistoryEntry,
  type Mode,
  type Exchange,
} from "./config";
import { Mutex, type Store } from "./store";
import { formationIsVisible, signalAllowsEntry } from "./formationState";
import { EV_TEST_ID, selectEvTestCandidates } from "./evTestRouting";
import { EDWIN_DEFAULTS, type EdwinSettings, type EdwinSignal } from "./edwinStrategy";
import { tradingScheduleState } from "./tradingSchedule";
import type { MarketData } from "./market";
import type { Vault } from "./security";
import { depthFill, liquidationPrice, liquidatable, validTiers, type PaperState } from "./paperModel";
import { PaperFeed, type PriceTick } from "./paperFeed";
import {
  ExchangeGateway,
  definitiveRejection,
  exchangeError,
  type Intent,
  type Fill,
} from "./exchange";

export type Position = {
  id: string;
  exchange: Exchange;
  symbol: string;
  direction: "LONG" | "SHORT";
  formation: string;
  timeframe?: string;
  quantity: number;
  originalQuantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  expiresAt: number;
  entryFee: number;
  entryOrderId?: string;
  intent: Intent;
  guards: string[];
  status: "active" | "protecting" | "closing" | "reconciling";
  unrealizedPnl: number;
  paper?: PaperState;
};
type Book = {
  balance: number;
  startBalance: number;
  positions: Position[];
  history: TradeHistoryEntry[];
  pending: Intent[];
  used: Record<string, number>;
  lastEntries: Record<string, number>;
  lastEntryAt: number;
  accountAt?: number;
  candidateCursor?: number;
};
const newBook = (mode: Mode, balance: number): Book => ({
  balance: mode === "paper" ? balance : 0,
  startBalance: mode === "paper" ? balance : 0,
  positions: [],
  history: [],
  pending: [],
  used: {},
  lastEntries: {},
  lastEntryAt: 0,
});
const orderId = () => `mon-${randomBytes(12).toString("hex")}`;
const sameQuantity = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-8, a * 1e-6);

export class Trading {
  private mutex = new Mutex();
  private timer: ReturnType<typeof setInterval> | null = null;
  private monitoring = false;
  private running = false;
  private lastLiveCycle = 0;
  private paperGaps = new Set<string>();
  private paperErrorLog = new Map<string, number>();
  private evTestRejectionLog = new Map<string, number>();
  private paperWatched = new Map<string, Position>();
  private paperTicks = new Map<string, PriceTick & { lastAt?: number; markAt?: number; trigger?: PaperState["closeTrigger"] }>();
  private feed = new PaperFeed((exchange, symbol, tick) => this.paperTick(exchange, symbol, tick),
    (exchange, symbol) => {
      this.store.log("WARN", `${exchange} ${symbol}: розрив потоку симуляції; точність спостереження знижена`);
      this.paperGaps.add(`${exchange}:${symbol}`);
    });
  constructor(
    private store: Store,
    private market: MarketData,
    private vault: Vault,
    private gateway: ExchangeGateway,
    readonly liveAllowed: boolean,
  ) {}
  settings() {
    const saved = this.store.get<Partial<Settings>>("settings", {});
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  }
  private evTestEnabled() {
    return this.store.get<{ enabled?: boolean }>("builder:edwin:config", {}).enabled === true;
  }
  private evTestRiskSettings(): EdwinSettings {
    return { ...EDWIN_DEFAULTS, ...this.store.get<Partial<EdwinSettings>>("builder:edwin:config", {}) };
  }
  private evTestCandidates(settings: Settings) {
    return selectEvTestCandidates(
      this.store.get<Signal[]>("signals", []),
      this.store.get<EdwinSignal[]>("builder:edwin:signals", []),
      settings,
    );
  }
  private book(mode: Mode) {
    return this.store.get(
      `book:${mode}`,
      newBook(mode, this.settings().initialBalance),
    );
  }
  private save(mode: Mode, book: Book) {
    this.store.set(`book:${mode}`, book);
  }
  hasExposure() {
    return (["paper", "live"] as Mode[]).some((m) => {
      const b = this.book(m);
      return b.positions.length || b.pending.length;
    });
  }
  hasLiveExposure() {
    const b = this.book("live");
    return !!(b.positions.length || b.pending.length);
  }
  private pause(message: string) {
    this.store.set("settings", { ...this.settings(), autoEntries: false });
    this.store.log("ERROR", message);
  }
  updateSettings(input: unknown) {
    return this.mutex.run(async () => {
      const previous = this.settings(),
        next = validateSettings(input, previous);
      if (
        (next.exchange !== previous.exchange ||
          next.mode !== previous.mode ||
          next.initialBalance !== previous.initialBalance ||
          next.leverage !== previous.leverage) &&
        this.hasExposure()
      )
        throw new Error(
          "Спочатку закрийте позиції та узгодьте очікуючі ордери",
        );
      if (next.mode === "live") {
        if (!this.liveAllowed)
          throw new Error(
            "Реальну торгівлю потрібно дозволити у конфігурації сервера ENABLE_LIVE_TRADING",
          );
        if (!this.vault.status(next.exchange).verified)
          throw new Error("Спочатку перевірте API-ключі вибраної біржі");
      }
      this.store.set("settings", next);
      return next;
    });
  }
  async verifyCredentials(exchange: Exchange) {
    try {
      const account = await this.gateway.account(exchange);
      this.vault.verify(exchange);
      return {
        freeUsdt: account.free,
        totalUsdt: account.total,
        positions: account.positions.length,
      };
    } catch (e: any) {
      throw new Error(
        e?.message?.startsWith("Потрібен") ? e.message : exchangeError(e),
      );
    }
  }
  snapshot() {
    const s = this.settings(),
      b = this.book(s.mode),
      pnl = b.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const history = b.history,
      wins = history.filter((t) => t.netPnl > 0).length;
    const now = Date.now();
    const formations = this.store.get<Signal[]>("signals", [])
      .filter((signal) => formationIsVisible(signal, s, now));
    return {
      settings: s,
      evTestEnabled: this.evTestEnabled(),
      entrySchedule: tradingScheduleState(s.tradingSchedule, now),
      positions: b.positions.map(({ intent, ...p }) => ({
        ...p,
        timeframe: p.timeframe || intent?.signal?.timeframe,
      })),
      pending: b.pending.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        kind: p.kind,
        createdAt: p.createdAt,
        error: p.error || "Очікуємо підтвердження біржі",
      })),
      history,
      stats: {
        balance: b.balance,
        equity: b.balance + pnl,
        unrealizedPnl: pnl,
        closedNetPnl: history.reduce(
          (sum, t) => sum + Number(t.netPnl || 0),
          0,
        ),
        totalTrades: history.length,
        winRate: history.length ? (wins / history.length) * 100 : 0,
        accountAt: b.accountAt || null,
      },
      signals: formations.filter((signal) => signalAllowsEntry(signal, s, now)),
      formations: formations.map((signal) => ({
        ...signal, canEnter: signalAllowsEntry(signal, s, now),
      })),
      scanner: this.store.get<any>("scanner", {}),
      logs: this.store.get<any[]>("logs", []),
      liveAllowed: this.liveAllowed,
      credentials: {
        binance: this.vault.status("binance"),
        bybit: this.vault.status("bybit"),
      },
    };
  }
  start() {
    this.running = true;
    this.syncPaperFeed();
    this.timer = setInterval(() => {
      void this.monitor();
    }, 1000);
    void this.monitor();
  }
  async stop() {
    this.running = false;
    this.feed.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.mutex.run(async () => {});
  }
  monitor() {
    if (this.monitoring) return Promise.resolve();
    this.monitoring = true;
    return this.mutex
      .run(async () => {
        try {
          const s = this.settings(),
            b = this.book(s.mode);
          if (this.running && s.mode === "live" && Date.now() - this.lastLiveCycle < 5000) return;
          if (s.mode === "live") this.lastLiveCycle = Date.now();
          if (
            s.mode === "live" &&
            (b.positions.length || b.pending.length || s.autoEntries)
          )
            await this.reconcileLive(b, s);
          if (s.mode === "live") {
            for (const trade of b.history.filter(t => t.fundingComplete === false && Date.now() - t.closedAt >= 60000 && Date.now() - (t.fundingCheckedAt || 0) >= 60000).slice(0, 3)) {
              trade.fundingCheckedAt = Date.now();
              try {
                trade.fundingCost = await this.gateway.fundingCost(trade.exchange, trade.symbol, trade.openedAt!, trade.closedAt);
                trade.fundingComplete = true;
                trade.netPnl = trade.grossPnl - trade.fee - trade.fundingCost;
              } catch { /* Keep the missing cost explicit and retry later. */ }
            }
            this.save("live", b);
          }
          if (s.mode === "paper" && b.positions.length) {
            for (const p of [...b.positions]) {
              try { await this.monitorPaper(b, p); }
              catch (e: any) {
                if (p.paper && !p.paper.warnings.includes("data-unavailable")) p.paper.warnings.push("data-unavailable");
                if (Date.now() - (this.paperErrorLog.get(p.id) || 0) >= 60000) {
                  this.paperErrorLog.set(p.id, Date.now());
                  this.store.log("WARN", `${p.symbol}: симуляція очікує дані — ${String(e.message).slice(0, 180)}`);
                }
              }
            }
            this.save("paper", b);
          }
          this.syncPaperFeed();
          if (
            s.autoEntries &&
            tradingScheduleState(s.tradingSchedule).allowed &&
            !b.pending.length &&
            Date.now() - b.lastEntryAt >= s.entryIntervalSeconds * 1000
          ) {
            b.lastEntryAt = Date.now();
            this.save(s.mode, b);
            const signals = (this.evTestEnabled()
              ? this.evTestCandidates(s)
              : this.snapshot().signals)
              .filter(
                (signal) =>
                  !b.used[signal.id] &&
                  !b.positions.some((p) => p.symbol === signal.symbol),
              )
              .sort((a, z) => z.confidence - a.confidence);
            const maxAttempts = Math.min(
              signals.length,
              Math.max(10, s.maxPositions * 2),
            );
            const cursor =
              (b.candidateCursor || 0) % Math.max(1, signals.length);
            b.candidateCursor =
              (cursor + maxAttempts) % Math.max(1, signals.length);
            this.save(s.mode, b);
            for (let candidate = 0; candidate < maxAttempts; candidate++) {
              const signal = signals[(cursor + candidate) % signals.length];
              if (
                this.book(s.mode).positions.length >= s.maxPositions ||
                !this.settings().autoEntries ||
                !tradingScheduleState(this.settings().tradingSchedule).allowed
              )
                break;
              try {
                await this.enterLocked(signal, true);
              } catch (error: any) {
                // Make Ev-Test rejection reasons visible without flooding the existing log.
                if (signal.strategyId === EV_TEST_ID) {
                  const reason = String(error?.message || "Вхід не пройшов перевірки").slice(0, 160);
                  const key = signal.symbol + ":" + reason;
                  if (Date.now() - (this.evTestRejectionLog.get(key) || 0) > 60_000) {
                    this.evTestRejectionLog.set(key, Date.now());
                    this.store.log("INFO", "Ev-Test " + signal.symbol + ": " + reason);
                  }
                  if (this.evTestRejectionLog.size > 300) this.evTestRejectionLog.clear();
                }
              }
            }
          }
        } catch (e: any) {
          this.store.log(
            "WARN",
            e?.message?.startsWith("API ")
              ? e.message
              : "Не вдалося оновити стан торгівлі; нові ордери цього циклу пропущено",
          );
        }
      })
      .finally(() => {
        this.monitoring = false;
      });
  }
  enter(signalId: string) {
    return this.mutex.run(async () => {
      const signal = (this.evTestEnabled()
        ? this.evTestCandidates(this.settings())
        : this.store.get<Signal[]>("signals", []))
        .find((x) => x.id === signalId);
      if (!signal) throw new Error("Сигнал відсутній або вже застарів");
      await this.enterLocked(signal, false);
    });
  }
  private async enterLocked(signal: Signal, automatic: boolean) {
    const s = this.settings(),
      b = this.book(s.mode),
      now = Date.now();
    if (automatic && (!s.autoEntries || !tradingScheduleState(s.tradingSchedule, now).allowed))
      throw new Error("Автоматичні входи призупинено або зараз поза торговим розкладом");
    const isEvTest = signal.strategyId === EV_TEST_ID;
    if (isEvTest !== this.evTestEnabled()) throw new Error("Стратегія перемкнулася; сигнал більше не активний");
    if (isEvTest && !this.evTestCandidates(s).some((candidate) => candidate.id === signal.id))
      throw new Error("Ev-Test: сигнал зник з актуального списку формацій або застарів");
    if (isEvTest) {
      const risk = this.evTestRiskSettings();
      const today = (at: number) => new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(at);
      const day = today(now);
      const netToday = b.history.filter((trade) => today(trade.closedAt) === day)
        .reduce((sum, trade) => sum + trade.netPnl, 0);
      const baseline = b.startBalance > 0 ? b.startBalance : b.balance;
      if (!(baseline > 0) || netToday <= -(baseline * risk.maxDailyLossPercent / 100))
        throw new Error("Ev-Test: денний ліміт збитків досягнуто або баланс невідомий");
    }
    if (signal.analysisVersion !== FORMATION_ANALYSIS_VERSION || !Number.isInteger(signal.confidence) ||
      signal.confidence < 0 || signal.confidence > 100)
      throw new Error("Сигнал потребує нового сканування та оцінювання");
    if (
      signal.exchange !== s.exchange ||
      (!isEvTest && !s.timeframes.includes(signal.timeframe)) ||
      (!isEvTest && !s.formationTypes.includes(signal.formation)) ||
      (!isEvTest && signal.confidence < s.minScore) ||
      (s.confirmedOnly && signal.status !== "confirmed")
    )
      throw new Error("Сигнал не відповідає поточним фільтрам");
    if (
      now - signal.candleAt > s.maxSignalAgeSeconds * 1000 ||
      signal.candleAt > now + 2000
    )
      throw new Error("Сигнал застарів");
    if (b.pending.length || b.positions.some((p) => p.status !== "active"))
      throw new Error("Спочатку потрібно узгодити ордери або захисні рівні");
    if (
      b.positions.length >= s.maxPositions ||
      b.positions.some((p) => p.symbol === signal.symbol) ||
      b.used[signal.id]
    )
      throw new Error("Ліміт позицій або сигнал уже використано");
    if (
      now - (b.lastEntries[signal.symbol] || 0) <
      s.entryCooldownSeconds * 1000
    )
      throw new Error("Триває пауза повторного входу для цієї монети");
    const quotes = await this.market.getPrices(s.exchange),
      price = quotes.data[signal.symbol];
    if (!price || Date.now() - quotes.at > 15_000)
      throw new Error("Немає свіжої ринкової ціни");
    if (
      (Math.abs(price - signal.entryPrice) / signal.entryPrice) * 100 >
      s.slippageTolerancePercent
    )
      throw new Error("Ціна відійшла від точки входу більше дозволеного");
    const direction = !isEvTest && s.reverseEnabled
      ? signal.direction === "LONG"
        ? "SHORT"
        : "LONG"
      : signal.direction;
    const sign = direction === "LONG" ? 1 : -1;
    const notional = isEvTest ? s.orderNotionalUsdt * (signal.positionFraction || 0.25) : s.orderNotionalUsdt;
    const slPct = isEvTest ? Math.abs(signal.stopLoss / signal.entryPrice - 1) * 100 : s.stopLossPercent;
    const tpPct = isEvTest ? Math.abs(signal.takeProfit / signal.entryPrice - 1) * 100 : s.takeProfitPercent;
    if (isEvTest && (slPct < 0.2 || slPct > 2 || tpPct < 0.5 || tpPct > 10))
      throw new Error("Ev-Test: захисні рівні поза допустимими межами");
    let stopLoss = price * (1 - sign * slPct / 100),
      takeProfit = price * (1 + sign * tpPct / 100);
    let quantity: number;
    let paper: PaperState | undefined, executionPrice = price;
    if (s.mode === "paper") {
      const market = (await this.market.getMarkets(s.exchange)).find(
        (m) => m.symbol === signal.symbol,
      );
      if (!market) throw new Error("Контракт більше не торгується");
      quantity = Number(
        (
          Math.floor(
            notional / price / market.quantityStep + 1e-10,
          ) * market.quantityStep
        ).toPrecision(12),
      );
      paper = await this.newPaperState(s, signal.symbol, price, quantity);
      if (paper.latencyMs) await new Promise(resolve => setTimeout(resolve, paper!.latencyMs));
      const book = await this.market.getExecutionBook(s.exchange, signal.symbol);
      executionPrice = depthFill(book, direction === "LONG" ? "buy" : "sell", quantity);
      if (quantity * executionPrice > notional) {
        quantity = Number((Math.floor(notional / executionPrice / market.quantityStep + 1e-10) * market.quantityStep).toPrecision(12));
        executionPrice = depthFill(book, direction === "LONG" ? "buy" : "sell", quantity);
      }
      if (Math.abs(executionPrice - signal.entryPrice) / signal.entryPrice * 100 > s.slippageTolerancePercent)
        throw new Error("Ціна виконання зі стакана перевищує допустиме відхилення");
      const tier = paper.tiers.find(t => quantity * executionPrice <= t.cap);
      if (!tier || s.leverage > tier.maxLeverage || quantity * executionPrice > notional * 1.000001 ||
        (market.maxQuantity && quantity > market.maxQuantity)) throw new Error("Обсяг або плече перевищують біржовий ліміт");
      paper.closeFeeReserve = s.exchange === "bybit" ? executionPrice * quantity * (1 - sign / s.leverage) * paper.takerRate : 0;
      paper.initialMargin = executionPrice * quantity / s.leverage + paper.closeFeeReserve;
      paper.marginBalance = paper.initialMargin;
      if (Math.abs(Date.now() - paper.nextFundingAt) <= 5000) paper.warnings.push("funding-boundary-estimate");
      paper.entrySlippage = (executionPrice - price) * quantity * sign;
      paper.liquidationPrice = liquidationPrice({ direction, entryPrice: executionPrice, quantity }, paper);
      if (liquidatable({ direction, entryPrice: executionPrice, quantity }, paper, paper.markPrice)) throw new Error("Маржа недостатня вже при відкритті");
      stopLoss = executionPrice * (1 - sign * slPct / 100);
      takeProfit = executionPrice * (1 + sign * tpPct / 100);
      const reserved = b.positions.reduce(
        (sum, p) => sum + (p.paper ? Math.max(0, p.paper.marginBalance ?? p.paper.initialMargin - p.paper.fundingCost) : (p.entryPrice * p.quantity) / s.leverage),
        0,
      );
      if (
        quantity < market.minQuantity ||
        quantity * executionPrice < market.minNotional ||
        b.balance - reserved <
          paper.initialMargin + quantity * executionPrice * paper.takerRate
      )
        throw new Error(
          "Недостатньо віртуальної маржі або сума менша за мінімум біржі",
        );
    } else {
      if (!this.liveAllowed || !this.vault.status(s.exchange).verified)
        throw new Error("Реальну торгівлю не дозволено або API не перевірено");
      let account: Awaited<ReturnType<ExchangeGateway["account"]>>;
      try {
        account = await this.gateway.account(s.exchange);
      } catch (e) {
        throw new Error(exchangeError(e));
      }
      if (account.positions.some((p) => p.symbol === signal.symbol))
        throw new Error("На біржі вже є позиція по цій монеті");
      if (account.free < (notional / s.leverage) * 1.03)
        throw new Error("Недостатньо вільної маржі на біржі");
      quantity = await this.gateway.quantity(
        s.exchange,
        signal.symbol,
        price,
        notional,
      );
      await this.gateway.prepare(s.exchange, signal.symbol, s.leverage);
    }
    // Quotes, account reads and exchange preparation may span the session boundary.
    if (isEvTest !== this.evTestEnabled() || (isEvTest && !this.evTestCandidates(this.settings()).some(candidate => candidate.id === signal.id)))
      throw new Error("Ev-Test: умови або джерело монети змінилися до відправлення ордера");
    if (Date.now() - signal.candleAt > s.maxSignalAgeSeconds * 1000) throw new Error("Сигнал застарів під час підготовки виконання");
    if (automatic && !tradingScheduleState(s.tradingSchedule).allowed)
      throw new Error("Торгова сесія завершилася під час підготовки входу");
    const intent: Intent = {
      id: orderId(),
      exchange: s.exchange,
      symbol: signal.symbol,
      direction,
      signal,
      quantity,
      stopLoss,
      takeProfit,
      createdAt: Date.now(),
      kind: "entry",
    };
    b.used[signal.id] = now;
    b.lastEntries[signal.symbol] = now;
    b.used = Object.fromEntries(
      Object.entries(b.used)
        .filter(([, at]) => now - at < 7 * 86400_000)
        .slice(-10_000),
    );
    if (s.mode === "paper") {
      const fee = executionPrice * quantity * paper!.takerRate;
      b.balance -= fee;
      const position = this.position(
          intent,
          {
            id: "paper",
            filled: quantity,
            average: executionPrice,
            fee,
            status: "closed",
          },
          s,
          "active",
        );
      position.paper = paper;
      b.positions.push(position);
      this.save("paper", b);
      this.syncPaperFeed();
      this.store.log(
        "TRADE",
        `Віртуальний вхід ${signal.symbol} ${direction}: стакан ${executionPrice}, taker ${paper!.takerRate * 100}%, isolated ${paper!.initialMargin} USDT`,
      );
      return;
    }
    b.pending.push(intent);
    this.save("live", b); // Durable intent always precedes the exchange request.
    try {
      const fill = await this.gateway.submit(intent, s);
      if (fill.id) intent.orderId = fill.id;
      this.save("live", b);
      if (
        ["closed", "canceled"].includes(fill.status) &&
        fill.filled > 0 &&
        fill.average > 0
      )
        await this.adoptEntry(b, intent, fill, s);
      else
        this.pause(
          `Ордер ${intent.id}: очікуємо підтвердження виконання; нові входи призупинено`,
        );
    } catch (e: any) {
      if (definitiveRejection(e)) {
        b.pending = b.pending.filter((p) => p.id !== intent.id);
        this.store.log("ERROR", `${signal.symbol}: ${exchangeError(e)}`);
      } else {
        intent.error =
          "Результат надсилання невідомий; повторний ордер не надсилається";
        this.pause(
          `${signal.symbol}: невідомий результат ордера. Потрібна синхронізація з біржею`,
        );
      }
      this.save("live", b);
      throw new Error(exchangeError(e));
    }
  }
  private position(
    intent: Intent,
    fill: Fill,
    s: Settings,
    status: Position["status"],
  ): Position {
    const openedAt = fill.at || intent.createdAt;
    return {
      id: intent.id,
      exchange: intent.exchange,
      symbol: intent.symbol,
      direction: intent.direction,
      formation: intent.signal.formation,
      timeframe: intent.signal.timeframe,
      quantity: fill.filled,
      originalQuantity: fill.filled,
      entryPrice: fill.average,
      currentPrice: fill.average,
      stopLoss: intent.stopLoss,
      takeProfit: intent.takeProfit,
      openedAt,
      expiresAt: intent.signal.strategyId === EV_TEST_ID
        ? openedAt + this.evTestRiskSettings().maxHoldMinutes * 60_000
        : (s.maxHoldingSeconds ? openedAt + s.maxHoldingSeconds * 1000 : 0),
      entryFee: fill.fee,
      entryOrderId: fill.id,
      intent,
      guards: [],
      status,
      unrealizedPnl: 0,
    };
  }
  private async adoptEntry(b: Book, intent: Intent, fill: Fill, s: Settings) {
    const p = this.position(intent, fill, s, "protecting");
    b.pending = b.pending.filter((x) => x.id !== intent.id);
    b.positions.push(p);
    this.save("live", b);
    try {
      await this.gateway.protection(intent, p.quantity, (id) => {
        if (!p.guards.includes(id)) p.guards.push(id);
        this.save("live", b);
      });
      if (intent.exchange === "bybit") {
        const account = await this.gateway.account(intent.exchange),
          venue = account.positions.find((x) => x.symbol === p.symbol);
        if (!venue || venue.stopLoss <= 0 || venue.takeProfit <= 0)
          throw new Error("Захисні рівні Bybit не підтверджені");
      }
      p.status = "active";
      this.save("live", b);
      this.store.log(
        "TRADE",
        `Реальний вхід ${p.symbol} ${p.direction}: виконання та TP/SL підтверджено`,
      );
    } catch {
      this.pause(
        `${p.symbol}: TP/SL не підтверджено. Запитуємо аварійне reduce-only закриття`,
      );
      await this.closeLive(b, p, "PROTECTION_FAILED", s);
    }
  }
  closePosition(id: string) {
    return this.mutex.run(async () => {
      const s = this.settings(),
        b = this.book(s.mode),
        p = b.positions.find((x) => x.id === id);
      if (!p) throw new Error("Позицію не знайдено");
      if (s.mode === "paper") {
        try { await this.ensurePaper(p); await this.finishPaper(b, p, p.currentPrice, "MANUAL"); }
        finally { this.save("paper", b); this.syncPaperFeed(); }
      } else await this.closeLive(b, p, "MANUAL", s);
    });
  }
  private syncPaperFeed() {
    const positions = this.book("paper").positions;
    this.paperWatched = new Map(positions.map(p => [`${p.exchange}:${p.symbol}`, p]));
    if (this.running) this.feed.sync(positions);
    const ids = new Set(this.paperWatched.keys());
    for (const key of this.paperTicks.keys()) if (!ids.has(key)) this.paperTicks.delete(key);
    const positionIds = new Set(positions.map(p => p.id));
    for (const id of this.paperErrorLog.keys()) if (!positionIds.has(id)) this.paperErrorLog.delete(id);
  }
  private paperTick(exchange: Exchange, symbol: string, tick: PriceTick) {
    const key = `${exchange}:${symbol}`, previous = this.paperTicks.get(key);
    if (tick.last !== undefined && tick.at < (previous?.lastAt || 0)) tick = { ...tick, last: undefined };
    if (tick.mark !== undefined && tick.at < (previous?.markAt || 0)) tick = { ...tick, mark: undefined };
    tick = { at: tick.at, ...(tick.last !== undefined ? { last: tick.last } : {}), ...(tick.mark !== undefined ? { mark: tick.mark } : {}) };
    const current = { ...previous, ...tick,
      lastAt: tick.last !== undefined ? tick.at : previous?.lastAt,
      markAt: tick.mark !== undefined ? tick.at : previous?.markAt };
    const p = this.paperWatched.get(key);
    if (p?.paper && !current.trigger) {
      try {
        if (tick.mark !== undefined && liquidatable(p, p.paper, tick.mark)) current.trigger = { reason: "LIQUIDATION", at: tick.at, reference: tick.mark };
        else if (tick.last !== undefined) {
          const reason = p.direction === "LONG"
            ? tick.last <= p.stopLoss ? "SL" : tick.last >= p.takeProfit ? "TP" : ""
            : tick.last >= p.stopLoss ? "SL" : tick.last <= p.takeProfit ? "TP" : "";
          if (reason) current.trigger = { reason, at: tick.at, reference: tick.last };
        }
      } catch { this.paperGaps.add(key); }
    }
    this.paperTicks.set(key, current);
    if (current.trigger) void this.monitor();
  }
  private async newPaperState(s: Settings, symbol: string, reference: number, quantity: number): Promise<PaperState> {
    const fee = s.paperFeeMode === "manual" ? { rate: s.takerFeePercent / 100, at: Date.now(), source: "manual" } : await this.gateway.takerRate(s.exchange, symbol);
    const [tiers, state] = await Promise.all([
      s.exchange === "binance" ? this.gateway.riskTiers(symbol) : this.market.getPublicRiskTiers(symbol),
      this.market.getContractState(s.exchange, symbol),
    ]);
    this.checkContractState(state);
    if (!Number.isFinite(fee.rate) || fee.rate < 0 || fee.rate > 0.01) throw new Error("Немає коректної комісії");
    return { version: 1, marginMode: "isolated", leverage: s.leverage, initialMargin: reference * quantity / s.leverage,
      marginBalance: reference * quantity / s.leverage,
      takerRate: fee.rate, feeSource: fee.source, feeAt: fee.at, latencyMs: s.paperLatencyMs,
      tiers: validTiers(tiers), riskAt: Date.now(), entryReference: reference, entrySlippage: 0,
      markPrice: state.mark, liquidationPrice: 0, nextFundingAt: state.nextFundingAt,
      fundingCost: 0, fundingEvents: [], fundingCheckedAt: Date.now() - 1,
      lastObservedAt: Date.now(), lastMarkAt: state.at, lastTradeAt: state.at, warnings: [] };
  }
  private checkContractState(state: { at: number; mark: number; last: number; nextFundingAt: number }) {
    if (!Number.isFinite(state.at) || Math.abs(Date.now() - state.at) > 5000 ||
      !Number.isFinite(state.mark) || state.mark <= 0 || !Number.isFinite(state.last) || state.last <= 0 ||
      !Number.isSafeInteger(state.nextFundingAt) || state.nextFundingAt < Date.now() - 60000)
      throw new Error("Немає свіжих mark price та параметрів funding");
  }
  private async ensurePaper(p: Position) {
    if (p.paper) return;
    p.paper = await this.newPaperState({ ...this.settings(), exchange: p.exchange }, p.symbol, p.entryPrice, p.quantity);
    p.paper.fundingCheckedAt = p.openedAt - 1;
    p.paper.warnings.push("legacy-entry-not-reconstructed");
  }
  private async settlePaperFunding(b: Book, p: Position, until: number) {
    const state = p.paper!;
    if (until <= state.fundingCheckedAt) return;
    const backfill = state.warnings.includes("legacy-entry-not-reconstructed") && state.fundingCheckedAt < p.openedAt;
    if (!backfill && until < state.nextFundingAt) { state.fundingCheckedAt = until; return; }
    const from = Math.max(p.openedAt, state.fundingCheckedAt + 1), end = Math.min(until, from + 31 * 86400_000);
    const events = await this.market.getFundingEvents(p.exchange, p.symbol, from, end);
    if (state.nextFundingAt >= from && state.nextFundingAt <= end && !events.some(e => e.at === state.nextFundingAt))
      throw new Error("Нарахування funding ще не опубліковане; результат очікує звірки");
    for (const e of events) {
      if (e.at < from || e.at > end || state.fundingEvents.some(x => x.at === e.at)) continue;
      const cost = e.rate * e.price * p.quantity * (p.direction === "LONG" ? 1 : -1);
      if (!Number.isFinite(cost)) throw new Error("Некоректна сума funding");
      const reserved = b.positions.reduce((sum, pos) => sum + (pos.paper?.marginBalance ?? pos.entryPrice * pos.quantity / this.settings().leverage), 0);
      const available = Math.max(0, b.balance - reserved);
      state.marginBalance = Math.max(0, (state.marginBalance ?? state.initialMargin) - Math.max(0, cost - available));
      state.fundingEvents.push({ ...e, cost }); state.fundingCost += cost; b.balance -= cost;
      if (e.priceSource !== "settlement-mark" && !state.warnings.includes("funding-mark-estimate")) state.warnings.push("funding-mark-estimate");
    }
    state.fundingCheckedAt = end;
    const current = await this.market.getContractState(p.exchange, p.symbol);
    this.checkContractState(current);
    state.nextFundingAt = current.nextFundingAt;
    this.save("paper", b);
    if (end < until) throw new Error("Відновлюється історія funding; наступний пакет у наступному циклі");
  }
  private async monitorPaper(b: Book, p: Position) {
    await this.ensurePaper(p);
    const state = p.paper!, key = `${p.exchange}:${p.symbol}`, tick = this.paperTicks.get(key);
    if (state.closeFill) { await this.finishPaper(b, p, state.closeFill.reference, state.closeFill.reason); return; }
    if (Date.now() - state.lastObservedAt > 15000 && !state.warnings.includes("monitoring-gap")) state.warnings.push("monitoring-gap");
    if (this.paperGaps.delete(key) && !state.warnings.includes("stream-gap")) state.warnings.push("stream-gap");
    let last = tick?.last, mark = tick?.mark;
    if (!this.running || !last || !mark || Date.now() - (tick?.markAt || 0) > 5000 || Date.now() - (tick?.lastAt || 0) > 15000) {
      const current = await this.market.getContractState(p.exchange, p.symbol); this.checkContractState(current);
      last = current.last; mark = current.mark;
      state.nextFundingAt = Math.min(state.nextFundingAt, current.nextFundingAt);
      state.lastMarkAt = state.lastTradeAt = current.at;
      const arrived = this.paperTicks.get(key);
      if (arrived?.last !== undefined && (arrived.lastAt || 0) > current.at) last = arrived.last;
      if (arrived?.mark !== undefined && (arrived.markAt || 0) > current.at) mark = arrived.mark;
      this.paperTicks.set(key, { ...arrived, at: Math.max(current.at, arrived?.at || 0), last, mark,
        lastAt: Math.max(current.at, arrived?.lastAt || 0), markAt: Math.max(current.at, arrived?.markAt || 0) });
    } else { state.lastMarkAt = tick.markAt; state.lastTradeAt = tick.lastAt; }
    state.markPrice = mark; state.lastObservedAt = Date.now(); p.currentPrice = last;
    if (Date.now() - state.riskAt > 600_000) {
      try {
        state.tiers = validTiers(await (p.exchange === "binance" ? this.gateway.riskTiers(p.symbol) : this.market.getPublicRiskTiers(p.symbol)));
        state.riskAt = Date.now();
      } catch { if (!state.warnings.includes("risk-snapshot-stale")) state.warnings.push("risk-snapshot-stale"); }
    }
    p.unrealizedPnl = (mark - p.entryPrice) * p.quantity * (p.direction === "LONG" ? 1 : -1);
    const tp = p.direction === "LONG" ? last >= p.takeProfit : last <= p.takeProfit;
    const sl = p.direction === "LONG" ? last <= p.stopLoss : last >= p.stopLoss;
    state.closeTrigger ||= this.paperTicks.get(key)?.trigger;
    if (!state.closeTrigger && liquidatable(p, state, mark)) state.closeTrigger = { reason: "LIQUIDATION", at: Date.now(), reference: mark };
    if (!state.closeTrigger && (tp || sl || (p.expiresAt > 0 && Date.now() >= p.expiresAt)))
      state.closeTrigger = { reason: tp ? "TP" : sl ? "SL" : "TIME", at: Date.now(), reference: last };
    if (state.closeTrigger) { this.save("paper", b); await this.finishPaper(b, p, state.closeTrigger.reference, state.closeTrigger.reason); return; }
    await this.settlePaperFunding(b, p, Date.now());
    state.liquidationPrice = liquidationPrice(p, state);
    if (liquidatable(p, state, mark)) await this.finishPaper(b, p, mark, "LIQUIDATION");
  }
  private async finishPaper(b: Book, p: Position, reference: number, reason: string) {
    const state = p.paper!;
    state.closeTrigger ||= { reason, at: Date.now(), reference };
    reason = state.closeTrigger.reason; reference = state.closeTrigger.reference;
    if (!state.closeFill) {
      if (state.latencyMs) await new Promise(resolve => setTimeout(resolve, state.latencyMs));
      let price: number;
      if (reason === "LIQUIDATION") {
        await this.settlePaperFunding(b, p, Date.now());
        price = p.entryPrice - (p.direction === "LONG" ? 1 : -1) * Math.max(0, state.marginBalance ?? state.initialMargin - state.fundingCost) / p.quantity;
      } else {
        const book = await this.market.getExecutionBook(p.exchange, p.symbol);
        price = depthFill(book, p.direction === "LONG" ? "sell" : "buy", p.originalQuantity);
      }
      state.closeFill = { price, at: Date.now(), reference, reason,
        slippage: reason === "LIQUIDATION" ? 0 : (reference - price) * p.quantity * (p.direction === "LONG" ? 1 : -1) };
      if (Math.abs(state.closeFill.at - state.nextFundingAt) <= 5000 && !state.warnings.includes("funding-boundary-estimate")) state.warnings.push("funding-boundary-estimate");
      p.status = "closing"; this.save("paper", b);
      p.currentPrice = price;
      p.unrealizedPnl = (price - p.entryPrice) * p.quantity * (p.direction === "LONG" ? 1 : -1);
      this.save("paper", b);
    }
    const fill = state.closeFill;
    if (fill.takerRate === undefined && fill.reason !== "LIQUIDATION") {
      const fee = state.feeSource === "manual" ? { rate: state.takerRate, source: "manual", at: state.feeAt }
        : await this.gateway.takerRate(p.exchange, p.symbol, true);
      if (!Number.isFinite(fee.rate) || fee.rate < 0 || fee.rate > 0.01) throw new Error("Немає коректного тарифу закриття");
      fill.takerRate = fee.rate; fill.feeSource = fee.source; fill.feeAt = fee.at;
      this.save("paper", b);
    }
    await this.settlePaperFunding(b, p, fill.at);
    const price = fill.price;
    const gross =
      (price - p.entryPrice) *
      p.originalQuantity *
      (p.direction === "LONG" ? 1 : -1);
    const exitFee = fill.reason === "LIQUIDATION" ? 0 : price * p.originalQuantity * fill.takerRate!;
    b.balance += gross - exitFee;
    b.history.unshift({
      id: p.id,
      exchange: p.exchange,
      symbol: p.symbol,
      direction: p.direction,
      formation: p.formation,
      timeframe: p.timeframe || p.intent?.signal?.timeframe,
      signalDirection: p.intent?.signal?.direction,
      signalConfidence: p.intent?.signal?.confidence,
      signalStatus: p.intent?.signal?.status,
      entryPrice: p.entryPrice,
      exitPrice: price,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      quantity: p.originalQuantity,
      grossPnl: gross,
      fee: p.entryFee + exitFee,
      netPnl: gross - p.entryFee - exitFee - state.fundingCost,
      openedAt: p.openedAt,
      closedAt: fill.at,
      reason: fill.reason,
      estimated: true,
      entryFee: p.entryFee, exitFee, fundingCost: state.fundingCost, fundingComplete: true,
      entrySlippage: state.entrySlippage, exitSlippage: fill.slippage,
      executionSource: fill.reason === "LIQUIDATION" ? "isolated-bankruptcy-model" : "orderbook-vwap",
      paper: state,
    });
    b.history = b.history.slice(0, 1000);
    b.positions = b.positions.filter((x) => x.id !== p.id);
    this.store.log(
      "TRADE",
      `Віртуальне закриття ${p.symbol}: ${reason}, ціна ${price}`,
    );
  }
  private async closeLive(b: Book, p: Position, reason: string, s: Settings) {
    if (!this.liveAllowed)
      throw new Error("Реальні запити вимкнено на сервері");
    if (b.pending.some((x) => x.positionId === p.id)) return;
    const account = await this.gateway.account(p.exchange),
      venue = account.positions.find((x) => x.symbol === p.symbol);
    if (!venue) {
      await this.finishLive(b, p, reason);
      return;
    }
    if (
      venue.direction !== p.direction ||
      venue.quantity > p.originalQuantity * 1.000001
    ) {
      this.pause(`${p.symbol}: позицію змінено поза ботом; потрібна перевірка`);
      return;
    }
    const intent: Intent = {
      ...p.intent,
      id: orderId(),
      createdAt: Date.now(),
      quantity: venue.quantity,
      kind: "close",
      positionId: p.id,
      reason,
      orderId: undefined,
    };
    p.status = "closing";
    b.pending.push(intent);
    this.save("live", b);
    try {
      const fill = await this.gateway.submit(intent, s);
      intent.orderId = fill.id || undefined;
      this.save("live", b);
      // Acknowledgement, including a filled market response, is not proof that the position is now flat.
      if (["closed", "canceled", "rejected"].includes(fill.status))
        b.pending = b.pending.filter((x) => x.id !== intent.id);
      this.save("live", b);
    } catch (e: any) {
      intent.error = "Закриття очікує звірки з біржею";
      this.pause(
        `${p.symbol}: ${exchangeError(e)} під час закриття; позицію не позначено закритою`,
      );
      this.save("live", b);
    }
  }
  private async finishLive(b: Book, p: Position, reason: string) {
    p.status = "reconciling";
    this.save("live", b);
    await this.gateway.cancelProtection(
      p.exchange,
      p.symbol,
      p.guards,
      p.intent.id,
    );
    const trades = await this.gateway.closingTrades(
      p.exchange,
      p.symbol,
      p.openedAt,
      p.direction,
    );
    const unique = [
      ...new Map(
        trades
          .filter((t) => t.side === (p.direction === "LONG" ? "sell" : "buy"))
          .map((t) => [t.id, t]),
      ).values(),
    ];
    const total = unique.reduce((sum, t) => sum + t.quantity, 0);
    if (!sameQuantity(total, p.originalQuantity)) {
      this.pause(
        `${p.symbol}: позиція на біржі закрита, очікуємо повну історію виконань для P&L`,
      );
      return;
    }
    const exit =
      unique.reduce((sum, t) => sum + t.price * t.quantity, 0) / total;
    const entryFills = trades.filter((t) => t.orderId === p.entryOrderId);
    const entryFee = entryFills.length
      ? entryFills.reduce((sum, t) => sum + t.fee, 0)
      : p.entryFee;
    const gross =
        (exit - p.entryPrice) * total * (p.direction === "LONG" ? 1 : -1),
      fee = entryFee + unique.reduce((sum, t) => sum + t.fee, 0);
    const closedAt = Math.max(...unique.map(t => t.at));
    let fundingCost: number | undefined;
    try { fundingCost = await this.gateway.fundingCost(p.exchange, p.symbol, p.openedAt, closedAt); } catch { /* Never report unavailable funding as a verified zero. */ }
    b.history.unshift({
      id: p.id,
      exchange: p.exchange,
      symbol: p.symbol,
      direction: p.direction,
      formation: p.formation,
      timeframe: p.timeframe || p.intent?.signal?.timeframe,
      signalDirection: p.intent?.signal?.direction,
      signalConfidence: p.intent?.signal?.confidence,
      signalStatus: p.intent?.signal?.status,
      entryPrice: p.entryPrice,
      exitPrice: exit,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      quantity: total,
      grossPnl: gross,
      fee,
      netPnl: gross - fee - (fundingCost || 0),
      entryFee, exitFee: fee - entryFee, fundingCost,
      fundingComplete: fundingCost !== undefined && Date.now() - closedAt >= 60000,
      fundingCheckedAt: Date.now(), executionSource: "venue-fills",
      openedAt: p.openedAt,
      closedAt,
      reason,
      estimated: false,
      feesComplete:
        entryFills.length > 0 &&
        [...entryFills, ...unique].every((t) => t.feeKnown),
    });
    b.history = b.history.slice(0, 1000);
    b.positions = b.positions.filter((x) => x.id !== p.id);
    b.pending = b.pending.filter((x) => x.positionId !== p.id);
    this.save("live", b);
    this.store.log(
      "TRADE",
      `Реальне закриття ${p.symbol}: відсутність позиції та виконання підтверджено`,
    );
  }
  private async reconcileLive(b: Book, s: Settings) {
    let account = await this.gateway.account(s.exchange);
    b.balance = account.total;
    if (!b.accountAt) b.startBalance = account.total;
    b.accountAt = Date.now();
    this.save("live", b);
    if (!this.liveAllowed) {
      if (this.settings().autoEntries)
        this.pause(
          "Реальні зміни на біржі вимкнено серверним параметром ENABLE_LIVE_TRADING; доступне лише читання",
        );
      return;
    }
    for (const intent of [...b.pending]) {
      const fill = await this.gateway.read(intent);
      if (!fill) continue; // Unknown submissions are never blindly repeated.
      if (intent.kind === "entry") {
        if (
          ["closed", "canceled"].includes(fill.status) &&
          fill.filled > 0 &&
          fill.average > 0
        ) {
          await this.adoptEntry(b, intent, fill, s);
          account = await this.gateway.account(s.exchange);
        } else if (
          ["canceled", "rejected", "expired"].includes(fill.status) &&
          fill.filled === 0
        ) {
          b.pending = b.pending.filter((x) => x.id !== intent.id);
          this.save("live", b);
        }
      } else if (
        ["closed", "canceled", "rejected", "expired"].includes(fill.status)
      ) {
        b.pending = b.pending.filter((x) => x.id !== intent.id);
        this.save("live", b);
      }
    }
    for (const p of [...b.positions]) {
      // Re-fetch after recovering an entry; the first snapshot may predate its execution.
      const fresh =
        b.accountAt! < p.openedAt + 2000
          ? await this.gateway.account(p.exchange)
          : account;
      const venue = fresh.positions.find((x) => x.symbol === p.symbol);
      if (!venue) {
        await this.finishLive(b, p, "EXCHANGE");
        continue;
      }
      if (
        venue.direction !== p.direction ||
        !sameQuantity(venue.quantity, p.quantity)
      ) {
        if (
          p.status === "closing" &&
          venue.direction === p.direction &&
          venue.quantity < p.quantity
        )
          p.quantity = venue.quantity;
        else {
          this.pause(
            `${p.symbol}: кількість або напрям позиції не збігаються з біржею`,
          );
          continue;
        }
      }
      p.currentPrice = venue.currentPrice;
      p.unrealizedPnl =
        (venue.currentPrice - p.entryPrice) *
        venue.quantity *
        (p.direction === "LONG" ? 1 : -1);
      this.save("live", b);
      if (p.status === "protecting") {
        await this.closeLive(b, p, "PROTECTION_FAILED", s);
        continue;
      }
      if (
        p.status === "closing" ||
        (p.expiresAt > 0 && Date.now() >= p.expiresAt)
      )
        await this.closeLive(
          b,
          p,
          p.status === "closing" ? "MANUAL" : "TIME",
          s,
        );
    }
    this.save("live", b);
  }
  resetPaper() {
    return this.mutex.run(async () => {
      const b = this.book("paper");
      if (b.positions.length)
        throw new Error("Спочатку закрийте віртуальні позиції");
      this.save("paper", newBook("paper", this.settings().initialBalance));
    });
  }
}
