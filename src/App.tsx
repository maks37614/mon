import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Clock3,
  ExternalLink,
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
  type TradeHistoryEntry,
} from "../backend/config";
import { HookChart, type HookChartProps } from "./components/HookChart";
import { api, setCsrf } from "./api";
import { FORMATION_LABELS_UK } from "./formationLabels";
import { paperWarningsText, signalConfirmationLabel, tradeHistoryCsv } from "./tradeHistoryCsv";
import { scanIsOverdue, screenerEmptyState } from "./screenerStatus";
import { TradingScheduleSettings } from "./components/TradingScheduleSettings";
import type { TradingScheduleState } from "../backend/tradingSchedule";
import "./dashboard.css";

type VisibleSignal = Signal & {canEnter?:boolean;entryReasons?:string[];lastAutoDecision?:{at:number;reason:string;state:"skipped"|"opened"|"pending"}|null};
type Snapshot = {
  autoBlockReason?:string|null;
  monitorHealth?:{running:boolean;busy:boolean;startedAt:number|null;finishedAt:number|null;durationMs:number;maxDurationMs:number;cycles:number;skippedTicks:number;lastAutoAttemptAt:number|null};
  settings: Settings;
  entrySchedule: TradingScheduleState;
  positions: any[];
  history: TradeHistoryEntry[];
  pending: any[];
  stats: any;
  scanner: any;
  signals: Signal[];
  formations?: VisibleSignal[];
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
const cost = (n: number) => Number(n || 0).toLocaleString("uk-UA", { minimumFractionDigits: 4, maximumFractionDigits: 8 });
const date = (at?: number | string) =>
  at
    ? new Intl.DateTimeFormat("uk-UA", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "Europe/Warsaw",
      }).format(new Date(at))
    : "Ще не було";

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState(""),
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
            <span className="brand-sub">Trading Platform</span>
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
        <form onSubmit={submit} autoComplete="off">
          <label>
            Логін
            <input
              autoComplete="off"
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
              autoComplete="off"
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
    label: "Максимальний вік сигналу для входу, с",
    hint: "Обмежує нові торгові входи. У скрінері формація видима до наступної свічки свого таймфрейму.",
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
    label: "Ручний taker-тариф за сторону, %",
    hint: "Застосовується лише при виборі ручного тарифу симулятора.",
    min: 0,
    max: 1,
    step: 0.001,
  },
  { key: "paperLatencyMs", label: "Затримка виконання симулятора, мс", hint: "Додаткова модельна затримка перед запитом свіжого стакана. Мережа додає власну затримку.", min: 0, max: 5000 },
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
  const baseline = useRef<Settings>(structuredClone(data.settings));
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
          // Send only intentional edits, not stale values from the entire form.
          const patch=Object.fromEntries(Object.keys(form).filter(key=>
            JSON.stringify(form[key as keyof Settings])!==JSON.stringify(baseline.current[key as keyof Settings])
          ).map(key=>[key,form[key as keyof Settings]]));
          void run(async()=>{
            const saved=await api<Settings>("/api/settings",{settings:patch,liveAcknowledged:ack},"PUT");
            baseline.current=structuredClone(saved);
            setForm(saved);
            setAck(false);
          },"Налаштування збережено");
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
            Для реального режиму власник VPS має
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
            Лише підтверджені формації h00k.top
          </label>
        </div>
        <div className="notice">Джерела монет: тільки формації h00k.top (USDT-ф’ючерси). 30m не підтримується джерелом і не дає сигналів.</div>
        <div className="check-row">
          <label className="check"><input type="checkbox" checked={form.hookRegularFormations} onChange={e=>setForm({...form,hookRegularFormations:e.target.checked})}/> Звичайні формації</label>
          <label className="check"><input type="checkbox" checked={form.hookEarlyFormations} onChange={e=>setForm({...form,hookEarlyFormations:e.target.checked})}/> Ранні формації (спостереження, без входу до підтвердження сайтом)</label>
        </div>
        <TradingScheduleSettings value={form.tradingSchedule}
          onChange={tradingSchedule => setForm({ ...form, tradingSchedule })} />
        <label>
          Комісія симулятора
          <select value={form.paperFeeMode} onChange={e => setForm({ ...form, paperFeeMode: e.target.value as Settings["paperFeeMode"] })}>
            <option value="account">Автоматично — тариф акаунта з API</option>
            <option value="manual">Ручний тариф</option>
          </select>
          <small>Автоматичний тариф потребує збережених ключів читання вибраної біржі. Для рівнів маржі Binance також потрібен ключ читання. Bybit надає рівні маржі публічно.</small>
        </label>
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
        <h2>Формації h00k.top</h2>
        <p className="muted">
          Монети, типи та підтвердження отримуються з h00k.top. Власне сканування біржі не використовується.
          Кількість кандидатів залежить від покриття джерела та обраних фільтрів.
        </p>
        <fieldset>
          <legend>Таймфрейми</legend>
          <div className="check-row">
            {TIMEFRAMES.filter(tf => tf !== "30m" || form.timeframes.includes(tf)).map((tf) => (
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
          <label>Мінімальний обсяг за 24 год (USDT) · джерело h00k
            <input type="number" min={0} max={1e15} step={1} required value={form.hookMinVolumeUsd}
              onChange={e=>setForm({...form,hookMinVolumeUsd:e.target.value===""?"":Number(e.target.value)} as Settings)}/>
            <small>Встанови той самий поріг, що на сторінці формацій h00k.top. 0 — без обмеження.</small>
          </label>
          {scannerFields.filter(f => f.key === "minScore" || f.key === "scanIntervalSeconds").map((f) => (
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
          <legend>Типи формацій · фільтри h00k.top</legend>
          <div className="pattern-options">
            {FORMATIONS.map((name) => (
              <label className="check" key={name}>
                <input
                  type="checkbox"
                  checked={form.formationTypes.includes(name)}
                  onChange={() => toggle("formationTypes", name)}
                />
                {FORMATION_LABELS_UK[name] || name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="notice">
          Симулятор використовує свіжий стакан, taker-комісії, funding та mark price.
          Маржа — isolated для кожної позиції. Прослизання вже включене в ціну виконання.
          Ліквідація моделюється як втрата залишку виділеної маржі; cross, часткова ліквідація та ADL не відтворюються.
          Видимого стакана має вистачати на весь ордер. Funding Bybit оцінюється за mark-свічкою на момент нарахування.
          Це модель виконання; черга, прихована ліквідність і персональні знижки оплати комісій можуть відрізнятися від біржі.
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
    [refreshError, setRefreshError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [chart, setChart] = useState<ChartSelection | null>(null);
  const refreshSequence = useRef(0);
  const actionInFlight=useRef(false);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await api<Snapshot>("/api/state");
      if (sequence !== refreshSequence.current) return;
      setData(next);
      setAuthenticated(true);
      setRefreshError("");
    } catch (e: any) {
      if (sequence !== refreshSequence.current) return;
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
        void refresh().catch((e) => setRefreshError(e.message));
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
    if (actionInFlight.current) return false;
    actionInFlight.current=true;
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
      actionInFlight.current=false;
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
  const formations: VisibleSignal[] = [...(data.formations || data.signals)];
  formations.sort((left, right) =>
    Number(right.canEnter !== false) - Number(left.canEnter !== false) ||
    right.candleAt - left.candleAt || right.confidence - left.confidence || right.detectedAt - left.detectedAt);
  const signals = formations.filter((signal) =>
    `${signal.symbol} ${signal.formation} ${FORMATION_LABELS_UK[signal.formation] || ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const emptyScreener = screenerEmptyState(scan, s, data.schedulerMode,
    !!query.trim(), formations.length);
  const displayedSignals = signals.slice(0, 200);
  const scanOverdue = scan.sourceCoverage ? scan.sourceCoverage.some((x:any)=>x.supported && !x.fresh && !x.refreshing) : scanIsOverdue(scan, s);
  const scanWait=Math.max(0,Math.ceil(((scan.lastStartedAt||0)+s.scanIntervalSeconds*1000-Date.now())/1000));
  const remaining = scan.total ? scan.total - (scan.cursor || 0) : 0;
  const minutes = scan.total
    ? (Math.ceil(scan.total / s.scanBatchSize) *
        Math.max(60, s.scanIntervalSeconds)) /
      60
    : 0;
  const orderDirection=(signal:Signal)=>s.reverseEnabled?(signal.direction==="LONG"?"SHORT":"LONG"):signal.direction;
  const confirmLive = (text: string) =>
    !live ||
    confirm(
      `${text}\nБуде надіслано реальний ордер на ${s.exchange === "binance" ? "Binance" : "Bybit"}.`,
    );
  function exportCsv() {
    const csv = tradeHistoryCsv(data!.history);
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
            <span className="brand-sub">Trading Platform</span>
          </span>
        </a>
        <div className="topbar-right">
          <a
            className="icon-button external-link-button"
            href="https://h00k.top"
            target="_blank"
            rel="noreferrer"
            title="Відкрити h00k.top"
            aria-label="Відкрити h00k.top"
          >
            <ExternalLink size={18} />
          </a>
          <span className="exchange-name">{s.exchange.toUpperCase()}</span>
          <button
            className="icon-button"
            title="Вийти"
            aria-label="Вийти"
            onClick={() =>
              run(async () => {
                await api("/api/auth/logout", {});
                refreshSequence.current++;
                setAuthenticated(false);
                setData(null);
                setChart(null);
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
                <span className="count">{formations.length}</span>
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
              {live && (
                <div className="eyebrow">РЕАЛЬНИЙ РАХУНОК</div>
              )}
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
                  ? data.entrySchedule?.allowed === false
                    ? "Автоматичні входи очікують торгової сесії"
                    : "Автоматичні входи увімкнено"
                  : "Автоматичні входи на паузі"}
              </p>
            </div>
            <button
              disabled={busy || scan.running || scanWait>0}
              onClick={() =>
                run(
                  async () => {
                    const result = await api("/api/scan", {});
                    return result;
                  },
                  "Запит оновлення опрацьовано",
                )
              }
            >
              <RefreshCw size={16} className={scan.running ? "spinning" : ""} />
              {scan.running ? "Оновлюємо…" : scanWait>0 ? `Оновлення через ${scanWait} с` : scan.sourceCoverage ? "Оновити формації" : "Сканувати пакет"}
            </button>
          </div>
          {data.entrySchedule?.enabled && (
            <div className="notice schedule-banner" role="status">
              <Clock3 size={16} />
              <span>{data.entrySchedule.allowed
                ? `Розклад: ${data.entrySchedule.activeWindows.join(", ")}.`
                : "Поза торговим розкладом: нові автоматичні входи призупинено."}
                {" "}Супровід відкритих позицій працює постійно.
              </span>
            </div>
          )}
          {(error || refreshError) && (
            <div role="alert" className="notice error">
              {error || refreshError}
              <button
                className="icon-button"
                aria-label="Закрити помилку"
                onClick={() => { setError(""); setRefreshError(""); }}
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
                    label: data.stats.provisionalTrades > 0 ? "P&L історії (попередній)" : "P&L історії (до 1000 угод)",
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
              {data.stats.provisionalTrades > 0 && <p className="muted">Угоди з неповною звіркою комісій або funding: {data.stats.provisionalTrades}. P&L охоплює лише до 1000 останніх збережених угод.</p>}
              <section className="panel coverage-panel">
                <div>
                  <div className="section-heading">
                    <h2>Охоплення ринку</h2>
                    <span className={`pill ${scan.running ? "positive" : ""}`}>
                      {scan.sourceCoverage ? (scan.sourceCoverage.some((x:any)=>x.refreshing)?"Оновлення джерела":scan.sourceCoverage.some((x:any)=>x.error)?"Є помилки джерела":scan.sourceCoverage.length && scan.sourceCoverage.every((x:any)=>x.fresh)?"Актуальні дані":"Очікування даних") : scan.running ? "Обробка пакета" : "Очікування розкладу"}
                    </span>
                  </div>
                  {scan.sourceCoverage ? <div className="coverage-values">
                    <span><strong>{data.formations?.length ?? 0}</strong> формацій після фільтрів</span>
                    <span><strong>{data.signals.length}</strong> сигналів, допущених джерелом</span>
                    <span><strong>{scan.sourceCounts?.regular ?? 0}</strong> монет зі звичайними формаціями</span>
                  </div> : <><div className="coverage-values">
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
                  </p></>}
                  {scan.sourceCoverage && <div>
                    {scan.sourceCoverage.map((scope:any)=><p className="muted" key={scope.key}>
                      {scope.timeframe} · {scope.source==="regular"?"Звичайні":"Ранні"} ·
                      {scope.error ? " "+scope.error : scope.refreshing ? " оновлення" : scope.fresh ? " актуальні дані" : " немає свіжих даних"} ·
                      відповідь {scope.responseMs==null?"—":`${scope.responseMs} мс`} · отримано монет {scope.receivedCoins??"—"}, формацій {scope.receivedPatterns??"—"} · після перевірок {scope.validPatterns} · після фільтрів {scope.visiblePatterns} · допущено {scope.eligiblePatterns}
                    </p>)}
                    <p className="muted">Покриття залежить від API h00k.top; це не повний прохід усіх контрактів біржі.</p>
                    {data.autoBlockReason && <p className="muted">Автовходи: {data.autoBlockReason}</p>}
                    {data.monitorHealth && <p className="muted">
                      Торговий цикл: {data.monitorHealth.busy?"виконується":data.monitorHealth.running?"очікує":"зупинено"} · остання тривалість {data.monitorHealth.durationMs} мс · максимум {data.monitorHealth.maxDurationMs} мс · пропущено накладених запусків {data.monitorHealth.skippedTicks}
                      {data.monitorHealth.lastAutoAttemptAt? ` · остання спроба входу ${date(data.monitorHealth.lastAutoAttemptAt)}`:""}
                    </p>}
                  </div>}
                </div>
                <div className="coverage-aside">
                  <span className="eyebrow">
                    {data.schedulerMode === "external"
                      ? "ЗОВНІШНІЙ CRON"
                      : "ВНУТРІШНІЙ РОЗКЛАД"}
                  </span>
                  {scan.sourceCoverage ? <strong>Джерело h00k.top · перевірка приблизно кожні 30 с</strong> : <>
                  <strong>{s.scanBatchSize} за пакет</strong>
                  <span className="muted">
                    Орієнтовний повний цикл:{" "}
                    {minutes ? `від ${minutes} хв` : "після завантаження ринку"}
                    . Фактичний час залежить від API та розкладу.
                  </span></>}
                  <span className="muted">
                    Останній запуск: {date(scan.lastStartedAt)}
                  </span>
                  <span className="muted">
                    Останній пакет: {scan.processed || 0} завдань · знайдено {scan.detected ?? "—"} · помилок {scan.failed || 0}
                  </span>
                  {data.schedulerMode === "external" && (
                    <span className="muted">Виклик cron: {date(scan.lastCronAt)}</span>
                  )}
                  {scan.sourceCounts && <span>Джерела h00k: звичайні {scan.sourceCounts.regular}, ранні {scan.sourceCounts.early}</span>}
            {scan.sourceErrors && Object.entries(scan.sourceErrors).map(([scope,error])=><span key={scope} className="negative-text">{scope}: {String(error)}</span>)}
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
                      <span className="muted">{live ? "Звірка кожні 5 секунд" : "Потік цін · перевірка щосекунди"}</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Контракт</th>
                            <th>Напрям</th>
                            <th>Вхід / поточна</th>
                            <th>TP / SL</th>
                            <th>{live ? "P&L" : "P&L mark / нетто"}</th>
                            {!live && <th>Маржа / funding / витрати</th>}
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
                                {p.paper && <small title="Оцінка за mark price мінус комісія входу, funding та очікувана комісія виходу">
                                  Нетто ≈ {money(p.unrealizedPnl - p.entryFee - p.paper.fundingCost - p.paper.markPrice * p.quantity * p.paper.takerRate)}
                                </small>}
                              </td>
                              {!live && <td>
                                {p.paper ? <>
                                  isolated {p.paper.leverage}× · {money(p.paper.marginBalance ?? p.paper.initialMargin)} USDT
                                  <small>Mark {price(p.paper.markPrice)} · Liq {p.paper.liquidationPrice > 0 ? price(p.paper.liquidationPrice) : "—"}</small>
                                  <small>Вхід: {cost(p.entryFee)} · funding: {cost(p.paper.fundingCost)}</small>
                                  <small>Тариф: {p.paper.feeSource === "manual" ? "ручний" : "API акаунта"} · {p.paper.takerRate * 100}%</small>
                                  {p.paper.warnings.length > 0 && <small className="negative-text" title={paperWarningsText(p.paper.warnings)}>Є обмеження точності</small>}
                                  {p.paper.closeFill && <small>Виконано в моделі; очікує звірки витрат</small>}
                                </> : <small>Очікує оновлення моделі</small>}
                              </td>}
                              <td>
                                {p.expiresAt ? date(p.expiresAt) : "Вимкнено"}
                                {live && <small className={p.protectionCheck?.status==="verified"?"positive-text":"negative-text"}>TP/SL: {p.protectionCheck?.status==="verified"?"перевірено":p.protectionCheck?.status==="missing"?"відсутній / завершений":"очікує перевірки"}{p.protectionCheck?.at ? ` · ${date(p.protectionCheck.at)}`:""}</small>}
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
                            <th>Формація</th>
                            <th title="Оцінка та підтвердження первинного сигналу на момент входу">
                              Оцінка / підтвердження
                            </th>
                            <th>Вхід</th>
                            <th>Вихід</th>
                            <th>Чистий P&L</th>
                            <th>Витрати USDT</th>
                            <th>Причина</th>
                            <th>Відкрито</th>
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
                                <small>TF: {t.timeframe || "—"}</small>
                              </td>
                              <td>
                                {t.direction}
                                {t.signalDirection && t.signalDirection !== t.direction ? (
                                  <small>Сигнал: {t.signalDirection}</small>
                                ) : null}
                              </td>
                              <td>{FORMATION_LABELS_UK[t.formation] || t.formation || "—"}</td>
                              <td>
                                {t.signalConfidence == null ? "—" : `${t.signalConfidence} / 100`}
                                <small>{signalConfirmationLabel(t.signalStatus) || "Немає даних"}</small>
                              </td>
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
                              <td>
                                Комісії: {cost(t.fee)}
                                <small>Funding: {t.fundingCost == null ? "Немає даних" : cost(t.fundingCost)}</small>
                                {t.fundingComplete === false && <small className="negative-text">Funding очікує звірки</small>}
                                {t.paper && <small title={paperWarningsText(t.paper.warnings)}>
                                  {t.executionSource === "isolated-bankruptcy-model" ? "Ліквідація isolated (модель)" : "Стакан VWAP"}
                                  {t.paper.warnings.length ? " · є зауваження" : ""}
                                </small>}
                              </td>
                              <td>{t.reason}</td>
                              <td>{t.openedAt == null ? "—" : date(t.openedAt)}</td>
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
                        Формації останніх закритих свічок. Відображення залежить
                        від таймфрейму; для нового входу діє окремий ліміт {s.maxSignalAgeSeconds} с.
                      </p>
                      <p className="muted">
                        {scan.sourceCoverage ? "Оцінка та підтвердження надходять з h00k.top. Це не ймовірність прибутку. Ранні формації не мають оцінки входу." : "Оцінка якості: структура до 60, пробій до 25, обсяг до 15 балів. Це не ймовірність прибутку."}
                      </p>
                      {signals.length > displayedSignals.length && (
                        <p className="muted">Показано перші {displayedSignals.length} із {signals.length}. Уточніть пошук, щоб побачити інші монети.</p>
                      )}
                    </div>
                    <input
                      className="search"
                      aria-label="Пошук монети або формації"
                      placeholder="Монета або формація…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  {scanOverdue && (
                    <div role="status" className="notice">
                      Сканування не оновлюється регулярно. Перевірте {data.schedulerMode === "external" ? "завдання cron-job.org" : "внутрішній розклад"}; останній пакет завершено {date(scan.finishedAt)}.
                    </div>
                  )}
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
                        {displayedSignals.map((signal) => (
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
                            <td>{FORMATION_LABELS_UK[signal.formation] || signal.formation}</td>
                            <td>
                              <span
                                className={`pill ${signal.direction === "LONG" ? "positive" : "live"}`}
                              >
                                {signal.direction}
                              </span>
                              {s.reverseEnabled && <small>Реверс: {orderDirection(signal)}</small>}
                            </td>
                            <td>{price(signal.entryPrice)}</td>
                            <td>
                              <details className="score-details">
                                <summary aria-label={`Оцінка ${signal.symbol} ${signal.timeframe}: ${signal.confidence} зі 100`}>{signal.source === "hook_early" ? "Без оцінки" : `${signal.confidence}/100`}</summary>
                                {signal.scoreParts ? <div>
                                  <span>Структура: {signal.scoreParts.structure}/60</span>
                                  <span>Пробій: {signal.scoreParts.breakout}/25</span>
                                  <span>Обсяг: {signal.scoreParts.volume}/15</span>
                                </div> : <div>{signal.source?.startsWith("hook_")?"Деталі оцінки доступні на сторінці формацій h00k.top.":"Для складових потрібне повторне сканування."}</div>}
                                <p>{signal.description}</p>
                              </details>
                            </td>
                            <td>
                              {signal.status === "confirmed"
                                ? "Підтверджена"
                                : "Формується"}
                              <small>{signal.status === "confirmed" ? "Пробій: " : "Перевірено: "}{date(signal.candleAt)}</small>
                            </td>
                            <td>
                              <button
                                disabled={busy || ("canEnter" in signal && signal.canEnter === false)}
                                title={"canEnter" in signal && signal.canEnter === false
                                  ? signal.entryReasons?.join("; ") || "Формація не пройшла умови допуску до входу"
                                  : undefined}
                                onClick={() => {
                                  if (
                                    confirmLive(
                                      `Відкрити ${signal.symbol} ${orderDirection(signal)} на ${s.orderNotionalUsdt} USDT?${s.reverseEnabled?" (реверс)":""}`,
                                    )
                                  )
                                    void run(
                                      () =>
                                        api(`/api/signals/${encodeURIComponent(signal.id)}/enter`, {
                                          liveAcknowledged: live,
                                          expectedDirection:orderDirection(signal),
                                        }),
                                      "Запит входу опрацьовано",
                                    );
                                }}
                              >
                                {"canEnter" in signal && signal.canEnter === false
                                  ? "Вхід заблоковано"
                                  : live ? "Реальний вхід" : "Тестовий вхід"}
                              </button>
                              {!!signal.entryReasons?.length && <small>{signal.entryReasons.join(" · ")}</small>}
                              {signal.lastAutoDecision && <small>Остання спроба: {signal.lastAutoDecision.reason} · {date(signal.lastAutoDecision.at)}</small>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!signals.length && (
                      <div className="empty">
                        <Activity size={28} />
                        <strong>{emptyScreener.title}</strong>
                        <span>{emptyScreener.detail}</span>
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
