import type { Exchange } from "./config";
export type PriceTick = { last?: number; mark?: number; at: number };
type Socket = Pick<WebSocket, "addEventListener" | "send" | "close" | "readyState">;

// Only active paper symbols are subscribed. No trading or private credentials.
export class PaperFeed {
  private connections = new Map<string, { socket: Socket; timer: ReturnType<typeof setInterval>; retry?: ReturnType<typeof setTimeout>; close: () => void }>();
  constructor(private receive: (exchange: Exchange, symbol: string, tick: PriceTick) => void,
    private gap: (exchange: Exchange, symbol: string) => void,
    private factory: (url: string) => Socket = url => new WebSocket(url)) {}
  sync(symbols: { exchange: Exchange; symbol: string }[]) {
    const wanted = new Set(symbols.map(s => `${s.exchange}:${s.symbol}`));
    for (const [key, c] of this.connections) if (!wanted.has(key)) { this.connections.delete(key); c.close(); }
    for (const { exchange, symbol } of symbols) {
      const key = `${exchange}:${symbol}`;
      if (!this.connections.has(key)) this.connect(exchange, symbol);
    }
  }
  private connect(exchange: Exchange, symbol: string) {
    const key = `${exchange}:${symbol}`, lower = symbol.toLowerCase();
    const url = exchange === "binance"
      ? `wss://fstream.binance.com/market/stream?streams=${lower}@aggTrade/${lower}@markPrice@1s`
      : "wss://stream.bybit.com/v5/public/linear";
    const socket = this.factory(url); let receivedAt = Date.now(), stopped = false;
    const retry = () => {
      if (stopped) return; stopped = true; this.gap(exchange, symbol); clearInterval(connection.timer);
      socket.close();
      connection.retry = setTimeout(() => {
        if (this.connections.get(key) !== connection) return;
        this.connections.delete(key); this.connect(exchange, symbol);
      }, 2000);
      connection.retry.unref?.();
    };
    const connection = { socket, timer: setInterval(() => {
      if (Date.now() - receivedAt > 15000) { retry(); return; }
      if (exchange === "bybit" && socket.readyState === 1) socket.send(JSON.stringify({ op: "ping" }));
    }, 5000), retry: undefined as ReturnType<typeof setTimeout> | undefined,
    close: () => { stopped = true; clearInterval(connection.timer); clearTimeout(connection.retry); socket.close(); } };
    connection.timer.unref?.(); this.connections.set(key, connection);
    socket.addEventListener("open", () => {
      if (exchange === "bybit") socket.send(JSON.stringify({ op: "subscribe", args: [`tickers.${symbol}`] }));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (stopped) return;
      try {
        const raw = JSON.parse(String(event.data)), row = raw.data || raw;
        if (exchange === "bybit" && (raw.op === "pong" || (raw.op === "ping" && raw.ret_msg === "pong"))) {
          receivedAt = Date.now(); return;
        }
        const at = Number(exchange === "binance" ? row.E : raw.ts);
        if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 5000) return;
        let tick: PriceTick;
        if (exchange === "binance") {
          if (row.s !== symbol) return;
          tick = row.e === "aggTrade" ? { at, last: Number(row.p) }
            : row.e === "markPriceUpdate" ? { at, mark: Number(row.p) } : { at };
        } else {
          if (row.symbol !== symbol || raw.topic !== `tickers.${symbol}`) return;
          receivedAt = Date.now();
          tick = { at, ...(row.lastPrice !== undefined ? { last: Number(row.lastPrice) } : {}),
            ...(row.markPrice !== undefined ? { mark: Number(row.markPrice) } : {}) };
        }
        if ((tick.last !== undefined && (!Number.isFinite(tick.last) || !(tick.last > 0))) || (tick.mark !== undefined && (!Number.isFinite(tick.mark) || !(tick.mark > 0)))) return;
        if (tick.last === undefined && tick.mark === undefined) return;
        receivedAt = Date.now(); this.receive(exchange, symbol, tick);
      } catch { /* Malformed frames do not become prices. Watchdog reconnects. */ }
    });
    socket.addEventListener("error", retry); socket.addEventListener("close", retry);
  }
  stop() { for (const c of this.connections.values()) c.close(); this.connections.clear(); }
}
