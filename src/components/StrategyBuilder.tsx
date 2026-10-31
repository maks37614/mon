import React, { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, Play, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api } from "../api";
import type { EdwinSettings, EdwinSignal } from "../../backend/edwinStrategy";

type StrategyDescription = {
  id: string;
  name: string;
  description: string;
  implemented: readonly string[];
  unsupported: readonly string[];
};
type BuilderState = {
  strategies: StrategyDescription[];
  settings: EdwinSettings;
  status: {
    running?: boolean; exchange?: string; lastStartedAt?: number; lastFinishedAt?: number;
    lastFullPassAt?: number; cursor?: number; total?: number;
    scanned?: number; failed?: number; detected?: number; error?: string | null;
  };
  signals: EdwinSignal[];
  tradingConnected: boolean;
  autoEntriesEnabled?: boolean;
  tradingMode?: "paper" | "live";
};
const number = (value: number) => Number(value).toLocaleString("en-US", { maximumSignificantDigits: 8 });
const when = (at?: number) => at
  ? new Intl.DateTimeFormat("uk-UA", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Warsaw" }).format(new Date(at))
  : "Ще не було";

const fields: {
  key: Exclude<keyof EdwinSettings, "enabled">;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  { key: "scanIntervalSeconds", label: "Період сканування, сек.", min: 60, max: 3600, step: 30, hint: "Автоматичне фонове сканування на сервері." },
  { key: "symbolsPerBatch", label: "Монет із чинних формацій за цикл", min: 5, max: 80, step: 1, hint: "Сканує тільки монети, уже відібрані скрінером формацій." },
  { key: "proximityPercent", label: "Відстань до рівня, %", min: 1, max: 8, step: 0.5, hint: "Зона інтересу для передпробійної наторговки." },
  { key: "breakoutBufferPercent", label: "Підтвердження пробою, %", min: 0.02, max: 0.5, step: 0.02, hint: "Наскільки закрита свічка має перейти за рівень." },
  { key: "minimumTouches", label: "Мінімум торкань", min: 3, max: 6, step: 1, hint: "Вимога для каскадів і трендових." },
  { key: "stopLossPercent", label: "Орієнтир стопа, %", min: 0.2, max: 2, step: 0.1, hint: "Стоп для Ev-Test позиції; реальне виконання дозволяється окремими системними параметрами." },
  { key: "takeProfitPercent", label: "Орієнтир цілі, %", min: 0.5, max: 10, step: 0.5, hint: "Ціль для Ev-Test позиції." },
  { key: "maxSpreadPercent", label: "Максимальний спред, %", min: 0.02, max: 2, step: 0.01, hint: "Відхилення між bid та ask; більший спред блокує сигнал." },
  { key: "maxHoldMinutes", label: "Максимум утримання, хв.", min: 5, max: 240, step: 5, hint: "Тайм-стоп для нових позицій Ev-Test." },
  { key: "maxDailyLossPercent", label: "Ліміт денного збитку, %", min: 0.5, max: 20, step: 0.5, hint: "Зупинка нових Ev-Test входів за денним чистим результатом." },
  { key: "minVolumeRatio", label: "Мінімальна відносна сила обсягу", min: 0.1, max: 3, step: 0.1, hint: "Обсяг свічки відносно середнього за 20 попередніх." },
];

export function StrategyBuilder({ onOpenChart }: { onOpenChart: (signal: EdwinSignal) => void }) {
  const [data, setData] = useState<BuilderState | null>(null);
  const [draft, setDraft] = useState<EdwinSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const next = await api<BuilderState>("/api/strategy-builder");
    setData(next);
    setDraft((old) => old || next.settings);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function action(fn: () => Promise<any>, success: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await fn();
      await refresh();
      setMessage(success);
    } catch (e: any) {
      setError(e.message || "Помилка");
    } finally { setBusy(false); }
  }
  const status: BuilderState["status"] = data?.status || {};
  const strategy = data?.strategies?.[0];

  return (
    <div className="strategy-builder">
      <section className="panel">
        <div className="section-heading">
          <div>
            <div className="eyebrow">КОНСТРУКТОР СТРАТЕГІЙ · №1</div>
            <h2>{strategy?.name || "Ev-Test"}</h2>
            <p className="muted">Коли увімкнено — замінює правила входу поточного бота, зберігаючи відбір монет його скрінера.</p>
          </div>
          <span className={"pill " + (data?.settings.enabled ? "positive" : "")}>
            {data?.settings.enabled ? "Пошук увімкнено" : "Вимкнено"}
          </span>
        </div>
        {(error || message) && <div role={error ? "alert" : "status"} className={"notice " + (error ? "error" : "success")}>{error || message}</div>}
        <p className="muted">{strategy?.description}</p>
        <div className="strategy-builder-actions">
          <button
            className={data?.settings.enabled ? "" : "primary"}
            disabled={busy || !data}
            onClick={() => void action(
              async () => {
                const enabling = !data!.settings.enabled;
                const liveAuto = enabling && data!.tradingMode === "live" && data!.autoEntriesEnabled;
                if (liveAuto && !window.confirm("Ev-Test замінить правила входу і може відкривати РЕАЛЬНІ угоди з поточними лімітами бота. Увімкнути?"))
                  throw new Error("Увімкнення скасовано");
                return api("/api/strategy-builder", { enabled: enabling, liveAcknowledged: liveAuto }, "PUT");
              },
              data?.settings.enabled ? "Ev-Test вимкнена" : "Ev-Test увімкнена",
            )}
          >
            <Activity size={16}/>{data?.settings.enabled ? "Вимкнути Ev-Test" : "Увімкнути Ev-Test"}
          </button>
          <button
            disabled={busy || !data?.settings.enabled || !!status.running}
            onClick={() => void action(async () => {
              const result = await api<{ accepted: boolean; reason?: string }>("/api/strategy-builder/scan", {});
              if (!result.accepted) throw new Error(result.reason === "running" ? "Сканування вже триває" : "Пошук недоступний");
            }, "Пошук запущено")}
          >
            {status.running ? <RefreshCw size={16} className="spinning"/> : <Play size={16}/>}
            {status.running ? "Шукаємо…" : "Сканувати зараз"}
          </button>
        </div>
        <div className="notice">
          <ShieldCheck size={16}/>
          <span><strong>{data?.tradingMode === "live" ? "Реальний рахунок" : "Віртуальний рахунок"} · {data?.autoEntriesEnabled ? "Авто-входи активні" : "Авто-входи основного бота вимкнені"}.</strong> Ev-Test підміняє точки входу тільки для монет із чинного скрінера формацій; при вимкненні повертаються старі правила. Захисні перевірки, ліміти позицій та супровід відкритих угод залишаються у торговому модулі.</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><h2><SlidersHorizontal size={16}/> Параметри стратегії</h2></div>
        {draft ? (
          <>
            <div className="strategy-builder-fields">
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    type="number" min={field.min} max={field.max} step={field.step}
                    value={draft[field.key]}
                    disabled={busy}
                    onChange={(e) => setDraft((prev) => prev && ({ ...prev, [field.key]: Number(e.target.value) }))}
                  />
                  <small>{field.hint}</small>
                </label>
              ))}
            </div>
            <button disabled={busy} onClick={() => void action(async () => {
              const { enabled: _enabled, ...parameters } = draft;
              await api("/api/strategy-builder", parameters, "PUT");
            }, "Параметри збережено")}>Зберегти параметри</button>
          </>
        ) : <p className="muted">Завантаження параметрів…</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Автоматичний пошук · {data?.signals.length || 0} свіжих сигналів</h2>
            <p className="muted">Підтвердження тільки за закритими свічками. Пошук по USDT perpetual на {status.exchange?.toUpperCase() || "вибраній біржі"}.</p>
          </div>
          <span className={"pill " + (status.running ? "positive" : "")}>{status.running ? "Триває" : "Очікує"}</span>
        </div>
        <div className="strategy-builder-status">
          <span>Опрацьовано за цикл: <strong>{status.scanned || 0}</strong></span>
          <span>Знайдено: <strong>{status.detected || 0}</strong></span>
          <span>Охоплення: <strong>{status.total ? (status.cursor || 0) + " / " + status.total : "—"}</strong></span>
          <span>Останнє сканування: <strong>{when(status.lastFinishedAt)}</strong></span>
          <span>Повний обхід: <strong>{when(status.lastFullPassAt)}</strong></span>
          <span>Помилки: <strong>{status.failed || 0}</strong></span>
        </div>
        {status.error && <div className="notice error">{status.error}</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Монета / TF</th><th>Зона</th><th>Сетап</th><th>Напрям</th><th>Вхід / стоп / ціль</th><th>Свічка</th><th/></tr></thead>
            <tbody>
              {(data?.signals || []).map((signal) => (
                <tr key={signal.id}>
                  <td><strong>{signal.symbol}</strong><small>{signal.timeframe}</small></td>
                  <td>Зона {signal.zone}</td>
                  <td>{signal.pattern}<small title={signal.description}>{signal.description}</small></td>
                  <td><span className={"pill " + (signal.direction === "LONG" ? "positive" : "live")}>{signal.direction}</span></td>
                  <td>{number(signal.entryPrice)}<small>SL {number(signal.stopLoss)} · TP {number(signal.takeProfit)}</small></td>
                  <td>{when(signal.candleAt)}</td>
                  <td><button title="Переглянути сигнал на графіку, без створення ордера" onClick={() => onOpenChart(signal)}><BarChart3 size={15}/> Графік</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.signals.length && <div className="empty">
            <Activity size={26}/>
            <strong>{data?.settings.enabled ? "Поки немає підтверджених сигналів" : "Увімкніть стратегію для пошуку"}</strong>
            <span>Сигнали з’являються лише після розпізнавання формації на закритій свічці. Повний обхід ринку потребує кількох пакетів.</span>
          </div>}
        </div>
      </section>
      <section className="panel">
        <div className="section-heading"><h2>Що входить у першу версію</h2></div>
        <div className="strategy-builder-columns">
          <div><h3>Алгоритм шукає</h3><ul>{strategy?.implemented.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><h3>Потребує окремої реалізації або ручної оцінки</h3><ul>{strategy?.unsupported.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </section>
    </div>
  );
}
