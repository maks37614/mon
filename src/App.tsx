import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Clock3,
  KeyRound,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  FORMATIONS,
  TIMEFRAMES,
  type Settings,
  type Signal,
} from "../backend/config";
import { HookChart, type HookChartProps } from "./components/HookChart";
import { api, setCsrf } from "./api";
import "./dashboard.css";

type Snapshot = {
  settings: Settings;
  positions: any[];
  history: any[];
  pending: any[];
  stats: any;
  scanner: any;
  signals: Signal[];
  logs: any[];
  credentials: Record<string, { configured: boolean; verified: boolean }>;
  liveAllowed: boolean;
  schedulerMode: string;
  apiPauses: Record<string, number>;
};
type ChartSelection = HookChartProps & { id: string; historical: boolean };
const money = (n: number) =>
  Number(n || 0).toLocaleString("uk-UA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const price = (n: number) =>
  Number(n || 0).toLocaleString("en-US", { maximumSignificantDigits: 9 });
const date = (at?: number | string) =>
  at
    ? new Intl.DateTimeFormat("uk-UA", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "Europe/Warsaw",
      }).format(new Date(at))
    : "Ще не було";

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api("/api/auth/login", { username, password });
      setCsrf(result.csrf);
      setPassword("");
      await onLogin();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="brand">
          <span>
            <img
              className="brand-logo"
              src="/h00k-auto-logo.svg"
              alt="h00k.auto"
              width={218}
              height={48}
            />
            <span className="brand-sub">Trading Terminal Platform</span>
          </span>
        </div>
        <div className="eyebrow">ПРИВАТНИЙ ДОСТУП</div>
        <h1>
          Ваш ринок.
          <br />
          Ваші правила.
        </h1>
        <p className="muted">
          Увійдіть, щоб відкрити скрінер, протестувати стратегію та керувати
          торгівлею.
        </p>
        <form onSubmit={submit}>
          <label>
            Логін
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={256}
            />
          </label>
          {error && (
            <div role="alert" className="notice error">
              {error}
            </div>
          )}
          <button className="primary wide" disabled={busy}>
            <LockKeyhole size={16} />
            {busy ? "Входимо…" : "Увійти до термінала"}
          </button>
        </form>
        <p className="login-foot">
          <ShieldCheck size={14} /> Дані торгівлі зберігаються на сервері
        </p>
      </div>
    </main>
  );
}

const fields: {
  key: keyof Settings;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step?: number;
}[] = [
  {
    key: "entryIntervalSeconds",
    label: "Інтервал пошуку входу, с",
    hint: "Перевірка готових свіжих сигналів; без повторного сканування біржі.",
    min: 5,
    max: 86400,
  },
  {
    key: "maxHoldingSeconds",
    label: "Максимальний час позиції, с",
    hint: "0 вимикає тайм-стоп. TP/SL продовжують працювати.",
    min: 0,
    max: 604800,
  },
  {
    key: "entryCooldownSeconds",
    label: "Пауза повторного входу в монету, с",
    min: 0,
    max: 86400,
  },
  {
    key: "maxSignalAgeSeconds",
    label: "Максимальний вік після закриття свічки, с",
    hint: "Для старших таймфреймів збільште цей інтервал.",
    min: 30,
    max: 86400,
  },
  {
    key: "orderNotionalUsdt",
    label: "Номінальний обсяг ордера, USDT",
    hint: "Повний обсяг позиції; маржа дорівнює обсягу / плечу.",
    min: 5,
    max: 100000,
    step: 0.01,
  },
  { key: "leverage", label: "Плече", min: 1, max: 20 },
  { key: "maxPositions", label: "Максимум відкритих позицій", min: 1, max: 20 },
  {
    key: "takeProfitPercent",
    label: "Take Profit, %",
    min: 0.05,
    max: 50,
    step: 0.01,
  },
  {
    key: "stopLossPercent",
    label: "Stop Loss, %",
    min: 0.05,
    max: 25,
    step: 0.01,
  },
  {
    key: "slippageTolerancePercent",
    label: "Допустиме відхилення від сигналу, %",
    min: 0.01,
    max: 5,
    step: 0.01,
  },
  {
    key: "takerFeePercent",
    label: "Комісія симуляції за сторону, %",
    min: 0,
    max: 1,
    step: 0.001,
  },
  {
    key: "initialBalance",
    label: "Початковий віртуальний баланс, USDT",
    min: 10,
    max: 1e7,
    step: 1,
  },
];
const scannerFields = [
  {
    key: "scanIntervalSeconds",
    label: "Мінімальний інтервал сканування, с",
    min: 60,
    max: 86400,
  },
  {
    key: "scanBatchSize",
    label: "Пар / таймфреймів у пакеті",
    min: 10,
    max: 1000,
  },
  {
    key: "requestsPerSecond",
    label: "Максимум запитів за секунду",
    min: 1,
    max: 8,
  },
  { key: "candleLimit", label: "Свічок для аналізу", min: 100, max: 1000 },
  { key: "minScore", label: "Мінімальна оцінка формації", min: 50, max: 100 },
] as const;

function Credentials({
  exchange,
  status,
  run,
}: {
  exchange: string;
  status: Snapshot["credentials"][string];
  run: (fn: () => Promise<any>, message?: string) => Promise<boolean>;
}) {
  const [apiKey, setKey] = useState(""),
    [apiSecret, setSecret] = useState("");
  return (
    <div className="credential-card">
      <div className="section-heading">
        <h3>
          {exchange === "binance" ? "Binance USDⓈ-M" : "Bybit USDT Perpetual"}
        </h3>
        <span className={`pill ${status.verified ? "positive" : ""}`}>
          {status.verified
            ? "Перевірено"
            : status.configured
              ? "Ключі збережено"
              : "Не підключено"}
        </span>
      </div>
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run(
              () => api(`/api/credentials/${exchange}`, { apiKey, apiSecret }),
              "Ключі збережено на сервері",
            )
          ) {
            setKey("");
            setSecret("");
          }
        }}
      >
        <label>
          API Key
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setKey(e.target.value)}
            required
            maxLength={512}
            placeholder="Введіть новий ключ"
          />
        </label>
        <label>
          API Secret
          <input
            type="password"
            autoComplete="new-password"
            value={apiSecret}
            onChange={(e) => setSecret(e.target.value)}
            required
            maxLength={512}
            placeholder="Секрет не повертається у браузер"
          />
        </label>
        <div className="button-row">
          <button type="submit">
            <KeyRound size={14} />
            Зберегти ключі
          </button>
          <button
            type="button"
            disabled={!status.configured}
            onClick={() =>
              run(async () => {
                const result = await api(
                  `/api/credentials/${exchange}/test`,
                  {},
                );
                return result;
              }, "Підключення та режим One-way перевірено")
            }
          >
            Перевірити доступ
          </button>
          <button
            type="button"
            className="danger-text"
            disabled={!status.configured}
            onClick={() => {
              if (confirm("Видалити збережені ключі цієї біржі?"))
                void run(
                  () => api(`/api/credentials/${exchange}`, {}, "DELETE"),
                  "Ключі видалено",
                );
            }}
          >
            Видалити
          </button>
        </div>
      </form>
    </div>
  );
}

function SettingsPanel({
  data,
  run,
}: {
  data: Snapshot;
  run: (fn: () => Promise<any>, message?: string) => Promise<boolean>;
}) {
  const [form, setForm] = useState<Settings>({ ...data.settings }),
    [ack, setAck] = useState(false);
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const toggle = (key: "timeframes" | "formationTypes", item: string) =>
    setForm((s) => ({
      ...s,
      [key]: s[key].includes(item)
        ? s[key].filter((x) => x !== item)
        : [...s[key], item],
    }));
  return (
    <div className="settings-stack">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api(
                "/api/settings",
                { settings: form, liveAcknowledged: ack },
                "PUT",
              ),
            "Налаштування збережено",
          );
        }}
      >
        <div className="section-heading">
          <div>
            <h2>Стратегія та виконання</h2>
            <p className="muted">
              Налаштування виконуються на сервері, навіть коли браузер закрито.
            </p>
          </div>
          <button className="primary" type="submit">
            Зберегти зміни
          </button>
        </div>
        <div className="form-grid">
          <label>
            Біржа
            <select
              value={form.exchange}
              onChange={(e) =>
                setForm({
                  ...form,
                  exchange: e.target.value as Settings["exchange"],
                  autoEntries: false,
                })
              }
            >
              <option value="binance">Binance · USDT perpetual</option>
              <option value="bybit">Bybit · USDT perpetual</option>
            </select>
          </label>
          <label>
            Режим торгівлі
            <select
              value={form.mode}
              onChange={(e) => {
                setForm({
                  ...form,
                  mode: e.target.value as Settings["mode"],
                  autoEntries: false,
                });
                setAck(false);
              }}
            >
              <option value="paper">Віртуальна · реальні котирування</option>
              <option value="live" disabled={!data.liveAllowed}>
                Реальна · реальні кошти
              </option>
            </select>
          </label>
        </div>
        {!data.liveAllowed && (
          <div className="notice">
            Віртуальний режим готовий. Для реального режиму власник VPS має
            встановити ENABLE_LIVE_TRADING=true; потім перевірте API-ключі.
          </div>
        )}
        {form.mode === "live" && (
          <label className="notice error check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            Я розумію, що цей режим надсилає реальні ордери на вибрану біржу.
          </label>
        )}
        <div className="check-row">
          <label className="check">
            <input
              type="checkbox"
              checked={form.autoEntries}
              onChange={(e) =>
                setForm({ ...form, autoEntries: e.target.checked })
              }
            />
            Автоматичні входи
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.reverseEnabled}
              onChange={(e) =>
                setForm({ ...form, reverseEnabled: e.target.checked })
              }
            />
            Реверс напрямку
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.confirmedOnly}
              onChange={(e) =>
                setForm({ ...form, confirmedOnly: e.target.checked })
              }
            />
            Лише підтверджені формації
          </label>
        </div>
        <div className="form-grid">
          {fields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step || 1}
                required
                value={form[f.key] as number}
                onChange={(e) =>
                  setForm({
                    ...form,
                    [f.key]:
                      e.target.value === "" ? "" : Number(e.target.value),
                  } as Settings)
                }
              />
              {f.hint && <small>{f.hint}</small>}
            </label>
          ))}
        </div>
        <div className="divider" />
        <h2>Сканування всіх монет</h2>
        <p className="muted">
          Усі активні USDT perpetual контракти вибраної біржі. Черга
          обробляється пакетами; нові монети додаються автоматично. Додавання
          таймфреймів збільшує час повного проходу.
        </p>
        <fieldset>
          <legend>Таймфрейми</legend>
          <div className="check-row">
            {TIMEFRAMES.map((tf) => (
              <label className="check" key={tf}>
                <input
                  type="checkbox"
                  checked={form.timeframes.includes(tf)}
                  onChange={() => toggle("timeframes", tf)}
                />
                {tf}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-grid">
          {scannerFields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                required
                min={f.min}
                max={f.max}
                step={1}
                value={form[f.key]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    [f.key]:
                      e.target.value === "" ? "" : Number(e.target.value),
                  } as Settings)
                }
              />
            </label>
          ))}
        </div>
        <fieldset>
          <legend>Типи формацій · {FORMATIONS.length} детекторів</legend>
          <div className="pattern-options">
            {FORMATIONS.map((name) => (
              <label className="check" key={name}>
                <input
                  type="checkbox"
                  checked={form.formationTypes.includes(name)}
                  onChange={() => toggle("formationTypes", name)}
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="notice">
          Віртуальні угоди використовують поточні ціни та задану комісію.
          Прослизання, funding і ліквідації не моделюються; результати симуляції
          не дорівнюють реальному виконанню.
        </div>
        <div className="button-row">
          <button className="primary" type="submit">
            Зберегти налаштування
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                confirm("Скинути історію та баланс лише віртуального режиму?")
              )
                void run(
                  () => api("/api/paper/reset", {}),
                  "Віртуальний рахунок скинуто",
                );
            }}
          >
            Скинути віртуальний рахунок
          </button>
        </div>
      </form>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Підключення бірж</h2>
            <p className="muted">
              Ключі шифруються на сервері. Потрібні дозволи читання та торгівлі
              деривативами; використовуйте One-way Mode. Ключі з правом
              виведення коштів не потрібні.
            </p>
          </div>
          <KeyRound size={22} />
        </div>
        <div className="credentials-grid">
          {["binance", "bybit"].map((exchange) => (
            <Credentials
              key={exchange}
              exchange={exchange}
              status={data.credentials[exchange]}
              run={run}
            />
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Пароль входу</h2>
        <form
          className="form-grid password-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await run(async () => {
                const result = await api("/api/auth/password", {
                  currentPassword,
                  newPassword,
                });
                setCsrf(result.csrf);
              }, "Пароль змінено, інші сесії завершено")
            ) {
              setCurrentPassword("");
              setNewPassword("");
            }
          }}
        >
          <label>
            Поточний пароль
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>
          <label>
            Новий пароль · від 12 символів
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit">Змінити пароль</button>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [data, setData] = useState<Snapshot | null>(null),
    [tab, setTab] = useState("overview");
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [chart, setChart] = useState<ChartSelection | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Snapshot>("/api/state");
      setData(next);
      setAuthenticated(true);
    } catch (e: any) {
      if (e.status === 401) {
        setAuthenticated(false);
        setData(null);
        setCsrf("");
      } else throw e;
    }
  }, []);
  useEffect(() => {
    api("/api/auth/session")
      .then(async (session) => {
        if (session.authenticated) {
          setCsrf(session.csrf);
          await refresh();
        } else setAuthenticated(false);
      })
      .catch((e) => {
        setError(e.message);
        setAuthenticated(false);
      });
  }, [refresh]);
  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, refresh]);
  useEffect(() => {
    if (!chart) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChart(null);
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", close);
    };
  }, [chart]);
  async function run(fn: () => Promise<any>, success = "") {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
      setMessage(success);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (authenticated === null)
    return <div className="loading-page">Підключення до термінала…</div>;
  if (!authenticated) return <Login onLogin={refresh} />;
  if (!data) return <div className="loading-page">Завантаження даних…</div>;
  const s = data.settings,
    scan = data.scanner,
    live = s.mode === "live";
  function openChart(item: any, historical = false) {
    const timeframe = item.timeframe || s.timeframes[0];
    setChart({
      id: item.id,
      historical,
      exchange: item.exchange || s.exchange,
      symbol: item.symbol,
      direction: item.direction,
      entryPrice: item.entryPrice,
      takeProfit: item.takeProfit,
      stopLoss: item.stopLoss,
      entryTimestamp: item.openedAt || item.candleAt,
      focusAt: historical ? item.openedAt : undefined,
      formationName: item.formation || item.formationName,
      initialTimeframe: TIMEFRAMES.includes(timeframe) ? timeframe : "1m",
    });
  }
  const signals = data.signals.filter((signal) =>
    `${signal.symbol} ${signal.formation}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const remaining = scan.total ? scan.total - (scan.cursor || 0) : 0;
  const minutes = scan.total
    ? (Math.ceil(scan.total / s.scanBatchSize) *
        Math.max(60, s.scanIntervalSeconds)) /
      60
    : 0;
  const confirmLive = (text: string) =>
    !live ||
    confirm(
      `${text}\nБуде надіслано реальний ордер на ${s.exchange === "binance" ? "Binance" : "Bybit"}.`,
    );
  function exportCsv() {
    const rows = [
      [
        "Монета",
        "Напрям",
        "Вхід",
        "Вихід",
        "Кількість",
        "PnL",
        "Комісія",
        "Закрито",
      ],
      ...data!.history.map((t) => [
        t.symbol,
        t.direction,
        t.entryPrice,
        t.exitPrice,
        t.quantity,
        t.netPnl,
        t.fee,
        date(t.closedAt),
      ]),
    ];
    const csv =
      "\uFEFF" +
      rows
        .map((r) =>
          r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(";"),
        )
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `evgen-${s.mode}-trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="terminal">
      <header className="topbar">
        <a className="brand" href="/">
          <span>
            <img
              className="brand-logo"
              src="/h00k-auto-logo.svg"
              alt="h00k.auto"
              width={218}
              height={48}
            />
            <span className="brand-sub">Trading Terminal Platform</span>
          </span>
        </a>
        <div className="topbar-right">
          <span className={`pill ${live ? "live" : "positive"}`}>
            <span className="dot" />
            {live ? "Реальна торгівля" : "Віртуальна торгівля"}
          </span>
          <span className="exchange-name">{s.exchange.toUpperCase()}</span>
          <button
            className="icon-button"
            title="Вийти"
            aria-label="Вийти"
            onClick={() =>
              run(async () => {
                await api("/api/auth/logout", {});
                setAuthenticated(false);
                setCsrf("");
              })
            }
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <nav className="mobile-nav" aria-label="Основна навігація">
        {[
          { id: "overview", label: "Огляд" },
          { id: "screener", label: "Скрінер" },
          { id: "settings", label: "Налаштування" },
          { id: "logs", label: "Журнал" },
        ].map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "selected" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <aside className="sidebar">
          <div className="eyebrow">РОБОЧИЙ ПРОСТІР</div>
          {[
            { id: "overview", label: "Огляд торгівлі", Icon: Activity },
            { id: "screener", label: "Скрінер формацій", Icon: BarChart3 },
            { id: "settings", label: "Налаштування", Icon: Settings2 },
            { id: "logs", label: "Журнал подій", Icon: Clock3 },
          ].map(({ id, label, Icon }) => (
            <button
              className={`nav-item ${tab === id ? "selected" : ""}`}
              key={id}
              onClick={() => setTab(id)}
            >
              <Icon size={18} />
              {label}
              {id === "screener" && (
                <span className="count">{data.signals.length}</span>
              )}
            </button>
          ))}
          <div className="sidebar-note">
            <ShieldCheck size={18} />
            <strong>Серверний двигун</strong>
            <span>Позиції та таймери працюють незалежно від браузера.</span>
          </div>
        </aside>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {live ? "РЕАЛЬНИЙ РАХУНОК" : "ТЕСТУВАННЯ НА РЕАЛЬНОМУ РИНКУ"}
              </div>
              <h1>
                {tab === "settings"
                  ? "Налаштування термінала"
                  : tab === "screener"
                    ? "Формації на всьому ринку"
                    : tab === "logs"
                      ? "Журнал подій"
                      : "Огляд торгівлі"}
              </h1>
              <p className="muted">
                USDT perpetual · {s.timeframes.join(" / ")} ·{" "}
                {s.autoEntries
                  ? "Автоматичні входи увімкнено"
                  : "Автоматичні входи на паузі"}
              </p>
            </div>
            <button
              disabled={busy || scan.running}
              onClick={() =>
                run(
                  () => api("/api/scan", {}),
                  "Пакет сканування запущено або вже виконується",
                )
              }
            >
              <RefreshCw size={16} className={scan.running ? "spinning" : ""} />
              {scan.running ? "Скануємо…" : "Сканувати пакет"}
            </button>
          </div>
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button
                className="icon-button"
                aria-label="Закрити помилку"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {message && (
            <div role="status" className="notice success">
              {message}
            </div>
          )}
          {data.pending.length > 0 && (
            <div className="notice error">
              <strong>
                Є ордери, результат яких потрібно узгодити з біржею.
              </strong>{" "}
              Повторне надсилання заблоковано.{" "}
              {data.pending.map((p) => `${p.symbol}: ${p.error}`).join(" · ")}
              <button
                onClick={() =>
                  run(() => api("/api/reconcile", {}), "Стан біржі оновлено")
                }
              >
                Синхронізувати
              </button>
            </div>
          )}
          {Object.entries(data.apiPauses)
            .filter(([, at]) => at > Date.now())
            .map(([exchange, at]) => (
              <div key={exchange} className="notice error">
                Ліміт API {exchange}: запити призупинено до {date(at)}.
              </div>
            ))}
          {tab === "settings" ? (
            <SettingsPanel data={data} run={run} />
          ) : tab === "logs" ? (
            <section className="panel">
              <div className="section-heading">
                <h2>Останні 400 подій</h2>
                <span className="muted">Час: Варшава</span>
              </div>
              <div className="event-list">
                {data.logs.length ? (
                  data.logs.map((log) => (
                    <div className="event-row" key={log.id}>
                      <time>{date(log.timestamp)}</time>
                      <span className={`event-level ${log.level}`}>
                        {log.level}
                      </span>
                      <span>{log.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="empty">
                    Події з’являться після першого сканування.
                  </div>
                )}
              </div>
            </section>
          ) : (
            <>
              <div className="metrics">
                {[
                  {
                    label: live ? "Баланс біржі" : "Віртуальний баланс",
                    value: money(data.stats.balance),
                    unit: "USDT",
                    Icon: CircleDollarSign,
                  },
                  {
                    label: "Відкритий P&L",
                    value: `${data.stats.unrealizedPnl >= 0 ? "+" : ""}${money(data.stats.unrealizedPnl)}`,
                    unit: "USDT",
                    positive: data.stats.unrealizedPnl >= 0,
                    Icon: Activity,
                  },
                  {
                    label: "Відкриті позиції",
                    value: `${data.positions.length}`,
                    unit: `/ ${s.maxPositions}`,
                    Icon: BarChart3,
                  },
                  {
                    label: "Закритий P&L",
                    value: `${data.stats.closedNetPnl >= 0 ? "+" : ""}${money(data.stats.closedNetPnl)}`,
                    unit: "USDT",
                    positive: data.stats.closedNetPnl >= 0,
                    Icon: Clock3,
                  },
                ].map((m) => (
                  <div className="metric" key={m.label}>
                    <div>
                      <span>{m.label}</span>
                      <m.Icon size={17} />
                    </div>
                    <strong
                      className={
                        m.positive === true
                          ? "positive-text"
                          : m.positive === false
                            ? "negative-text"
                            : ""
                      }
                    >
                      {m.value}
                      <small>{m.unit}</small>
                    </strong>
                  </div>
                ))}
              </div>
              <section className="panel coverage-panel">
                <div>
                  <div className="section-heading">
                    <h2>Охоплення ринку</h2>
                    <span className={`pill ${scan.running ? "positive" : ""}`}>
                      {scan.running ? "Обробка пакета" : "Очікування розкладу"}
                    </span>
                  </div>
                  <div className="coverage-values">
                    <span>
                      <strong>{scan.symbols || "—"}</strong> активних контрактів
                    </span>
                    <span>
                      <strong>{scan.total || "—"}</strong> пар / таймфреймів у
                      черзі
                    </span>
                    <span>
                      <strong>{FORMATIONS.length}</strong> типів формацій
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      style={{
                        width: `${scan.total ? ((scan.cursor || 0) / scan.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <p className="muted">
                    Наступний індекс: {scan.cursor || 0} · до кінця проходу:{" "}
                    {remaining || "—"} · повний прохід:{" "}
                    {date(scan.lastFullPassAt)}
                  </p>
                </div>
                <div className="coverage-aside">
                  <span className="eyebrow">
                    {data.schedulerMode === "external"
                      ? "ЗОВНІШНІЙ CRON"
                      : "ВНУТРІШНІЙ РОЗКЛАД"}
                  </span>
                  <strong>{s.scanBatchSize} за пакет</strong>
                  <span className="muted">
                    Орієнтовний повний цикл:{" "}
                    {minutes ? `від ${minutes} хв` : "після завантаження ринку"}
                    . Фактичний час залежить від API та розкладу.
                  </span>
                  <span className="muted">
                    Останній запуск: {date(scan.lastStartedAt)}
                  </span>
                  {scan.error && (
                    <span className="negative-text">{scan.error}</span>
                  )}
                </div>
              </section>
              {tab === "overview" && (
                <>
                  <section className="panel">
                    <div className="section-heading">
                      <h2>
                        Відкриті позиції{" "}
                        <span className="muted">{data.positions.length}</span>
                      </h2>
                      <span className="muted">Супровід кожні 5 секунд</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Контракт</th>
                            <th>Напрям</th>
                            <th>Вхід / поточна</th>
                            <th>TP / SL</th>
                            <th>P&L</th>
                            <th>Тайм-стоп</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {data.positions.map((p) => (
                            <tr key={p.id}>
                              <td>
                                <button
                                  className="link-button chart-symbol"
                                  title={`Відкрити HookChart ${p.symbol}: вхід, ціль, стоп`}
                                  aria-haspopup="dialog"
                                  onClick={() => openChart(p)}
                                >
                                  {p.symbol}
                                  <BarChart3 size={13} aria-hidden="true" />
                                </button>
                                <small>
                                  {p.status === "active"
                                    ? p.formation
                                    : p.status}
                                </small>
                              </td>
                              <td>
                                <span
                                  className={`pill ${p.direction === "LONG" ? "positive" : "live"}`}
                                >
                                  {p.direction}
                                </span>
                              </td>
                              <td>
                                {price(p.entryPrice)}
                                <small>{price(p.currentPrice)}</small>
                              </td>
                              <td>
                                {price(p.takeProfit)}
                                <small className="negative-text">
                                  {price(p.stopLoss)}
                                </small>
                              </td>
                              <td
                                className={
                                  p.unrealizedPnl >= 0
                                    ? "positive-text"
                                    : "negative-text"
                                }
                              >
                                {money(p.unrealizedPnl)}
                              </td>
                              <td>
                                {p.expiresAt ? date(p.expiresAt) : "Вимкнено"}
                              </td>
                              <td>
                                <button
                                  disabled={busy || p.status === "closing"}
                                  onClick={() => {
                                    if (confirmLive(`Закрити ${p.symbol}?`))
                                      void run(
                                        () =>
                                          api(`/api/positions/${p.id}/close`, {
                                            liveAcknowledged: live,
                                          }),
                                        "Запит закриття опрацьовано",
                                      );
                                  }}
                                >
                                  Закрити
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!data.positions.length && (
                        <div className="empty">
                          <BarChart3 size={28} />
                          <strong>Відкритих позицій немає</strong>
                          <span>
                            Оберіть сигнал зі скрінера або увімкніть автоматичні
                            входи в налаштуваннях.
                          </span>
                        </div>
                      )}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="section-heading">
                      <h2>Історія угод</h2>
                      <button
                        disabled={!data.history.length}
                        onClick={exportCsv}
                      >
                        Експорт CSV
                      </button>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Контракт</th>
                            <th>Напрям</th>
                            <th>Вхід</th>
                            <th>Вихід</th>
                            <th>Чистий P&L</th>
                            <th>Причина</th>
                            <th>Закрито</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.history.slice(0, 100).map((t) => (
                            <tr key={t.id}>
                              <td>
                                <button
                                  className="link-button chart-symbol"
                                  title={`Відкрити HookChart угоди ${t.symbol}: вхід, ціль, стоп`}
                                  aria-haspopup="dialog"
                                  onClick={() => openChart(t, true)}
                                >
                                  {t.symbol}
                                  <BarChart3 size={13} aria-hidden="true" />
                                </button>
                              </td>
                              <td>{t.direction}</td>
                              <td>{price(t.entryPrice)}</td>
                              <td>{price(t.exitPrice)}</td>
                              <td
                                className={
                                  t.netPnl >= 0
                                    ? "positive-text"
                                    : "negative-text"
                                }
                              >
                                {money(t.netPnl)}
                                {!t.estimated && t.feesComplete === false ? (
                                  <small>Комісії неповні</small>
                                ) : null}
                              </td>
                              <td>{t.reason}</td>
                              <td>{date(t.closedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!data.history.length && (
                        <div className="empty">
                          Тут з’являться завершені угоди вибраного режиму.
                        </div>
                      )}
                    </div>
                  </section>
                </>
              )}
              {tab === "screener" && (
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Свіжі формації{" "}
                        <span className="muted">{signals.length}</span>
                      </h2>
                      <p className="muted">
                        Пошук на закритих свічках. Якщо патернів немає, сигнали
                        не вигадуються.
                      </p>
                    </div>
                    <input
                      className="search"
                      aria-label="Пошук монети або формації"
                      placeholder="Монета або формація…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Контракт / TF</th>
                          <th>Формація</th>
                          <th>Напрям</th>
                          <th>Точка входу</th>
                          <th>Оцінка</th>
                          <th>Статус</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {signals.map((signal) => (
                          <tr key={signal.id}>
                            <td>
                              <button
                                className="link-button chart-symbol"
                                title={`Відкрити HookChart ${signal.symbol}: вхід, ціль, стоп`}
                                aria-haspopup="dialog"
                                onClick={() => openChart(signal)}
                              >
                                {signal.symbol}
                                <BarChart3 size={13} aria-hidden="true" />
                              </button>
                              <small>{signal.timeframe}</small>
                            </td>
                            <td>{signal.formation}</td>
                            <td>
                              <span
                                className={`pill ${signal.direction === "LONG" ? "positive" : "live"}`}
                              >
                                {signal.direction}
                              </span>
                            </td>
                            <td>{price(signal.entryPrice)}</td>
                            <td>{signal.confidence}/100</td>
                            <td>
                              {signal.status === "confirmed"
                                ? "Підтверджена"
                                : "Формується"}
                              <small>{date(signal.candleAt)}</small>
                            </td>
                            <td>
                              <button
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    confirmLive(
                                      `Відкрити ${signal.symbol} ${signal.direction} на ${s.orderNotionalUsdt} USDT?`,
                                    )
                                  )
                                    void run(
                                      () =>
                                        api(`/api/signals/${signal.id}/enter`, {
                                          liveAcknowledged: live,
                                        }),
                                      "Запит входу опрацьовано",
                                    );
                                }}
                              >
                                {live ? "Реальний вхід" : "Тестовий вхід"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!signals.length && (
                      <div className="empty">
                        <Activity size={28} />
                        <strong>Свіжих формацій за цими фільтрами немає</strong>
                        <span>
                          Запустіть сканування або дочекайтеся наступного
                          зовнішнього cron.
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
          <footer>
            EVGEN · {live ? "Реальний" : "Віртуальний"} рахунок · Час:
            Europe/Warsaw · Дані{" "}
            {s.exchange === "binance" ? "Binance" : "Bybit"}
          </footer>
        </main>
      </div>
      {chart && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Графік ${chart.symbol}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setChart(null);
          }}
        >
          <div className="chart-modal">
            <div className="section-heading">
              <strong>
                HookChart · {chart.symbol} · {chart.exchange.toUpperCase()}
              </strong>
              <button
                className="icon-button"
                aria-label="Закрити графік"
                autoFocus
                onClick={() => setChart(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="trade-levels" aria-label="Рівні угоди">
              <span className="entry-level">
                Вхід <strong>{price(chart.entryPrice)}</strong>
              </span>
              <span className="target-level">
                Ціль (TP) <strong>{chart.takeProfit ? price(chart.takeProfit) : "—"}</strong>
              </span>
              <span className="stop-level">
                Стоп (SL) <strong>{chart.stopLoss ? price(chart.stopLoss) : "—"}</strong>
              </span>
            </div>
            {chart.historical && (!chart.takeProfit || !chart.stopLoss) && (
              <p className="muted chart-history-note">
                У старому записі угоди ціль і стоп не збережені. Для нових угод
                ці рівні зберігаються автоматично.
              </p>
            )}
            <HookChart
              key={`${chart.exchange}:${chart.id}`}
              exchange={chart.exchange}
              symbol={chart.symbol}
              entryPrice={chart.entryPrice}
              stopLoss={chart.stopLoss}
              takeProfit={chart.takeProfit}
              direction={chart.direction}
              entryTimestamp={chart.entryTimestamp}
              focusAt={chart.focusAt}
              formationName={chart.formationName}
              initialTimeframe={chart.initialTimeframe}
              height={520}
            />
          </div>
        </div>
      )}
    </div>
  );
}
