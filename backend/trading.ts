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
import { isInsideHookPlan, type HookFormationSources } from "./hookFormationSources";
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
  closeReason?: string;
  intent: Intent;
  guards: string[];
  protectionCheck?: { at:number; status:"verified"|"missing"|"unknown" };
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
  private rejectedEntries = new Map<string, number>();
  private autoDecisions=new Map<string,{at:number;reason:string;state:"skipped"|"opened"|"pending"}>();
  private recordAutoDecision(id:string,state:"skipped"|"opened"|"pending",reason:string) {
    this.autoDecisions.delete(id);
    this.autoDecisions.set(id,{at:Date.now(),state,reason});
    while(this.autoDecisions.size>300) this.autoDecisions.delete(this.autoDecisions.keys().next().value!);
  }
  private monitoring = false;
  private stopping=false;
  private reconciliationWarnings=new Map<string,number>();
  private entryPauseRequested=false;
  private pauseEpoch=0;
  private running = false;
  private lastLiveCycle = 0;
  private monitorStartedAt=0;
  private monitorFinishedAt=0;
  private monitorDurationMs=0;
  private monitorMaxDurationMs=0;
  private monitorCycles=0;
  private monitorSkipped=0;
  private lastAutoAttemptAt=0;
  private paperGaps = new Set<string>();
  private paperErrorLog = new Map<string, number>();
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
    private sources?: HookFormationSources,
  ) {}
  settings() {
    const saved = this.store.get<Partial<Settings>>("settings", {});
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved };
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
  private paperMonitoringReady(b:Book,mode:Mode) {
    return mode!=="paper" || b.positions.every(p=>p.paper && !p.paper.closeTrigger &&
      Number.isFinite(p.paper.lastObservedAt) && Date.now()-p.paper.lastObservedAt<=15_000 &&
      !this.paperGaps.has(`${p.exchange}:${p.symbol}`));
  }
  private protectionReady(b:Book,mode:Mode) {
    return mode!=="live" || b.positions.every(p=>p.status!=="active" ||
      (p.protectionCheck?.status==="verified" && Date.now()-p.protectionCheck.at<90_000));
  }
  private pause(message: string) {
    this.entryPauseRequested=true;
    this.pauseEpoch++;
    this.store.set("settings", { ...this.settings(), autoEntries: false });
    this.store.log("ERROR", message);
  }
  updateSettings(input: unknown) {
    const requested=input && typeof input==="object" && !Array.isArray(input)?input as Partial<Settings>:null;
    // An explicit pause latches immediately, before waiting for network work in the trading queue.
    if(requested?.autoEntries===false) {
      this.entryPauseRequested=true;
      this.pauseEpoch++;
      // A restart during a queued pause must not restore previously enabled entries.
      this.store.set("settings",{...this.settings(),autoEntries:false});
    }
    const epoch=this.pauseEpoch;
    return this.mutex.run(async () => {
      const previous = this.settings(),
        next = validateSettings(input, previous);
      if (this.sources && next.timeframes.includes("30m") && !previous.timeframes.includes("30m"))
        throw new Error("Джерело h00k.top не підтримує формації 30m");
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
      if (this.sources && (next.exchange !== previous.exchange || next.hookRegularFormations !== previous.hookRegularFormations || next.hookEarlyFormations !== previous.hookEarlyFormations || next.hookMinVolumeUsd !== previous.hookMinVolumeUsd || next.timeframes.join(",") !== previous.timeframes.join(","))) {
        this.sources.invalidate();
        this.store.set("signals", []);
      }
      if(this.entryPauseRequested && (requested?.autoEntries!==true || epoch!==this.pauseEpoch))
        next.autoEntries=false;
      this.store.set("settings", next);
      if(requested?.autoEntries===true && next.autoEntries && epoch===this.pauseEpoch) this.entryPauseRequested=false;
      return next;
    });
  }
  saveCredentials(exchange: Exchange, apiKey: string, secret: string) {
    return this.mutex.run(async () => {
      if (this.hasLiveExposure() || this.settings().mode === "live")
        throw new Error("Спочатку закрийте реальні позиції та вимкніть реальний режим");
      this.vault.save(exchange,apiKey,secret);
      this.gateway.invalidate(exchange);
      return this.vault.status(exchange);
    });
  }
  removeCredentials(exchange: Exchange) {
    return this.mutex.run(async () => {
      if (this.hasLiveExposure() || this.settings().mode === "live")
        throw new Error("Спочатку закрийте реальні позиції та вимкніть реальний режим");
      this.vault.remove(exchange);
      this.gateway.invalidate(exchange);
      return this.vault.status(exchange);
    });
  }
  verifyCredentials(exchange: Exchange) {
    return this.mutex.run(async () => {
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
    });
  }
  snapshot() {
    const s = this.settings(),
      b = this.book(s.mode),
      pnl = b.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const history = b.history,
      wins = history.filter((t) => t.netPnl > 0).length;
    const now = Date.now();
    const formations = (this.sources ? this.sources.signals(s) : this.store.get<Signal[]>("signals", []))
      .filter((signal) => formationIsVisible(signal, s, now));
    const autoBlockReason=this.entryPauseRequested || !s.autoEntries?"Автоматичні входи вимкнено або запитано паузу"
      :!tradingScheduleState(s.tradingSchedule,now).allowed?"Поза торговим розкладом"
      :s.mode==="live" && (!this.liveAllowed || !this.vault.status(s.exchange).verified)?"Реальний режим або API не дозволено"
      :b.pending.length?"Очікування узгодження ордерів"
      :b.positions.some(p=>p.status!=="active")?"Позиції потребують узгодження"
      :!this.protectionReady(b,s.mode)?"Захист відкритої позиції потребує перевірки"
      :!this.paperMonitoringReady(b,s.mode)?"Симуляція очікує актуальних цін відкритих позицій"
      :b.positions.length>=s.maxPositions?"Досягнуто ліміт позицій"
      :now-b.lastEntryAt<s.entryIntervalSeconds*1000?"Інтервал між циклами входу"
      :null;
    return {
      settings: s,
      autoBlockReason,
      monitorHealth:{running:this.running,busy:this.monitoring,startedAt:this.monitorStartedAt||null,
        finishedAt:this.monitorFinishedAt||null,durationMs:this.monitorDurationMs,maxDurationMs:this.monitorMaxDurationMs,
        cycles:this.monitorCycles,skippedTicks:this.monitorSkipped,lastAutoAttemptAt:this.lastAutoAttemptAt||null},
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
        historyLimit:1000,
        provisionalTrades:history.filter(t=>!t.estimated && (t.feesComplete!==true || t.fundingComplete!==true)).length,
        accountAt: b.accountAt || null,
      },
      signals: this.sources?this.sources.eligibleSignals(s):formations.filter(signal=>signalAllowsEntry(signal,s,now)),
      formations: formations.map((signal) => {
        const reasons=this.sources?.entryReasons(signal,s)??(!signalAllowsEntry(signal,s,now)?["Сигнал не відповідає умовам входу"]:[]);
        if(b.used[signal.id]) reasons.push("Сигнал уже використано");
        if(b.positions.some(p=>p.symbol===signal.symbol)) reasons.push("Позиція по монеті вже відкрита");
        if(b.positions.length>=s.maxPositions) reasons.push("Досягнуто ліміт позицій");
        if(b.pending.length || b.positions.some(p=>p.status!=="active")) reasons.push("Очікування узгодження ордерів");
        if(!this.protectionReady(b,s.mode)) reasons.push("Захист відкритої позиції не підтверджено");
        if(!this.paperMonitoringReady(b,s.mode)) reasons.push("Очікування актуальних цін відкритих позицій");
        if(now-(b.lastEntries[signal.symbol]||0)<s.entryCooldownSeconds*1000) reasons.push("Пауза повторного входу");
        if(s.mode==="live" && (!this.liveAllowed || !this.vault.status(s.exchange).verified)) reasons.push("Реальний режим або API не дозволено");
        const last=this.autoDecisions.get(signal.id);
        return {...signal,canEnter:!reasons.length,entryReasons:reasons,
          lastAutoDecision:last && now-last.at<15*60_000?last:null};
      }),
      scanner: { ...this.store.get<any>("scanner", {}), ...(this.sources ? { sourceErrors: this.sources.diagnostics(s), sourceCounts: this.sources.counts(s), sourceCoverage: this.sources.coverage(s) } : {}) },
      logs: this.store.get<any[]>("logs", []),
      liveAllowed: this.liveAllowed,
      credentials: {
        binance: this.vault.status("binance"),
        bybit: this.vault.status("bybit"),
      },
    };
  }
  start() {
    if(this.running) return;
    this.stopping=false;
    this.running = true;
    // A protection observation from the previous process is not a new verification.
    const live=this.book("live");
    for(const p of live.positions) if(p.status==="active") p.protectionCheck={at:0,status:"unknown"};
    if(live.positions.length) this.save("live",live);
    this.syncPaperFeed();
    this.timer = setInterval(() => {
      void this.monitor();
    }, 1000);
    void this.monitor();
  }
  async stop() {
    this.stopping=true;
    this.running = false;
    this.feed.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.mutex.run(async () => {});
  }
  monitor() {
    if (this.monitoring) {this.monitorSkipped++;return Promise.resolve();}
    this.monitoring = true;
    this.monitorStartedAt=Date.now();
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
            for (const trade of b.history.filter(t => t.fundingComplete === false && Date.now() - t.closedAt >= 60000 && Date.now() - (t.fundingCheckedAt || 0) >= 60000).sort((a,z)=>(a.fundingCheckedAt||0)-(z.fundingCheckedAt||0)).slice(0, 1)) {
              trade.fundingCheckedAt = Date.now();
              try {
                const funding=await this.gateway.fundingCost(trade.exchange, trade.symbol, trade.openedAt!, trade.closedAt);
                if(!Number.isFinite(funding)) throw new Error("Некоректна сума funding");
                trade.fundingCost = funding;
                trade.fundingComplete = true;
                trade.netPnl = trade.grossPnl - trade.fee - trade.fundingCost;
              } catch { /* Keep the missing cost explicit and retry later. */ }
            }
            for(const trade of b.history.filter(t=>t.feesComplete===false && t.entryOrderId && t.closingFillIds?.length &&
              Date.now()-t.closedAt>=60_000 && Date.now()-(t.feesCheckedAt||0)>=60_000).sort((a,z)=>(a.feesCheckedAt||0)-(z.feesCheckedAt||0)).slice(0,1)) {
              trade.feesCheckedAt=Date.now();
              try { await this.recheckFees(trade); } catch { /* Retain provisional fees and retry later. */ }
            }
            this.save("live", b);
          }
          if (s.mode === "paper" && b.positions.length) {
            const urgency=(p:Position)=>p.paper?.closeTrigger || p.paper?.closeFill ||
              this.paperTicks.get(`${p.exchange}:${p.symbol}`)?.trigger ? 0 :
              p.expiresAt>0 && p.expiresAt<=Date.now()?1:2;
            const queue=[...b.positions].sort((a,z)=>urgency(a)-urgency(z) ||
              (a.paper?.lastObservedAt||0)-(z.paper?.lastObservedAt||0));
            for (const p of queue) {
              try { await this.monitorPaper(b, p); }
              catch (e: any) {
                this.paperGaps.add(`${p.exchange}:${p.symbol}`);
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
            !this.stopping && !this.entryPauseRequested && this.settings().autoEntries &&
            tradingScheduleState(s.tradingSchedule).allowed &&
            !b.pending.length &&
            b.positions.length < s.maxPositions &&
            b.positions.every(p=>p.status==="active") &&
            this.protectionReady(b,s.mode) &&
            this.paperMonitoringReady(b,s.mode) &&
            Date.now() - b.lastEntryAt >= s.entryIntervalSeconds * 1000
          ) {
            // The hot path needs only eligible signals, not a full UI/history snapshot.
            const signals = (this.sources?this.sources.eligibleSignals(s):
              this.store.get<Signal[]>("signals",[]).filter(signal=>signalAllowsEntry(signal,s)))
              .filter(
                (signal) =>
                  !b.used[signal.id] &&
                  !b.positions.some((p) => p.symbol === signal.symbol) &&
                  Date.now() - (b.lastEntries[signal.symbol] || 0) >= s.entryCooldownSeconds * 1000,
              )
              .sort((a, z) => z.confidence - a.confidence || z.candleAt-a.candleAt);
            if (!signals.length) return; // Do not consume an entry interval while the source is empty.
            b.lastEntryAt = Date.now();
            const maxAttempts = Math.min(
              signals.length,
              Math.max(10, s.maxPositions * 2),
            );
            const cursor =
              (b.candidateCursor || 0) % Math.max(1, signals.length);
            b.candidateCursor=cursor;
            this.save(s.mode,b);
            const cycleStarted=Date.now();
            for (let candidate = 0; candidate < maxAttempts; candidate++) {
              const signal = signals[(cursor + candidate) % signals.length];
              const currentBook=this.book(s.mode);
              if (
                currentBook.positions.length >= s.maxPositions ||
                currentBook.pending.length > 0 ||
                currentBook.positions.some(p => p.status !== "active") ||
                this.stopping || this.entryPauseRequested || !this.settings().autoEntries ||
                Date.now()-cycleStarted>=8000 ||
                !tradingScheduleState(this.settings().tradingSchedule).allowed
              )
                break;
              // Persist only the candidates actually attempted, not the entire planned batch.
              currentBook.candidateCursor=(cursor+candidate+1)%signals.length;
              this.save(s.mode,currentBook);
              try {
                this.lastAutoAttemptAt=Date.now();
                await this.enterLocked(signal, true);
                const current=this.book(s.mode);
                this.recordAutoDecision(signal.id,current.positions.some(p=>p.intent.signal.id===signal.id && p.status==="active")?"opened":"pending",
                  current.positions.some(p=>p.intent.signal.id===signal.id && p.status==="active")?"Позицію відкрито":"Результат виконання потребує узгодження");
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                // Do not expose raw exchange request URLs, signatures, API keys or response bodies.
                const reason = /^[А-Яа-яІіЇїЄєҐґ]/u.test(message) && !/https?:|api.?key|signature|secret|[{}]/i.test(message)
                  ? message.slice(0,180) : exchangeError(error);
                this.recordAutoDecision(signal.id,"skipped",reason);
                const key = signal.exchange + ":" + signal.symbol + ":" + reason;
                const at = Date.now();
                if (at - (this.rejectedEntries.get(key) || 0) >= 60_000) {
                  this.rejectedEntries.set(key, at);
                  this.store.log("WARN", signal.symbol + ": автоматичний вхід пропущено — " + reason);
                }
                if (this.rejectedEntries.size > 500) {
                  for (const [k, time] of this.rejectedEntries) if (at-time>=60_000) this.rejectedEntries.delete(k);
                  while (this.rejectedEntries.size>500) this.rejectedEntries.delete(this.rejectedEntries.keys().next().value!);
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
        this.monitorFinishedAt=Date.now();
        this.monitorDurationMs=Math.max(0,this.monitorFinishedAt-this.monitorStartedAt);
        this.monitorMaxDurationMs=Math.max(this.monitorMaxDurationMs,this.monitorDurationMs);
        this.monitorCycles++;
        this.monitoring = false;
      });
  }
  enter(signalId: string, expectedMode?: Mode, liveAcknowledged = false, expectedDirection?: unknown) {
    return this.mutex.run(async () => {
      const mode=this.settings().mode;
      if (expectedMode !== undefined && (mode !== expectedMode || (mode==="live" && !liveAcknowledged)))
        throw new Error("Торговий режим змінився або реальний ордер не підтверджено; повторіть запит");
      const signal = (this.sources ? this.sources.signals(this.settings()) : this.store.get<Signal[]>("signals", []))
        .find((x) => x.id === signalId);
      if (!signal) throw new Error("Сигнал відсутній або вже застарів");
      const direction=this.settings().reverseEnabled?(signal.direction==="LONG"?"SHORT":"LONG"):signal.direction;
      if(expectedDirection!==undefined && expectedDirection!==direction)
        throw new Error("Напрямок ордера змінився; перевірте реверсний режим і повторіть підтвердження");
      await this.enterLocked(signal, false);
    });
  }
  private async enterLocked(signal: Signal, automatic: boolean) {
    const s = this.settings(),
      b = this.book(s.mode),
      now = Date.now();
    if (this.sources && !this.sources.allowsEntry(signal, s)) throw new Error("Монета відсутня у свіжому дозволеному джерелі h00k.top");
    if (automatic && (this.stopping || this.entryPauseRequested || !s.autoEntries || !tradingScheduleState(s.tradingSchedule, now).allowed))
      throw new Error("Автоматичні входи призупинено або зараз поза торговим розкладом");
    if (signal.analysisVersion !== FORMATION_ANALYSIS_VERSION || !(signal.source === "hook_regular" ? Number.isFinite(signal.confidence) : Number.isInteger(signal.confidence)) ||
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
    if (b.pending.length || b.positions.some((p) => p.status !== "active") || !this.protectionReady(b,s.mode) || !this.paperMonitoringReady(b,s.mode))
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
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quotes.at) || Date.now() - quotes.at > 15_000 || quotes.at > Date.now()+2000)
      throw new Error("Немає свіжої ринкової ціни");
    if (
      (Math.abs(price - signal.entryPrice) / signal.entryPrice) * 100 >
      s.slippageTolerancePercent
    )
      throw new Error("Ціна відійшла від точки входу більше дозволеного");
    if (this.sources && !isInsideHookPlan(signal,price)) throw new Error("Ціна вже за межами торгового плану h00k");
    const direction = s.reverseEnabled
      ? signal.direction === "LONG"
        ? "SHORT"
        : "LONG"
      : signal.direction;
    const sign = direction === "LONG" ? 1 : -1;
    let stopLoss = price * (1 - (sign * s.stopLossPercent) / 100),
      takeProfit = price * (1 + (sign * s.takeProfitPercent) / 100);
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
            s.orderNotionalUsdt / price / market.quantityStep + 1e-10,
          ) * market.quantityStep
        ).toPrecision(12),
      );
      paper = await this.newPaperState(s, signal.symbol, price, quantity);
      if (paper.latencyMs) await new Promise(resolve => setTimeout(resolve, paper!.latencyMs));
      const book = await this.market.getExecutionBook(s.exchange, signal.symbol);
      executionPrice = depthFill(book, direction === "LONG" ? "buy" : "sell", quantity);
      if (quantity * executionPrice > s.orderNotionalUsdt) {
        quantity = Number((Math.floor(s.orderNotionalUsdt / executionPrice / market.quantityStep + 1e-10) * market.quantityStep).toPrecision(12));
        executionPrice = depthFill(book, direction === "LONG" ? "buy" : "sell", quantity);
      }
      if (Math.abs(executionPrice - signal.entryPrice) / signal.entryPrice * 100 > s.slippageTolerancePercent)
        throw new Error("Ціна виконання зі стакана перевищує допустиме відхилення");
      if (this.sources && !isInsideHookPlan(signal,executionPrice)) throw new Error("Ціна виконання вже за межами торгового плану h00k");
      const tier = paper.tiers.find(t => quantity * executionPrice <= t.cap);
      if (!tier || s.leverage > tier.maxLeverage || quantity * executionPrice > s.orderNotionalUsdt * 1.000001 ||
        (market.maxQuantity && quantity > market.maxQuantity)) throw new Error("Обсяг або плече перевищують біржовий ліміт");
      paper.closeFeeReserve = s.exchange === "bybit" ? executionPrice * quantity * (1 - sign / s.leverage) * paper.takerRate : 0;
      paper.initialMargin = executionPrice * quantity / s.leverage + paper.closeFeeReserve;
      paper.marginBalance = paper.initialMargin;
      if (Math.abs(Date.now() - paper.nextFundingAt) <= 5000) paper.warnings.push("funding-boundary-estimate");
      paper.entrySlippage = (executionPrice - price) * quantity * sign;
      paper.liquidationPrice = liquidationPrice({ direction, entryPrice: executionPrice, quantity }, paper);
      if (liquidatable({ direction, entryPrice: executionPrice, quantity }, paper, paper.markPrice)) throw new Error("Маржа недостатня вже при відкритті");
      stopLoss = executionPrice * (1 - sign * s.stopLossPercent / 100);
      takeProfit = executionPrice * (1 + sign * s.takeProfitPercent / 100);
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
      if (account.free < (s.orderNotionalUsdt / s.leverage) * 1.03)
        throw new Error("Недостатньо вільної маржі на біржі");
      quantity = await this.gateway.quantity(
        s.exchange,
        signal.symbol,
        price,
        s.orderNotionalUsdt,
      );
      await this.gateway.prepare(s.exchange, signal.symbol, s.leverage);
      if (this.sources) {
        const latest = await this.market.getPrices(s.exchange), nextPrice = latest.data[signal.symbol];
        if (!Number.isFinite(latest.at) || Date.now()-latest.at>15_000 || latest.at>Date.now()+2000 ||
          !isInsideHookPlan(signal,nextPrice) || Math.abs(nextPrice-signal.entryPrice)/signal.entryPrice*100>s.slippageTolerancePercent)
          throw new Error("Ціна змінилася під час підготовки ордера; вхід скасовано");
      }
    }
    // Quotes, account reads and exchange preparation may span the session boundary.
    if (Date.now() - signal.candleAt > s.maxSignalAgeSeconds * 1000) throw new Error("Сигнал застарів під час підготовки виконання");
    if (automatic && (this.stopping || this.entryPauseRequested || !this.settings().autoEntries || !tradingScheduleState(s.tradingSchedule).allowed))
      throw new Error("Автоматичний вхід призупинено або торгова сесія завершилася під час підготовки");
    if (this.sources && !this.sources.allowsEntry(signal, this.settings())) throw new Error("Формація h00k більше не актуальна; вхід скасовано");
    if(!this.paperMonitoringReady(b,s.mode) || !this.protectionReady(b,s.mode))
      throw new Error("Стан відкритих позицій потребує повторної перевірки");
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
      maxHoldingSeconds:s.maxHoldingSeconds,
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
        ["closed", "canceled", "expired", "rejected"].includes(fill.status) &&
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
    const holding=intent.maxHoldingSeconds??s.maxHoldingSeconds;
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
      expiresAt: holding
        ? openedAt + holding * 1000
        : 0,
      entryFee: fill.fee,
      entryOrderId: fill.id,
      intent,
      guards: [],
      status,
      unrealizedPnl: 0,
    };
  }
  private async verifyBybitProtection(p:Position,venue:{direction:string;quantity:number;stopLoss:number;takeProfit:number;protectionReported?:boolean}):Promise<"verified"|"missing"|"unknown"> {
    if(venue.protectionReported===false || !Number.isFinite(venue.stopLoss) || !Number.isFinite(venue.takeProfit)) return "unknown";
    if(venue.direction!==p.direction || !sameQuantity(venue.quantity,p.quantity)) return "unknown";
    if(venue.stopLoss<=0 || venue.takeProfit<=0) return "missing";
    const expected=await this.gateway.expectedProtection(p.intent);
    const matches=(a:number,b:number)=>Math.abs(a-b)<=Math.max(Number.EPSILON*Math.max(a,b)*8,Math.abs(b)*1e-10);
    return matches(venue.stopLoss,expected.stopLoss)&&matches(venue.takeProfit,expected.takeProfit)?"verified":"unknown";
  }
  private async adoptEntry(b: Book, intent: Intent, fill: Fill, s: Settings) {
    if(!fill.id || !Number.isFinite(fill.filled) || fill.filled<=0 ||
       fill.filled>intent.quantity+Math.max(1e-8,intent.quantity*1e-6) ||
       !Number.isFinite(fill.average) || fill.average<=0 || !Number.isFinite(fill.fee) ||
       (fill.at!==undefined && (!Number.isFinite(fill.at) || fill.at<=0 || fill.at>Date.now()+5000)))
      throw new Error("Некоректні дані виконання ордера; потрібна звірка");
    const p = this.position(intent, fill, s, "protecting");
    b.pending = b.pending.filter((x) => x.id !== intent.id);
    b.positions.push(p);
    this.save("live", b);
    try {
      const levels=await this.gateway.expectedProtection(intent);
      if(p.direction==="LONG"?!(levels.stopLoss<p.entryPrice && p.entryPrice<levels.takeProfit):
        !(levels.takeProfit<p.entryPrice && p.entryPrice<levels.stopLoss))
        throw new Error("Ціна виконання поза захисними рівнями");
      await this.gateway.protection(intent, p.quantity, (id) => {
        if (!p.guards.includes(id)) p.guards.push(id);
        this.save("live", b);
      });
      if (intent.exchange === "binance") {
        if(await this.gateway.checkProtection(intent,p.guards,p.quantity)!=="verified")
          throw new Error("Захисні ордери Binance не підтверджені");
      }
      if (intent.exchange === "bybit") {
        const account = await this.gateway.account(intent.exchange),
          venue = account.positions.find((x) => x.symbol === p.symbol);
        if (!venue || await this.verifyBybitProtection(p,venue)!=="verified")
          throw new Error("Захисні рівні Bybit не підтверджені");
      }
      p.status = "active";
      p.protectionCheck={at:Date.now(),status:"verified"};
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
  closePosition(id: string, expectedMode?: Mode, liveAcknowledged = false) {
    return this.mutex.run(async () => {
      const mode=this.settings().mode;
      if (expectedMode !== undefined && (mode !== expectedMode || (mode==="live" && !liveAcknowledged)))
        throw new Error("Торговий режим змінився або реальне закриття не підтверджено; повторіть запит");
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
    for (const key of this.paperGaps) if (!ids.has(key)) this.paperGaps.delete(key);
    const positionIds = new Set(positions.map(p => p.id));
    for (const id of this.paperErrorLog.keys()) if (!positionIds.has(id)) this.paperErrorLog.delete(id);
  }
  private paperTick(exchange: Exchange, symbol: string, tick: PriceTick) {
    const key = `${exchange}:${symbol}`, previous = this.paperTicks.get(key);
    const watched = this.paperWatched.get(key);
    if (!watched || !Number.isFinite(tick.at) || tick.at < watched.openedAt || Math.abs(Date.now()-tick.at)>5000) return;
    if (tick.last !== undefined && (!Number.isFinite(tick.last) || tick.last<=0)) tick={...tick,last:undefined};
    if (tick.mark !== undefined && (!Number.isFinite(tick.mark) || tick.mark<=0)) tick={...tick,mark:undefined};
    if (tick.last === undefined && tick.mark === undefined) return;
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
    // Persist each completed interval before fetching the schedule. Never jump over
    // unprocessed historical intervals after a long outage.
    this.save("paper", b);
    if (end < until) throw new Error("Відновлюється історія funding; наступний пакет у наступному циклі");
    const current = await this.market.getContractState(p.exchange, p.symbol);
    this.checkContractState(current);
    state.nextFundingAt = current.nextFundingAt;
    this.save("paper", b);
  }
  private async monitorPaper(b: Book, p: Position) {
    await this.ensurePaper(p);
    const state = p.paper!, key = `${p.exchange}:${p.symbol}`, tick = this.paperTicks.get(key);
    if (state.closeFill) { await this.finishPaper(b, p, state.closeFill.reference, state.closeFill.reason); return; }
    if (state.closeTrigger) { await this.finishPaper(b,p,state.closeTrigger.reference,state.closeTrigger.reason); return; }
    if(tick?.trigger) {
      state.closeTrigger=tick.trigger;
      this.save("paper",b);
      await this.finishPaper(b,p,state.closeTrigger.reference,state.closeTrigger.reason);
      return;
    }
    if (Date.now() - state.lastObservedAt > 15000 && !state.warnings.includes("monitoring-gap")) state.warnings.push("monitoring-gap");
    if (this.paperGaps.has(key) && !state.warnings.includes("stream-gap")) state.warnings.push("stream-gap");
    let last = tick?.last, mark = tick?.mark;
    if (!this.running || this.paperGaps.has(key) || !last || !mark || Date.now() - (tick?.markAt || 0) > 5000 || Date.now() - (tick?.lastAt || 0) > 15000) {
      const current = await this.market.getContractState(p.exchange, p.symbol); this.checkContractState(current);
      this.paperGaps.delete(key);
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
    if (!state.closeTrigger) {
      state.closeTrigger = { reason, at: Date.now(), reference };
    }
    p.status="closing";
    this.save("paper",b); // Persist the first trigger before any network request or latency.
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
      if (!Number.isFinite(price) || price < 0 || (reason !== "LIQUIDATION" && price === 0))
        throw new Error("Некоректна розрахункова ціна закриття");
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
    p.closeReason ||= reason;
    b.pending.push(intent);
    this.save("live", b);
    try {
      const fill = await this.gateway.submit(intent, s);
      intent.orderId = fill.id || undefined;
      this.save("live", b);
      // Acknowledgement, including a filled market response, is not proof that the position is now flat.
      if (["closed", "canceled", "rejected", "expired"].includes(fill.status))
        b.pending = b.pending.filter((x) => x.id !== intent.id);
      this.save("live", b);
    } catch (e: any) {
      if (definitiveRejection(e)) {
        // The exchange explicitly rejected this request; there is no unknown fill to reconcile.
        // A later cycle may retry only after fetching the actual remaining position.
        b.pending = b.pending.filter(x=>x.id!==intent.id);
      } else {
        intent.error = "Закриття очікує звірки з біржею";
      }
      this.pause(
        `${p.symbol}: ${exchangeError(e)} під час закриття; позицію не позначено закритою`,
      );
      this.save("live", b);
    }
  }
  private async recheckFees(trade:TradeHistoryEntry) {
    if(!trade.entryOrderId || !trade.closingFillIds?.length || !Number.isFinite(trade.openedAt)) return;
    const rows=await this.gateway.closingTrades(trade.exchange,trade.symbol,trade.openedAt!,trade.direction);
    if(!Array.isArray(rows)) throw new Error("Неповна історія комісій");
    const entrySide=trade.direction==="LONG"?"buy":"sell",exitSide=trade.direction==="LONG"?"sell":"buy";
    const exitIds=new Set(trade.closingFillIds),seen=new Map<string,typeof rows[number]>();
    for(const row of rows) {
      if(!row || !(row.orderId===trade.entryOrderId || exitIds.has(row.id))) continue;
      if(typeof row.id!=="string" || !row.id || !Number.isFinite(row.quantity) || row.quantity<=0 ||
         !Number.isFinite(row.fee) || row.feeKnown!==true || !Number.isFinite(row.at) ||
         row.at<trade.openedAt!-1000 || row.at>trade.closedAt+1000) return;
      if(exitIds.has(row.id)?row.side!==exitSide:row.side!==entrySide) return;
      const previous=seen.get(row.id);
      if(previous && (previous.orderId!==row.orderId || previous.quantity!==row.quantity || previous.fee!==row.fee ||
        previous.side!==row.side || previous.at!==row.at || previous.price!==row.price)) return;
      seen.set(row.id,row);
    }
    const exits=[...seen.values()].filter(row=>exitIds.has(row.id));
    const entries=[...seen.values()].filter(row=>!exitIds.has(row.id) && row.orderId===trade.entryOrderId);
    if(exits.length!==exitIds.size || !sameQuantity(exits.reduce((n,row)=>n+row.quantity,0),trade.quantity) ||
       !sameQuantity(entries.reduce((n,row)=>n+row.quantity,0),trade.quantity)) return;
    const entryFee=entries.reduce((n,row)=>n+row.fee,0),exitFee=exits.reduce((n,row)=>n+row.fee,0);
    if(!Number.isFinite(entryFee+exitFee)) return;
    trade.entryFee=entryFee;trade.exitFee=exitFee;trade.fee=entryFee+exitFee;
    trade.netPnl=trade.grossPnl-trade.fee-(trade.fundingCost??0);trade.feesComplete=true;
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
    const validTrade = (t: typeof trades[number]) => typeof t.id === "string" && t.id.length > 0 &&
      ["buy","sell"].includes(t.side) && Number.isFinite(t.quantity) && t.quantity > 0 &&
      Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.fee) &&
      Number.isFinite(t.at) && t.at >= p.openedAt-1000 && t.at <= Date.now()+5000;
    if (!Array.isArray(trades) || trades.some(t=>!t || !validTrade(t))) {
      this.pause(`${p.symbol}: некоректна історія виконань, P&L очікує звірки`);
      return;
    }
    const byId = new Map<string, typeof trades[number]>();
    for (const trade of trades) {
      const previous=byId.get(trade.id);
      if (previous && (previous.quantity!==trade.quantity || previous.price!==trade.price ||
          previous.side!==trade.side || previous.at!==trade.at || previous.orderId!==trade.orderId ||
          previous.fee!==trade.fee || previous.feeKnown!==trade.feeKnown)) {
        this.pause(`${p.symbol}: суперечливі дублікати виконань, P&L очікує звірки`);
        return;
      }
      byId.set(trade.id,trade);
    }
    const allFills=[...byId.values()];
    const unique=allFills.filter(t=>t.side===(p.direction==="LONG"?"sell":"buy") && t.at>=p.openedAt);
    const total = unique.reduce((sum, t) => sum + t.quantity, 0);
    if (!sameQuantity(total, p.originalQuantity)) {
      this.pause(
        `${p.symbol}: позиція на біржі закрита, очікуємо повну історію виконань для P&L`,
      );
      return;
    }
    const exit =
      unique.reduce((sum, t) => sum + t.price * t.quantity, 0) / total;
    const entryFills = allFills.filter(t=>p.entryOrderId && t.orderId===p.entryOrderId &&
      t.side===(p.direction==="LONG"?"buy":"sell"));
    const entryFeesComplete=entryFills.length>0 && sameQuantity(entryFills.reduce((sum,t)=>sum+t.quantity,0),p.originalQuantity) &&
      entryFills.every(t=>t.feeKnown===true);
    const entryFee = entryFeesComplete
      ? entryFills.reduce((sum, t) => sum + t.fee, 0)
      : p.entryFee;
    const gross =
        (exit - p.entryPrice) * total * (p.direction === "LONG" ? 1 : -1),
      fee = entryFee + unique.reduce((sum, t) => sum + t.fee, 0);
    const closedAt = Math.max(...unique.map(t => t.at));
    let fundingCost: number | undefined;
    try { const value=await this.gateway.fundingCost(p.exchange,p.symbol,p.openedAt,closedAt);
      if(Number.isFinite(value)) fundingCost=value;
    } catch { /* Never report unavailable funding as a verified zero. */ }
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
      fundingCheckedAt: Date.now(), feesCheckedAt:Date.now(), entryOrderId:p.entryOrderId,
      closingFillIds:unique.map(t=>t.id), executionSource: "venue-fills",
      openedAt: p.openedAt,
      closedAt,
      reason,
      estimated: false,
      feesComplete:entryFeesComplete && unique.every(t=>t.feeKnown===true),
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
  private reconciliationFailure(key:string,message:string) {
    const now=Date.now();
    if(this.settings().autoEntries || now-(this.reconciliationWarnings.get(key)??-Infinity)>=60_000) {
      this.pause(message);
      this.reconciliationWarnings.set(key,now);
      while(this.reconciliationWarnings.size>300) this.reconciliationWarnings.delete(this.reconciliationWarnings.keys().next().value!);
    }
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
      try {
      const fill = await this.gateway.read(intent);
      if (!fill) continue; // Unknown submissions are never blindly repeated.
      if (intent.kind === "entry") {
        if (
          ["closed", "canceled", "expired", "rejected"].includes(fill.status) &&
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
      } catch {
        this.reconciliationFailure(intent.id,`${intent.symbol}: не вдалося звірити ордер; повторне надсилання заблоковано`);
      }
    }
    let protectionBudget=2;
    const priority=(p:Position)=>p.status!=="active" || (p.expiresAt>0 && p.expiresAt<=Date.now()) ||
      !account.positions.some(v=>v.symbol===p.symbol) ? 0:1;
    // Oldest observations go first, so slow requests cannot repeatedly starve the tail.
    const queue=[...b.positions].sort((a,z)=>priority(a)-priority(z) ||
      (a.protectionCheck?.at||0)-(z.protectionCheck?.at||0));
    for (const p of queue) {
      try {
      // Re-fetch after recovering an entry; the first snapshot may predate its execution.
      const fresh =
        b.accountAt! < p.openedAt + 2000
          ? await this.gateway.account(p.exchange)
          : account;
      const venue = fresh.positions.find((x) => x.symbol === p.symbol);
      if (!venue) {
        await this.finishLive(b, p, p.closeReason || "EXCHANGE");
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
          p.protectionCheck={at:Date.now(),status:"unknown"};
          this.save("live",b);
          this.reconciliationFailure(p.id,`${p.symbol}: кількість або напрям позиції не збігаються з біржею`);
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
      ) {
        await this.closeLive(
          b,
          p,
          p.status === "closing" ? p.closeReason || "MANUAL" : "TIME",
          s,
        );
        continue;
      }
      if(p.status==="active" && protectionBudget>0 && Date.now()-(p.protectionCheck?.at||0)>=30_000) {
        protectionBudget--;
        const previous=p.protectionCheck?.status;
        let status:"verified"|"missing"|"unknown"="unknown";
        try {
          if(p.exchange==="bybit") {
            status=await this.verifyBybitProtection(p,venue);
          } else status=await this.gateway.checkProtection(p.intent,p.guards,p.quantity);
        } catch { /* Transient network errors are explicitly unknown, never missing. */ }
        p.protectionCheck={at:Date.now(),status};
        this.save("live",b);
        if(status!=="verified" && (previous!==status || this.settings().autoEntries))
          this.pause(`${p.symbol}: ${status==="missing"?"TP/SL відсутній або завершився":"TP/SL не вдалося перевірити"}. Нові входи призупинено; перевірте позицію на біржі`);
      }
      } catch {
        if(p.status==="active") p.protectionCheck={at:Date.now(),status:"unknown"};
        this.reconciliationFailure(p.id,`${p.symbol}: звірка позиції не завершена; супровід інших позицій продовжується`);
        this.save("live",b);
      }
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
