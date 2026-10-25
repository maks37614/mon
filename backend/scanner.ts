import { DEFAULT_SETTINGS, type Settings, type Signal } from "./config";
import type { Store } from "./store";
import type { MarketData } from "./market";
import { detectFormations } from "./patterns";

export class Scanner {
  running = false;
  task: Promise<void> | null = null;
  constructor(
    private store: Store,
    private market: MarketData,
  ) {}
  start(force = false) {
    const settings = this.store.get("settings", DEFAULT_SETTINGS);
    const state = this.store.get<any>("scanner", {});
    if (this.running) return { accepted: false, reason: "running" };
    if (
      !force &&
      Date.now() - (state.lastStartedAt || 0) <
        settings.scanIntervalSeconds * 1000
    )
      return { accepted: false, reason: "interval" };
    this.running = true;
    this.task = this.run(settings)
      .catch((e) => {
        this.store.log("ERROR", `Сканування: ${e.message}`);
        this.store.set("scanner", {
          ...this.store.get<any>("scanner", {}),
          error: e.message,
          running: false,
        });
      })
      .finally(() => {
        this.running = false;
      });
    return { accepted: true };
  }
  private async run(settings: Settings) {
    const signature = `${settings.exchange}:${settings.timeframes.join(",")}:${settings.candleLimit}`;
    const old = this.store.get<any>("scanner", {});
    let cursor = old.signature === signature ? old.cursor || 0 : 0;
    const markets = await this.market.getMarkets(settings.exchange);
    const tasks = settings.timeframes.flatMap((timeframe) =>
      markets.map((m) => ({ symbol: m.symbol, timeframe })),
    );
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
      lastStartedAt: Date.now(),
      lastFullPassAt: old.signature === signature ? old.lastFullPassAt : null,
      error: null,
    };
    this.store.set("scanner", status);
    const existing = this.store
      .get<Signal[]>("signals", [])
      .filter(
        (s) =>
          s.exchange === settings.exchange &&
          Date.now() - s.candleAt <= settings.maxSignalAgeSeconds * 1000,
      );
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
        for (const signal of detectFormations(
          candles,
          settings.exchange,
          target.symbol,
          target.timeframe,
          settings,
        ))
          signals.set(signal.id, signal);
      } catch (e: any) {
        status.failed++;
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
        this.store.set("scanner", status);
        this.store.set(
          "signals",
          [...signals.values()]
            .filter(
              (s) =>
                Date.now() - s.candleAt <= settings.maxSignalAgeSeconds * 1000,
            )
            .slice(-20_000),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.store.set(
      "signals",
      [...signals.values()]
        .filter(
          (s) => Date.now() - s.candleAt <= settings.maxSignalAgeSeconds * 1000,
        )
        .slice(-20_000),
    );
    this.store.set("scanner", {
      ...status,
      cursor,
      running: false,
      finishedAt: Date.now(),
    });
    this.store.log(
      status.error ? "WARN" : "INFO",
      `Сканування ${settings.exchange}: ${status.processed}/${tasks.length} пар/таймфреймів, помилок ${status.failed}; наступний індекс ${cursor}`,
    );
  }
}
