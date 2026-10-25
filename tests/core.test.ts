import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Store } from "../backend/store";
import { Vault, hashPassword, checkPassword } from "../backend/security";
import {
  DEFAULT_SETTINGS,
  validateSettings,
  type Signal,
  type Settings,
} from "../backend/config";
import { Trading } from "../backend/trading";
import { MarketData } from "../backend/market";
import { Scanner } from "../backend/scanner";
import { detectFormations } from "../backend/patterns";
import { ExchangeGateway } from "../backend/exchange";
import { createApplication } from "../server";

function storage(t: any) {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-"));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}
function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "signal-1",
    exchange: "binance",
    symbol: "BTCUSDT",
    timeframe: "1m",
    formation: "Double Bottom",
    direction: "LONG",
    entryPrice: 100,
    currentPrice: 100,
    stopLoss: 99.75,
    takeProfit: 100.45,
    confidence: 90,
    status: "confirmed",
    candleAt: Date.now() - 1000,
    detectedAt: Date.now(),
    description: "Fixture",
    ...overrides,
  };
}
function fixture(t: any, mode: "paper" | "live" = "paper") {
  const { store, directory } = storage(t);
  const s = { ...DEFAULT_SETTINGS, mode, entryCooldownSeconds: 0 };
  store.set("settings", s);
  store.set("signals", [signal()]);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture-key", "fixture-secret");
  vault.verify("binance");
  let price = 100;
  const market: any = {
    getPrices: async () => ({ at: Date.now(), data: { BTCUSDT: price } }),
    getMarkets: async () => [
      {
        symbol: "BTCUSDT",
        quantityStep: 0.001,
        minQuantity: 0.001,
        minNotional: 5,
        tickSize: 0.01,
      },
    ],
  };
  const broker: any = {
    positions: [],
    orders: new Map(),
    submitted: [],
    guardFailed: false,
    unknown: false,
    account: async () => ({
      total: 1000,
      free: 1000,
      positions: structuredClone(broker.positions),
    }),
    quantity: async (_e: any, _s: any, quote: number, notional: number) =>
      notional / quote,
    prepare: async () => {},
    submit: async (intent: any) => {
      broker.submitted.push(structuredClone(intent));
      if (intent.kind === "entry") {
        broker.positions.push({
          symbol: intent.symbol,
          direction: intent.direction,
          quantity: intent.quantity,
          entryPrice: price,
          currentPrice: price,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
        });
        const fill = {
          id: `venue-${intent.id}`,
          filled: intent.quantity,
          average: price,
          fee: 0.015,
          status: "closed",
        };
        broker.orders.set(intent.id, fill);
        if (broker.unknown)
          throw Object.assign(new Error("fixture network failure"), {
            name: "RequestTimeout",
          });
        return fill;
      }
      broker.positions = [];
      const fill = {
        id: `venue-${intent.id}`,
        filled: intent.quantity,
        average: price,
        fee: 0.015,
        status: "closed",
      };
      broker.orders.set(intent.id, fill);
      return fill;
    },
    read: async (intent: any) => broker.orders.get(intent.id) || null,
    protection: async (_i: any, _q: any, saved: any) => {
      if (broker.guardFailed) throw new Error("fixture guard rejection");
      saved("sl-1", "stopLoss");
      saved("tp-1", "takeProfit");
    },
    cancelProtection: async () => {},
    closingTrades: async () => [
      {
        id: "close-1",
        side: "sell",
        quantity: 0.25,
        price,
        fee: 0.015,
        at: Date.now(),
      },
    ],
  };
  const trading = new Trading(store, market, vault, broker, true);
  return {
    trading,
    store,
    directory,
    vault,
    market,
    broker,
    setPrice: (value: number) => {
      price = value;
      for (const p of broker.positions) p.currentPrice = value;
    },
  };
}

test("password hashing verifies the password and rejects a different value", async () => {
  const hash = await hashPassword("fixture-only-password");
  assert.equal(await checkPassword("fixture-only-password", hash), true);
  assert.equal(await checkPassword("wrong-password", hash), false);
  assert.notEqual(hash, await hashPassword("fixture-only-password"));
});
test("exchange secrets are encrypted at rest and authenticated against the exchange name", (t) => {
  const { store } = storage(t),
    key = randomBytes(32).toString("base64"),
    vault = new Vault(store, key);
  vault.save("binance", "private-fixture-api", "private-fixture-secret");
  assert.deepEqual(vault.load("binance"), {
    apiKey: "private-fixture-api",
    secret: "private-fixture-secret",
  });
  const raw = store.get<any>("credentials:binance", null);
  assert.equal(JSON.stringify(raw).includes("private-fixture"), false);
  store.set("credentials:bybit", raw);
  assert.throws(() => vault.load("bybit"));
  assert.deepEqual(vault.status("binance"), {
    configured: true,
    verified: false,
  });
});
test("settings reject invalid numbers, inherited keys and unsupported formations", () => {
  assert.throws(() =>
    validateSettings({ requestsPerSecond: 100 }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ maxPositions: NaN }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ toString: "invalid" }, DEFAULT_SETTINGS),
  );
  assert.throws(() =>
    validateSettings({ formationTypes: ["invented"] }, DEFAULT_SETTINGS),
  );
});
test("flat market produces no fabricated formations", () => {
  const now = Date.now() - 100 * 60_000;
  const candles = Array.from({ length: 100 }, (_, i) => ({
    time: now + i * 60_000,
    open: 100,
    close: 100,
    high: 100,
    low: 100,
    volume: 100,
  }));
  assert.deepEqual(
    detectFormations(candles, "binance", "BTCUSDT", "1m", DEFAULT_SETTINGS),
    [],
  );
});
test("paper TP uses observed execution price and both fees, without a real order", async (t) => {
  const f = fixture(t);
  await f.trading.enter("signal-1");
  assert.equal(f.trading.snapshot().positions.length, 1);
  f.setPrice(101);
  await f.trading.monitor();
  const state = f.trading.snapshot();
  assert.equal(state.positions.length, 0);
  assert.equal(state.history[0].exitPrice, 101);
  assert.ok(
    Math.abs(state.history[0].netPnl - (0.25 - 0.015 - 0.01515)) < 1e-9,
  );
  assert.equal(f.broker.submitted.length, 0);
});
test("a signal cannot open twice concurrently and open exposure prevents a mode switch", async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    f.trading.enter("signal-1"),
    f.trading.enter("signal-1"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.trading.snapshot().positions.length, 1);
  await assert.rejects(f.trading.updateSettings({ mode: "live" }), /Спочатку/);
});
test("position expiry survives a new server engine without a browser", async (t) => {
  const f = fixture(t);
  await f.trading.enter("signal-1");
  const book = f.store.get<any>("book:paper", null);
  book.positions[0].expiresAt = Date.now() - 1000;
  f.store.set("book:paper", book);
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, false);
  await restarted.monitor();
  assert.equal(restarted.snapshot().history[0].reason, "TIME");
});
test("an unknown live order is persisted and reconciled after restart without resubmission", async (t) => {
  const f = fixture(t, "live");
  f.broker.unknown = true;
  await assert.rejects(f.trading.enter("signal-1"));
  assert.equal(f.trading.snapshot().pending.length, 1);
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, true);
  await restarted.monitor();
  assert.equal(f.broker.submitted.length, 1);
  assert.equal(restarted.snapshot().pending.length, 0);
  assert.equal(restarted.snapshot().positions[0].status, "active");
  assert.equal(restarted.snapshot().positions[0].guards.length, 2);
});
test("failed protective orders pause entries and request a separate reduce-only close", async (t) => {
  const f = fixture(t, "live");
  f.broker.guardFailed = true;
  await f.trading.enter("signal-1");
  assert.deepEqual(
    f.broker.submitted.map((i: any) => i.kind),
    ["entry", "close"],
  );
  assert.equal(f.trading.settings().autoEntries, false);
  // Closing acknowledgement alone does not remove the position.
  assert.equal(f.trading.snapshot().positions.length, 1);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 0);
  assert.equal(f.trading.snapshot().history.length, 1);
});
test("live closing is not recorded until venue position and complete fills agree", async (t) => {
  const f = fixture(t, "live");
  await f.trading.enter("signal-1");
  const id = f.trading.snapshot().positions[0].id;
  f.broker.closingTrades = async () => [];
  await f.trading.closePosition(id);
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions[0].status, "reconciling");
  assert.equal(f.trading.snapshot().history.length, 0);
  f.broker.closingTrades = async () => [
    {
      id: "fill-1",
      side: "sell",
      quantity: 0.1,
      price: 101,
      fee: 0.006,
      at: Date.now(),
    },
    {
      id: "fill-2",
      side: "sell",
      quantity: 0.15,
      price: 102,
      fee: 0.009,
      at: Date.now(),
    },
  ];
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 0);
  assert.ok(Math.abs(f.trading.snapshot().history[0].exitPrice - 101.6) < 1e-9);
});
test("server-level live disable cannot be bypassed by changing settings", async (t) => {
  const f = fixture(t),
    disabled = new Trading(f.store, f.market, f.vault, f.broker, false);
  await assert.rejects(
    disabled.updateSettings({ mode: "live" }),
    /ENABLE_LIVE_TRADING/,
  );
});

test("server-level live disable keeps recovery read-only after a restart", async (t) => {
  const f = fixture(t, "live");
  f.broker.unknown = true;
  await assert.rejects(f.trading.enter("signal-1"));
  let guards = 0;
  f.broker.protection = async () => {
    guards++;
  };
  const disabled = new Trading(f.store, f.market, f.vault, f.broker, false);
  await disabled.monitor();
  assert.equal(guards, 0);
  assert.equal(f.broker.submitted.length, 1);
  assert.equal(disabled.snapshot().pending.length, 1);
});

test("automatic entry checks are bounded and rotate without scanning every signal privately", async (t) => {
  const f = fixture(t, "live");
  f.store.set("settings", { ...f.trading.settings(), autoEntries: true });
  f.store.set(
    "signals",
    Array.from({ length: 50 }, (_, i) => signal({ id: `signal-${i}` })),
  );
  let accountReads = 0;
  f.broker.account = async () => {
    accountReads++;
    return { free: 0, total: 1000, positions: [] };
  };
  await f.trading.monitor();
  assert.equal(accountReads, 11);
  assert.equal(f.broker.submitted.length, 0);
});

test("leverage preflight failure never creates an unknown order intent", async (t) => {
  const f = fixture(t, "live");
  f.broker.prepare = async () => {
    throw Object.assign(new Error("timeout before submission"), {
      name: "RequestTimeout",
    });
  };
  await assert.rejects(f.trading.enter("signal-1"));
  assert.equal(f.trading.snapshot().pending.length, 0);
  assert.equal(f.broker.submitted.length, 0);
});

test("cleanup recovers a protective order with a lost acknowledgement by its client id", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture", "fixture");
  const canceled: string[] = [];
  const market = {
    id: "BTCUSDT",
    symbol: "BTC/USDT:USDT",
    swap: true,
    linear: true,
    settle: "USDT",
    contractSize: 1,
  };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    fetchOrder: async (_id: any, _s: any, p: any) => {
      if (p.clientOrderId.endsWith("-sl"))
        return { id: "lost-sl-id", status: "open" };
      throw Object.assign(new Error("missing"), { name: "OrderNotFound" });
    },
    cancelOrder: async (id: string) => {
      canceled.push(id);
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.cancelProtection("binance", "BTCUSDT", [], "mon-entry");
  assert.deepEqual(canceled, ["lost-sl-id"]);
});

test("Bybit adapter attaches TP/SL to the entry with a unique client id", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("bybit", "fixture", "fixture");
  const calls: any[] = [];
  const market = {
    id: "BTCUSDT",
    symbol: "BTC/USDT:USDT",
    swap: true,
    linear: true,
    settle: "USDT",
    contractSize: 1,
  };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    priceToPrecision: (_s: any, p: number) => p.toFixed(2),
    createOrder: async (...args: any[]) => {
      calls.push(args);
      return { id: "entry", filled: 0, status: "open" };
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.submit(
    {
      id: "mon-bybit-entry",
      exchange: "bybit",
      symbol: "BTCUSDT",
      direction: "LONG",
      signal: signal({ exchange: "bybit" }),
      quantity: 0.25,
      stopLoss: 99.75,
      takeProfit: 100.45,
      createdAt: Date.now(),
      kind: "entry",
    },
    DEFAULT_SETTINGS,
  );
  assert.equal(calls[0][5].clientOrderId, "mon-bybit-entry");
  assert.equal(calls[0][5].stopLoss.triggerPrice, 99.75);
  assert.equal(calls[0][5].takeProfit.triggerPrice, 100.45);
  assert.equal(calls[0][5].positionIdx, 0);
});

function publicFixture() {
  const calls: URL[] = [];
  const fetcher = async (input: any) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/v5/market/instruments-info") {
      const page = url.searchParams.get("cursor");
      return Response.json({
        retCode: 0,
        result: {
          nextPageCursor: page ? "" : "page2",
          list: Array.from({ length: page ? 2 : 11 }, (_, i) => ({
            symbol: `COIN${page ? i + 11 : i}USDT`,
            baseCoin: `COIN${i}`,
            status: "Trading",
            contractType: "LinearPerpetual",
            quoteCoin: "USDT",
            settleCoin: "USDT",
            lotSizeFilter: {
              qtyStep: "0.001",
              minOrderQty: "0.001",
              minNotionalValue: "5",
            },
            priceFilter: { tickSize: "0.01" },
          })),
        },
      });
    }
    if (url.pathname === "/v5/market/kline") {
      const start = Math.floor(Date.now() / 60_000) * 60_000 - 100 * 60_000;
      return Response.json({
        retCode: 0,
        result: {
          list: Array.from({ length: 100 }, (_, i) => [
            String(start + i * 60_000),
            "100",
            "100",
            "100",
            "100",
            "1",
          ]).reverse(),
        },
      });
    }
    throw new Error(`Unexpected public fixture route ${url.pathname}`);
  };
  return { calls, fetcher: fetcher as typeof fetch };
}
test("Bybit listing follows pagination beyond ten coins, and scanning resumes the full universe", async (t) => {
  const { store } = storage(t),
    f = publicFixture();
  const s = {
    ...DEFAULT_SETTINGS,
    exchange: "bybit" as const,
    requestsPerSecond: 8,
    scanBatchSize: 10,
  };
  store.set("settings", s);
  const market = new MarketData(() => s, f.fetcher),
    scanner = new Scanner(store, market);
  assert.equal((await market.getMarkets("bybit")).length, 13);
  assert.equal(scanner.start(true).accepted, true);
  assert.equal(scanner.start(true).accepted, false);
  await scanner.task;
  assert.equal(store.get<any>("scanner", {}).cursor, 10);
  scanner.start(true);
  await scanner.task;
  assert.equal(store.get<any>("scanner", {}).total, 13);
  assert.ok(store.get<any>("scanner", {}).lastFullPassAt > 0);
  assert.equal(
    new Set(
      f.calls
        .filter((u) => u.pathname.endsWith("kline"))
        .map((u) => u.searchParams.get("symbol")),
    ).size,
    13,
  );
});
test("simultaneous chart reads share one request and 429 pauses further upstream traffic", async () => {
  const f = publicFixture(),
    s = {
      ...DEFAULT_SETTINGS,
      exchange: "bybit" as const,
      requestsPerSecond: 8,
    };
  const m = new MarketData(() => s, f.fetcher);
  await Promise.all([
    m.getCandles("bybit", "COIN0USDT", "1m", 100, false),
    m.getCandles("bybit", "COIN0USDT", "1m", 100, false),
  ]);
  assert.equal(f.calls.filter((u) => u.pathname.endsWith("kline")).length, 1);
  let count = 0;
  const blocked = new MarketData(() => s, (async () => {
    count++;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }) as typeof fetch);
  await assert.rejects(blocked.getMarkets("bybit"));
  await assert.rejects(blocked.getMarkets("bybit"));
  assert.equal(count, 1);
});
test("exchange adapter sends reduceOnly on exits and never places a spot order", async (t) => {
  const { store } = storage(t),
    vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save("binance", "fixture", "fixture");
  const calls: any[] = [],
    market = {
      id: "BTCUSDT",
      symbol: "BTC/USDT:USDT",
      swap: true,
      linear: true,
      settle: "USDT",
      contractSize: 1,
    };
  const client: any = {
    loadMarkets: async () => {},
    markets: { [market.symbol]: market },
    market: () => market,
    createOrder: async (...args: any[]) => {
      calls.push(args);
      return { id: "1", filled: 0.25, average: 100, status: "closed" };
    },
  };
  const gateway = new ExchangeGateway(vault, async () => client);
  await gateway.submit(
    {
      id: "mon-close",
      exchange: "binance",
      symbol: "BTCUSDT",
      direction: "LONG",
      signal: signal(),
      quantity: 0.25,
      stopLoss: 99,
      takeProfit: 101,
      createdAt: Date.now(),
      kind: "close",
    },
    DEFAULT_SETTINGS,
  );
  assert.equal(calls[0][0], "BTC/USDT:USDT");
  assert.equal(calls[0][2], "sell");
  assert.equal(calls[0][5].reduceOnly, true);
});

test("HTTP authentication, CSRF, secret redaction and cron authorization protect every operation", async (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-http-"));
  const runtime = createApplication({
    directory,
    origin: "http://127.0.0.1:3010",
    username: "admin",
    passwordHash: await hashPassword("fixture-only-password"),
    encryptionKey: randomBytes(32).toString("base64"),
    cronSecret: "c".repeat(64),
    fetcher: (async () => {
      throw new Error("Network disabled in HTTP fixture");
    }) as typeof fetch,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal((await fetch(base + "/api/state")).status, 401);
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:3010",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "admin",
      password: "fixture-only-password",
    }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(login.headers.get("set-cookie")!, /SameSite=Strict/);
  const cookie = login.headers.get("set-cookie")!.split(";")[0],
    { csrf } = await login.json();
  assert.equal(
    (
      await fetch(base + "/api/scan", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3010",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/scan", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const headers = {
    Origin: "http://127.0.0.1:3010",
    Cookie: cookie,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(base + "/api/credentials/binance", {
        method: "POST",
        headers,
        body: JSON.stringify({
          apiKey: "private-http-fixture-key",
          apiSecret: "private-http-fixture-secret",
        }),
      })
    ).status,
    200,
  );
  const state = await fetch(base + "/api/state", {
    headers: { Cookie: cookie },
  });
  const stateText = await state.text();
  assert.equal(stateText.includes("private-http-fixture"), false);
  assert.match(stateText, /"configured":true/);
  assert.equal(
    (await fetch(base + "/api/cron/scan", { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/api/cron/scan", {
        method: "POST",
        headers: { Authorization: `Bearer ${"c".repeat(64)}` },
      })
    ).status,
    202,
  );
  await runtime.scanner.task;
});
