import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./backend/store";
import { Auth, Vault, safeEqual } from "./backend/security";
import { MarketData } from "./backend/market";
import { Scanner } from "./backend/scanner";
import { Trading } from "./backend/trading";
import { ExchangeGateway, exchangeError } from "./backend/exchange";
import { DEFAULT_SETTINGS, type Exchange } from "./backend/config";

type Options = {
  directory: string;
  origin: string;
  username: string;
  passwordHash: string;
  encryptionKey: string;
  cronSecret: string;
  liveAllowed?: boolean;
  schedulerMode?: string;
  fetcher?: typeof fetch;
  gatewayFactory?: any;
  weightBudget?: number;
};
const route =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

export function createApplication(options: Options) {
  const origin = new URL(options.origin).origin;
  if (
    origin !== options.origin ||
    (!origin.startsWith("https://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  )
    throw new Error(
      "APP_ORIGIN має містити точну HTTPS-адресу без завершального слеша",
    );
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(options.passwordHash))
    throw new Error("Налаштуйте ADMIN_PASSWORD_HASH командою npm run password");
  if (options.cronSecret.length < 32)
    throw new Error("CRON_SECRET має містити щонайменше 32 випадкові символи");
  const store = new Store(options.directory),
    vault = new Vault(store, options.encryptionKey);
  const market = new MarketData(
    () => store.get("settings", DEFAULT_SETTINGS),
    options.fetcher,
    options.weightBudget,
  );
  const scanner = new Scanner(store, market),
    gateway = new ExchangeGateway(vault, options.gatewayFactory);
  const trading = new Trading(
    store,
    market,
    vault,
    gateway,
    options.liveAllowed === true,
  );
  const auth = new Auth(
    store,
    origin,
    options.username,
    options.passwordHash,
    origin.startsWith("https://"),
  );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (process.env.NODE_ENV !== "development")
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://s.tradingview.com https://www.tradingview.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      );
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/healthz", (_req, res) => res.json({ ok: true, app: "mon" }));
  app.post("/api/cron/scan", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !safeEqual(req.get("authorization") || "", `Bearer ${options.cronSecret}`)
    )
      return res.status(401).json({ error: "Unauthorized" });
    const result = scanner.start();
    res.status(result.accepted ? 202 : 200).json(result);
  });
  app.use(
    "/api",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    auth.originGuard,
  );
  app.get("/api/auth/session", (req, res) => {
    const session = auth.session(req);
    res.json(
      session
        ? {
            authenticated: true,
            csrf: session.csrf,
            username: options.username,
          }
        : { authenticated: false },
    );
  });
  app.post("/api/auth/login", route(auth.login));
  app.use("/api", auth.require);
  app.post("/api/auth/logout", auth.logout);
  app.post("/api/auth/password", route(auth.changePassword));
  app.get("/api/state", (_req, res) => {
    const state = trading.snapshot();
    state.scanner.running = scanner.running;
    res.json({
      ...state,
      apiPauses: market.status(),
      schedulerMode: options.schedulerMode || "external",
      formationCount: DEFAULT_SETTINGS.formationTypes.length,
    });
  });
  app.put(
    "/api/settings",
    route(async (req, res) => {
      const previous = trading.settings(),
        incoming = req.body.settings;
      if (
        scanner.running &&
        incoming &&
        ["exchange", "timeframes", "candleLimit"].some(
          (k) =>
            JSON.stringify(incoming[k]) !==
            JSON.stringify(previous[k as keyof typeof previous]),
        )
      )
        return res
          .status(409)
          .json({
            error:
              "Дочекайтеся завершення поточного пакета сканування перед зміною ринку або таймфреймів",
          });
      if (incoming?.mode === "live" && req.body.liveAcknowledged !== true)
        return res
          .status(400)
          .json({ error: "Підтвердьте використання реальних коштів" });
      res.json(await trading.updateSettings(incoming));
    }),
  );
  app.post("/api/scan", (_req, res) => {
    const result = scanner.start();
    res.status(result.accepted ? 202 : 200).json(result);
  });
  const exchangeParam = (req: Request): Exchange => {
    if (!["binance", "bybit"].includes(String(req.params.exchange)))
      throw new Error("Невідома біржа");
    return req.params.exchange as Exchange;
  };
  app.post(
    "/api/credentials/:exchange",
    route((req, res) => {
      const exchange = exchangeParam(req);
      if (trading.hasLiveExposure())
        throw new Error(
          "Не можна змінювати ключі під час відкритих або неузгоджених реальних позицій",
        );
      if (trading.settings().mode === "live")
        throw new Error("Перед зміною ключів перейдіть у віртуальний режим");
      vault.save(
        exchange,
        String(req.body.apiKey || "").trim(),
        String(req.body.apiSecret || "").trim(),
      );
      gateway.invalidate(exchange);
      res.json(vault.status(exchange));
    }),
  );
  app.delete(
    "/api/credentials/:exchange",
    route((req, res) => {
      const exchange = exchangeParam(req);
      if (trading.hasLiveExposure() || trading.settings().mode === "live")
        throw new Error(
          "Спочатку закрийте реальні позиції та вимкніть реальний режим",
        );
      vault.remove(exchange);
      gateway.invalidate(exchange);
      res.json({ configured: false, verified: false });
    }),
  );
  app.post(
    "/api/credentials/:exchange/test",
    route(async (req, res) =>
      res.json(await trading.verifyCredentials(exchangeParam(req))),
    ),
  );
  app.post(
    "/api/signals/:id/enter",
    route(async (req, res) => {
      if (
        trading.settings().mode === "live" &&
        req.body.liveAcknowledged !== true
      )
        throw new Error("Підтвердьте реальний ордер");
      await trading.enter(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/positions/:id/close",
    route(async (req, res) => {
      if (
        trading.settings().mode === "live" &&
        req.body.liveAcknowledged !== true
      )
        throw new Error("Підтвердьте реальне закриття");
      await trading.closePosition(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/paper/reset",
    route(async (_req, res) => {
      await trading.resetPaper();
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/reconcile",
    route(async (_req, res) => {
      await trading.monitor();
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/market/klines",
    route(async (req, res) => {
      const s = trading.settings();
      const exchange = req.query.exchange ?? s.exchange;
      if (exchange !== "binance" && exchange !== "bybit")
        throw new Error("Невідома біржа графіка");
      const data = await market.getCandles(
        exchange,
        String(req.query.symbol || "BTCUSDT"),
        String(req.query.interval || "1m"),
        Number(req.query.limit || 160),
        false,
        req.query.endTime === undefined ? undefined : Number(req.query.endTime),
      );
      res.json(data);
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint не знайдено" }),
  );
  const staticDirectory = path.resolve("dist");
  app.use(
    express.static(staticDirectory, {
      index: false,
      maxAge: "1h",
      dotfiles: "deny",
    }),
  );
  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(staticDirectory, "index.html"));
  });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const message =
      error?.name === "Error" &&
      !/https?:|api.?key|signature|secret|password/i.test(error.message || "")
        ? error.message
        : error?.type === "entity.parse.failed"
          ? "Некоректний JSON"
          : exchangeError(error);
    res.status(400).json({ error: message });
  });
  let scheduler: ReturnType<typeof setInterval> | null = null;
  return {
    app,
    store,
    vault,
    trading,
    market,
    scanner,
    gateway,
    start() {
      trading.start();
      if (options.schedulerMode === "internal")
        scheduler = setInterval(() => scanner.start(), 10_000);
    },
    async stop() {
      if (scheduler) clearInterval(scheduler);
      await trading.stop();
      if (scanner.task) await scanner.task;
      store.close();
    },
  };
}

async function main() {
  const runtime = createApplication({
    directory: process.env.DATA_DIR || "./data",
    origin: process.env.APP_ORIGIN || "https://evgen.h00k.top",
    username: process.env.ADMIN_USERNAME || "admin",
    passwordHash: process.env.ADMIN_PASSWORD_HASH || "",
    encryptionKey: process.env.ENCRYPTION_KEY || "",
    cronSecret: process.env.CRON_SECRET || "",
    liveAllowed: process.env.ENABLE_LIVE_TRADING === "true",
    schedulerMode: process.env.SCHEDULER_MODE || "external",
    weightBudget: Number(process.env.BINANCE_WEIGHT_BUDGET || 1000),
  });
  const host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT || 3010);
  if (process.env.NODE_ENV === "development") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    const layers = (runtime.app as any)._router.stack;
    const fallbackIndex = layers.findIndex(
      (layer: any) => layer.route?.path === "*",
    );
    runtime.app.use(vite.middlewares);
    const layer = layers.pop();
    layers.splice(fallbackIndex, 0, layer);
  }
  const server = runtime.app.listen(port, host, () =>
    console.log(`mon listening on ${host}:${port}`),
  );
  runtime.start();
  const shutdown = () => {
    server.close();
    void runtime.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
