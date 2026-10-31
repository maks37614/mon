import { DEFAULT_SETTINGS, type Exchange, type Signal } from "./config";
import { formationIsVisible } from "./formationState";
import type { Store } from "./store";
import type { MarketData } from "./market";
import {
  EDWIN_DEFAULTS, EDWIN_STRATEGY, detectEdwinSetups, validateEdwinSettings,
  type EdwinSettings, type EdwinSignal,
} from "./edwinStrategy";

/** Scanner of strategy entry confirmations, restricted to the existing formations universe. */
export class StrategyBuilderScanner {
  running = false;
  task: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private market: MarketData,
    private exchange: () => Exchange,
  ) {}

  settings(): EdwinSettings {
    return { ...EDWIN_DEFAULTS, ...this.store.get<Partial<EdwinSettings>>("builder:edwin:config", {}) };
  }

  snapshot() {
    const settings = this.settings();
    const status = this.store.get<any>("builder:edwin:status", {});
    const now = Date.now();
    const signals = this.store.get<EdwinSignal[]>("builder:edwin:signals", [])
      .filter((s) => now - s.candleAt <= (s.timeframe === "1m" ? 10 : 20) * 60_000)
      .sort((a, b) => b.candleAt - a.candleAt)
      .slice(0, 150);
    return {
      strategies: [EDWIN_STRATEGY],
      settings,
      status: { ...status, running: this.running },
      signals,
      tradingConnected: settings.enabled,
    };
  }

  update(input: unknown) {
    const old = this.settings();
    const settings = validateEdwinSettings(input, old);
    this.store.set("builder:edwin:config", settings);
    if (!old.enabled && settings.enabled)
      setImmediate(() => this.start(true));
    return this.snapshot();
  }

  start(force = false) {
    const settings = this.settings();
    if (!settings.enabled) return { accepted: false, reason: "disabled" };
    if (this.running) return { accepted: false, reason: "running" };
    const status = this.store.get<any>("builder:edwin:status", {});
    if (!force && Date.now() - (status.lastStartedAt || 0) < settings.scanIntervalSeconds * 1000)
      return { accepted: false, reason: "interval" };
    this.running = true;
    this.store.set("builder:edwin:status", { ...status, lastStartedAt: Date.now(), running: true, error: null });
    this.task = this.run(settings).catch((error: any) => {
      const message = String(error?.message || "Помилка сканування").slice(0, 200);
      this.store.set("builder:edwin:status", {
        ...this.store.get<any>("builder:edwin:status", {}), running: false, error: message, lastFinishedAt: Date.now(),
      });
      this.store.log("WARN", "Конструктор стратегій: " + message);
    }).finally(() => {
      this.running = false;
    });
    return { accepted: true };
  }

  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.start(false), 10_000);
    setImmediate(() => this.start(false));
  }

  private async run(settings: EdwinSettings) {
    const exchange = this.exchange();
    // Symbols are selected exclusively by the existing formations screener; never scan the whole exchange.
    const sourceSettings = this.store.get("settings", DEFAULT_SETTINGS);
    const sourceSignals = this.store.get<Signal[]>("signals", [])
      .filter((signal) => formationIsVisible(signal, sourceSettings));
    const markets = [...new Set(sourceSignals.filter((signal) => signal.exchange === exchange).map((signal) => signal.symbol))].sort();
    if (!markets.length) {
      this.store.set("builder:edwin:signals", []);
      this.store.set("builder:edwin:status", { running: false, exchange, lastStartedAt: this.store.get<any>("builder:edwin:status", {}).lastStartedAt || Date.now(), lastFinishedAt: Date.now(), cursor: 0, total: 0, scanned: 0, failed: 0, detected: 0, error: "Скрінер формацій поки не відібрав монет" });
      return;
    }
    const previous = this.store.get<any>("builder:edwin:status", {});
    const cursor = previous.exchange === exchange ? (previous.cursor || 0) % markets.length : 0;
    const count = Math.min(settings.symbolsPerBatch, markets.length);
    const found: EdwinSignal[] = [];
    let scanned = 0, failed = 0, index = cursor;
    let message = "";
    for (let i = 0; i < count; i++) {
      // A switch-off must stop new API work rather than complete an unwanted batch.
      if (!this.settings().enabled) break;
      const symbol = markets[index];
      try {
        const [fast, slow] = await Promise.all([
          this.market.getCandles(exchange, symbol, "1m", 180, true),
          this.market.getCandles(exchange, symbol, "5m", 180, true),
        ]);
        const latest = detectEdwinSetups(exchange, symbol, fast, slow, settings);
        found.push(...latest);
        scanned++;
      } catch (error: any) {
        failed++;
        if (!message) message = String(error?.message || "Помилка даних").slice(0, 180);
        if ((this.market.status()[exchange] || 0) > Date.now()) break;
      }
      index = (index + 1) % markets.length;
      if (index === 0) this.store.set("builder:edwin:lastFullPass", Date.now());
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Only update strategy-specific storage. Never touch 'signals', books or bot settings.
    const now = Date.now();
    const kept = this.store.get<EdwinSignal[]>("builder:edwin:signals", []).filter((signal) =>
      signal.exchange === exchange && markets.includes(signal.symbol) &&
      now - signal.candleAt <= (signal.timeframe === "1m" ? 10 : 20) * 60_000
    );
    const merged = new Map(kept.map((signal) => [signal.id, signal]));
    for (const signal of found) merged.set(signal.id, signal);
    this.store.set("builder:edwin:signals", [...merged.values()].sort((a, b) => b.candleAt - a.candleAt).slice(0, 400));
    this.store.set("builder:edwin:status", {
      running: false, exchange, lastStartedAt: previous.lastStartedAt || now, lastFinishedAt: now,
      lastFullPassAt: this.store.get<number | null>("builder:edwin:lastFullPass", null),
      cursor: index, total: markets.length, scanned, failed, detected: found.length, source: "formations", error: message || null,
    });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.task) await this.task;
  }
}
