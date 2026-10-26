import { randomBytes } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  FORMATION_ANALYSIS_VERSION,
  validateSettings,
  type Settings,
  type Signal,
  type Mode,
  type Exchange,
} from "./config";
import { Mutex, type Store } from "./store";
import { formationIsVisible, signalAllowsEntry } from "./formationState";
import type { MarketData } from "./market";
import type { Vault } from "./security";
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
};
type Book = {
  balance: number;
  startBalance: number;
  positions: Position[];
  history: any[];
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
  constructor(
    private store: Store,
    private market: MarketData,
    private vault: Vault,
    private gateway: ExchangeGateway,
    readonly liveAllowed: boolean,
  ) {}
  settings() {
    return this.store.get("settings", DEFAULT_SETTINGS);
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
    this.timer = setInterval(() => {
      void this.monitor();
    }, 5000);
    void this.monitor();
  }
  async stop() {
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
          if (
            s.mode === "live" &&
            (b.positions.length || b.pending.length || s.autoEntries)
          )
            await this.reconcileLive(b, s);
          if (s.mode === "paper" && b.positions.length) {
            const quotes = await this.market.getPrices(s.exchange);
            for (const p of [...b.positions]) {
              const price = quotes.data[p.symbol];
              if (!price) continue;
              p.currentPrice = price;
              p.unrealizedPnl =
                (p.direction === "LONG" ? 1 : -1) *
                (price - p.entryPrice) *
                p.quantity;
              const tp =
                p.direction === "LONG"
                  ? price >= p.takeProfit
                  : price <= p.takeProfit;
              const sl =
                p.direction === "LONG"
                  ? price <= p.stopLoss
                  : price >= p.stopLoss;
              if (tp || sl || (p.expiresAt > 0 && Date.now() >= p.expiresAt))
                this.finishPaper(b, p, price, tp ? "TP" : sl ? "SL" : "TIME");
            }
            this.save("paper", b);
          }
          if (
            s.autoEntries &&
            !b.pending.length &&
            Date.now() - b.lastEntryAt >= s.entryIntervalSeconds * 1000
          ) {
            b.lastEntryAt = Date.now();
            this.save(s.mode, b);
            const signals = this.snapshot()
              .signals.filter(
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
                !this.settings().autoEntries
              )
                break;
              try {
                await this.enterLocked(signal, true);
              } catch {
                /* A rejected signal is retried only after the next configured entry interval. */
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
      const signal = this.store
        .get<Signal[]>("signals", [])
        .find((x) => x.id === signalId);
      if (!signal) throw new Error("Сигнал відсутній або вже застарів");
      await this.enterLocked(signal, false);
    });
  }
  private async enterLocked(signal: Signal, automatic: boolean) {
    const s = this.settings(),
      b = this.book(s.mode),
      now = Date.now();
    if (signal.analysisVersion !== FORMATION_ANALYSIS_VERSION || !Number.isInteger(signal.confidence) ||
      signal.confidence < 0 || signal.confidence > 100)
      throw new Error("Сигнал потребує нового сканування та оцінювання");
    if (
      signal.exchange !== s.exchange ||
      !s.timeframes.includes(signal.timeframe) ||
      !s.formationTypes.includes(signal.formation) ||
      signal.confidence < s.minScore ||
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
    const direction = s.reverseEnabled
      ? signal.direction === "LONG"
        ? "SHORT"
        : "LONG"
      : signal.direction;
    const sign = direction === "LONG" ? 1 : -1;
    const stopLoss = price * (1 - (sign * s.stopLossPercent) / 100),
      takeProfit = price * (1 + (sign * s.takeProfitPercent) / 100);
    let quantity: number;
    if (s.mode === "paper") {
      const market = (await this.market.getMarkets(s.exchange)).find(
        (m) => m.symbol === signal.symbol,
      );
      if (!market) throw new Error("Контракт більше не торгується");
      quantity = Number(
        (
          Math.floor(
            s.orderNotionalUsdt / price / market.quantityStep + 1e-10,
          ) * market.quantityStep
        ).toPrecision(12),
      );
      const reserved = b.positions.reduce(
        (sum, p) => sum + (p.entryPrice * p.quantity) / s.leverage,
        0,
      );
      if (
        quantity < market.minQuantity ||
        quantity * price < market.minNotional ||
        b.balance - reserved <
          (quantity * price) / s.leverage +
            (quantity * price * s.takerFeePercent) / 100
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
      if (account.free < (s.orderNotionalUsdt / s.leverage) * 1.03)
        throw new Error("Недостатньо вільної маржі на біржі");
      quantity = await this.gateway.quantity(
        s.exchange,
        signal.symbol,
        price,
        s.orderNotionalUsdt,
      );
      await this.gateway.prepare(s.exchange, signal.symbol, s.leverage);
    }
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
      const fee = (price * quantity * s.takerFeePercent) / 100;
      b.balance -= fee;
      b.positions.push(
        this.position(
          intent,
          {
            id: "paper",
            filled: quantity,
            average: price,
            fee,
            status: "closed",
          },
          s,
          "active",
        ),
      );
      this.save("paper", b);
      this.store.log(
        "TRADE",
        `Віртуальний вхід ${signal.symbol} ${direction}, ціна ${price}`,
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
      expiresAt: s.maxHoldingSeconds
        ? openedAt + s.maxHoldingSeconds * 1000
        : 0,
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
        const quotes = await this.market.getPrices(s.exchange);
        const price = quotes.data[p.symbol];
        if (!price) throw new Error("Немає поточної ціни");
        this.finishPaper(b, p, price, "MANUAL");
        this.save("paper", b);
      } else await this.closeLive(b, p, "MANUAL", s);
    });
  }
  private finishPaper(b: Book, p: Position, price: number, reason: string) {
    const gross =
      (price - p.entryPrice) *
      p.originalQuantity *
      (p.direction === "LONG" ? 1 : -1);
    const exitFee =
      (price * p.originalQuantity * this.settings().takerFeePercent) / 100;
    b.balance += gross - exitFee;
    b.history.unshift({
      id: p.id,
      exchange: p.exchange,
      symbol: p.symbol,
      direction: p.direction,
      formation: p.formation,
      timeframe: p.timeframe || p.intent?.signal?.timeframe,
      entryPrice: p.entryPrice,
      exitPrice: price,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      quantity: p.originalQuantity,
      grossPnl: gross,
      fee: p.entryFee + exitFee,
      netPnl: gross - p.entryFee - exitFee,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      reason,
      estimated: true,
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
    b.history.unshift({
      id: p.id,
      exchange: p.exchange,
      symbol: p.symbol,
      direction: p.direction,
      formation: p.formation,
      timeframe: p.timeframe || p.intent?.signal?.timeframe,
      entryPrice: p.entryPrice,
      exitPrice: exit,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      quantity: total,
      grossPnl: gross,
      fee,
      netPnl: gross - fee,
      openedAt: p.openedAt,
      closedAt: Math.max(...unique.map((t) => t.at)),
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
