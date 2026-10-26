// Offline compute benchmark: no network, account access, or exchange orders.
import { performance } from "node:perf_hooks";
import { detectFormations } from "../backend/patterns";
import { DEFAULT_SETTINGS } from "../backend/config";

const settings = { ...DEFAULT_SETTINGS, confirmedOnly: false };
const start = Math.floor(Date.now() / 60_000) * 60_000 - 300 * 60_000;
function run(count: number) {
  const wall = performance.now(),
    cpu = process.cpuUsage();
  let signals = 0;
  for (let market = 0; market < count; market++) {
    const scale = 1 + (market % 100);
    const raw = Array.from({ length: 300 }, (_, i) => [
      start + i * 60_000,
      scale * (100 + Math.sin(i / 5)),
      scale * (101 + Math.sin(i / 5)),
      scale * (99 + Math.sin(i / 5)),
      scale * (100 + Math.sin(i / 5)),
      1000,
    ]);
    const candles = JSON.parse(JSON.stringify(raw)).map((c: number[]) => ({
      time: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    signals += detectFormations(
      candles,
      "binance",
      `COIN${market}USDT`,
      "1m",
      settings,
    ).length;
  }
  const used = process.cpuUsage(cpu);
  return {
    marketTimeframes: count,
    candlesEach: 300,
    wallMs: Math.round(performance.now() - wall),
    cpuMs: Math.round((used.user + used.system) / 1000),
    signals,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}
const results = [run(600), run(4200)];
const ccxtRoot = import.meta.resolve("ccxt");
await import(new URL("./src/binanceusdm.js", ccxtRoot).href);
await import(new URL("./src/bybit.js", ccxtRoot).href);
console.log(
  JSON.stringify(
    {
      offline: true,
      note: "Compute-only fixture; excludes HTTP latency, live market feeds and actual trading. Peak RSS includes this benchmark, not a VPS deployment measurement.",
      results,
      peakRssWithBothAdaptersMiB: Math.round(
        process.resourceUsage().maxRSS / 1024,
      ),
    },
    null,
    2,
  ),
);
