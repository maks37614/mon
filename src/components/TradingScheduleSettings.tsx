import React, { useEffect, useState } from "react";
import { Clock3, Plus, X } from "lucide-react";
import {
  TRADING_DAYS, TRADING_SESSION_PRESETS, TRADING_TIME_ZONES, tradingScheduleState,
  type TradingSchedule, type TradingWindow,
} from "../../backend/tradingSchedule";

export function TradingScheduleSettings({ value, onChange }: {
  value: TradingSchedule;
  onChange: (schedule: TradingSchedule) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const state = tradingScheduleState(value, now);
  const updateWindow = (id: string, changes: Partial<TradingWindow>) =>
    onChange({ ...value, windows: value.windows.map(w => w.id === id ? { ...w, ...changes } : w) });
  const addWindow = (window: TradingWindow) =>
    onChange({ enabled: true, windows: [...value.windows, structuredClone(window)] });
  const clock = (timeZone: string) => new Intl.DateTimeFormat("uk-UA", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now);

  return (
    <section className="schedule-editor" aria-label="Розклад автоматичної торгівлі">
      <div className="schedule-heading">
        <div>
          <h2><Clock3 size={16} /> Години автоматичної торгівлі</h2>
          <p className="muted">
            Крипторинок працює 24/7. Шаблони нижче — редаговані регіональні сесії,
            а не офіційні години відкриття Binance чи Bybit.
          </p>
        </div>
        <label className="check">
          <input type="checkbox" checked={value.enabled}
            onChange={e => onChange({ ...value, enabled: e.target.checked })} />
          Торгувати за розкладом
        </label>
      </div>
      <div className={`schedule-preview ${state.allowed ? "is-open" : "is-closed"}`} role="status">
        {!state.enabled ? "Розклад вимкнено: час нових входів не обмежено."
          : state.allowed ? `Зараз активні: ${state.activeWindows.join(", ")}.`
          : "Зараз поза розкладом: нові автоматичні входи очікуватимуть наступного вікна."}
      </div>
      <div className="schedule-presets">
        {TRADING_SESSION_PRESETS.map(preset => {
          const selected = value.windows.some(w => w.id === preset.id);
          return <button type="button" key={preset.id}
            disabled={selected || value.windows.length >= 20}
            onClick={() => addWindow(preset)}>
            <Plus size={13} /> {preset.name} · {preset.start}–{preset.end}
            {selected ? " · додано" : ""}
          </button>;
        })}
        <button type="button" disabled={value.windows.length >= 20}
          onClick={() => addWindow({
            id: crypto.randomUUID(), name: "Мій розклад", timeZone: "Europe/Warsaw",
            days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00",
          })}>
          <Plus size={13} /> Власні години
        </button>
      </div>
      {value.windows.map(window => (
        <div className="schedule-window" key={window.id}>
          <div className="schedule-window-heading">
            <strong>{window.name || "Часове вікно"}</strong>
            <button type="button" className="icon-button"
              aria-label={`Видалити вікно ${window.name}`}
              onClick={() => onChange({ ...value, windows: value.windows.filter(w => w.id !== window.id) })}>
              <X size={16} />
            </button>
          </div>
          <div className="schedule-grid">
            <label>Назва вікна
              <input value={window.name} maxLength={80} required
                onChange={e => updateWindow(window.id, { name: e.target.value })} />
            </label>
            <label>Часовий пояс
              <select value={window.timeZone}
                onChange={e => updateWindow(window.id, { timeZone: e.target.value })}>
                {[...new Set([...TRADING_TIME_ZONES, window.timeZone])].map(zone =>
                  <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            <label>Початок
              <input type="time" step={60} value={window.start} required
                onChange={e => updateWindow(window.id, { start: e.target.value })} />
            </label>
            <label>Завершення
              <input type="time" step={60} value={window.end} required
                onChange={e => updateWindow(window.id, { end: e.target.value })} />
            </label>
          </div>
          <fieldset className="schedule-days">
            <legend>Дні початку вікна</legend>
            {TRADING_DAYS.map(({ day, label }) => (
              <label className="check" key={day}>
                <input type="checkbox" checked={window.days.includes(day)}
                  onChange={e => updateWindow(window.id, {
                    days: e.target.checked ? [...window.days, day] : window.days.filter(d => d !== day),
                  })} />
                {label}
              </label>
            ))}
          </fieldset>
          <small>Зараз у цьому поясі: {clock(window.timeZone)}. Літній і зимовий час враховуються автоматично.</small>
        </div>
      ))}
      <p className="muted">
        Достатньо одного відкритого вікна. Нічне вікно, наприклад Пт 22:00–02:00,
        закінчиться в суботу; однаковий час початку й завершення означає весь обраний день.
        У шаблонах обрано Пн–Пт; вихідні можна додати.
      </p>
      <p className="muted">
        Розклад діє лише на нові автоматичні входи. Відкриті позиції, TP/SL,
        тайм-стоп і ручні дії працюють завжди. Зміни набудуть чинності після «Зберегти зміни».
      </p>
    </section>
  );
}
