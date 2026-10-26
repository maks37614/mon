import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION, type Settings, type Signal } from "./config";
import type { Store } from "./store";
import type { MarketData } from "./market";
import { detectFormations } from "./patterns";
import { formationIsVisible, signalAllowsEntry } from "./formationState";

export class Scanner {
  running = false;
  task: Promise<void> | null = null;
  constructor(
    private store: Store,
    private market: MarketData,
  ) {}
  private saveStatus(status: any) {
    const latest = this.store.get<any>("scanner", {});
    this.store.set("scanner", { ...status, lastCronAt: latest.lastCronAt || status.lastCronAt });
  }
  start(force = false, source: "manual" | "cron" | "internal" = "manual") {
    const settings = this.store.get("settings", DEFAULT_SETTINGS);
    let state = this.store.get<any>("scanner", {});
    const now = Date.now();
    if (source === "cron") {
      state = { ...state, lastCronAt: now };
      this.store.set("scanner", state);
    }
    if (this.running) return { accepted: false, reason: "running" };
    if (
      !force &&
      Date.now() - (state.lastStartedAt || 0) <
        settings.scanIntervalSeconds * 1000
    )
      return { accepted: false, reason: "interval" };
    this.running = true;
    state = { ...state, running: true, lastStartedAt: now, lastTrigger: source,
      processed: 0, successful: 0, failed: 0, detected: 0, errors: [], error: null };
    this.saveStatus(state);
    this.task = this.run(settings, state)
      .catch((e) => {
        this.store.log("ERROR", `Сканування: ${e.message}`);
        this.saveStatus({
          ...this.store.get<any>("scanner", {}),
          error: e.message,
          running: false,
          finishedAt: Date.now(),
        });
      })
      .finally(() => {
        this.running = false;
      });
    return { accepted: true };
  }
  private async run(settings: Settings, old: any) {
    const signature = `analysis${FORMATION_ANALYSIS_VERSION}:interleaved:${settings.exchange}:${settings.timeframes.join(",")}:${settings.candleLimit}`;
    let cursor = old.signature === signature ? old.cursor || 0 : 0;
    const markets = await this.market.getMarkets(settings.exchange);
    const tasks = markets.flatMap((m) =>
      settings.timeframes.map((timeframe) => ({ symbol: m.symbol, timeframe })),
    );
    if (!tasks.length) throw new Error("Біржа не повернула монети для сканування");
    cursor %= tasks.length;
    let status: any = {
      ...old,
      signature,
      exchange: settings.exchange,
      cursor,
      total: tasks.length,
      symbols: markets.length,
      processed: 0,
      failed: 0,
      running: true,
      lastFullPassAt: old.signature === signature ? old.lastFullPassAt : null,
      error: null,
    };
    this.saveStatus(status);
    const existing = this.store
      .get<Signal[]>("signals", [])
      .filter((signal) => formationIsVisible(signal, settings));
    const signals = new Map(existing.map((s) => [s.id, s]));
    const count = Math.min(settings.scanBatchSize, tasks.length);
    for (let index = 0; index < count; index++) {
      const target = tasks[cursor];
      try {
        const candles = await this.market.getCandles(
          settings.exchange,
          target.symbol,
          target.timeframe,
          settings.candleLimit,
          true,
        );
        for (const [id, signal] of signals)
          if (
            signal.symbol === target.symbol &&
            signal.timeframe === target.timeframe
          )
            signals.delete(id);
        const found = detectFormations(
          candles,
          settings.exchange,
          target.symbol,
          target.timeframe,
          settings,
        );
        status.successful++;
        status.detected += found.length;
        for (const signal of found)
          signals.set(signal.id, signal);
      } catch (e: any) {
        status.failed++;
        if (status.errors.length < 3) status.errors.push({
          symbol: target.symbol, timeframe: target.timeframe,
          message: String(e.message || "Не вдалося отримати свічки").slice(0, 200),
        });
        if ((this.market.status()[settings.exchange] || 0) > Date.now()) {
          status.error = e.message;
          break;
        }
      }
      cursor = (cursor + 1) % tasks.length;
      status.processed++;
      if (cursor === 0) status.lastFullPassAt = Date.now();
      // Persist progress and publish completed results without waiting for the entire universe.
      if (index % 10 === 0 || index === count - 1) {
        status = { ...status, cursor };
        this.saveStatus(status);
        this.store.set(
          "signals",
          [...signals.values()]
            .filter((signal) => formationIsVisible(signal, settings))
            .slice(-20_000),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.store.set(
      "signals",
      [...signals.values()]
        .filter((signal) => formationIsVisible(signal, settings))
        .slice(-20_000),
    );
    if (!status.successful && status.failed && !status.error)
      status.error = status.errors[0]?.message || "Дані свічок не завантажилися";
    const retained = [...signals.values()].filter((signal) => formationIsVisible(signal, settings));
    this.saveStatus({
      ...status,
      cursor,
      running: false,
      finishedAt: Date.now(),
      visibleFormations: retained.length,
      entrySignals: retained.filter((signal) => signalAllowsEntry(signal, settings)).length,
    });
    this.store.log(
      status.error ? "WARN" : "INFO",
      `Сканування ${settings.exchange}: ${status.processed}/${tasks.length} пар/таймфреймів, помилок ${status.failed}; знайдено ${status.detected}, у скрінері ${retained.length}; наступний індекс ${cursor}`,
    );
  }
}
