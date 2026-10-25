import React, { useState } from 'react';
import { BotSettings, MarketType } from '../types/trading';
import { Sliders, Save, RotateCcw, ShieldCheck, Zap } from 'lucide-react';

interface StrategySettingsProps {
  settings: BotSettings;
  onSaveSettings: (settings: BotSettings) => void;
  onResetSimulation: () => void;
}

export const StrategySettings: React.FC<StrategySettingsProps> = ({
  settings,
  onSaveSettings,
  onResetSimulation,
}) => {
  const [form, setForm] = useState<BotSettings>({ ...settings });
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(form);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <span>Налаштування стратегії та фільтрів</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Параметри ризик-менеджменту, швидкого скальпінгу до 5 хв, коротких TP/SL та правил входу.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onResetSimulation}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-950/40 hover:bg-rose-900/40 text-rose-300 border border-rose-800/40 transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Скинути баланс до 1 000.00</span>
          </button>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* NEW: Quick Scalp Mode Section */}
        <div className="bg-slate-950/80 border border-cyan-800/40 rounded-xl p-4.5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                Окрема функція: Короткі позиції до 5 хвилин (Quick Scalp)
              </h3>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.quickScalp5mEnabled}
                onChange={(e) => setForm({ ...form, quickScalp5mEnabled: e.target.checked })}
                className="rounded border-slate-700 bg-slate-900 text-cyan-600 focus:ring-0 w-4 h-4"
              />
              <span className="text-xs font-mono font-medium text-cyan-300">
                {form.quickScalp5mEnabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}
              </span>
            </label>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            При активації бот виставляє короткий тейк-профіт та короткий стоп-лос біля точки входу. Якщо протягом 300 секунд (5 хвилин) позиція не закривається за рівнями, спрацьовує примусовий таймаут і позиція закривається за поточною ринковою ціною.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Короткий Тейк-Профіт (TP)
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="3"
                  value={form.quickTpPercent}
                  onChange={(e) => setForm({ ...form, quickTpPercent: parseFloat(e.target.value) || 0.45 })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">%</span>
              </div>
              <span className="text-[11px] text-slate-500 mt-0.5 block">За замовчуванням 0.45%</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Короткий Стоп-Лос (SL)
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.05"
                  min="0.05"
                  max="2"
                  value={form.quickSlPercent}
                  onChange={(e) => setForm({ ...form, quickSlPercent: parseFloat(e.target.value) || 0.25 })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">%</span>
              </div>
              <span className="text-[11px] text-slate-500 mt-0.5 block">За замовчуванням 0.25%</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Тайм-стоп (жорсткий ліміт)
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="60"
                  max="600"
                  step="30"
                  value={form.quickScalpMaxDurationSeconds}
                  onChange={(e) => setForm({ ...form, quickScalpMaxDurationSeconds: parseInt(e.target.value) || 300 })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">сек</span>
              </div>
              <span className="text-[11px] text-slate-500 mt-0.5 block">300с = 5 хвилин</span>
            </div>
          </div>
        </div>

        {/* General Strategy Settings */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* Market Type */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Тип ринку
            </label>
            <select
              value={form.marketType}
              onChange={(e) => setForm({ ...form, marketType: e.target.value as MarketType })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="futures">Futures (USDT-M) — Доступні LONG та SHORT</option>
              <option value="spot">Spot — Тільки LONG (Short блокується)</option>
            </select>
            <span className="text-[11px] text-slate-500 mt-1 block">
              При виборі Spot відкриття шорт-позицій блокується фільтрами.
            </span>
          </div>

          {/* Max Open Positions */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Макс. відкритих позицій
            </label>
            <input
              type="number"
              min="1"
              max="15"
              value={form.maxPositions}
              onChange={(e) => setForm({ ...form, maxPositions: parseInt(e.target.value) || 5 })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
            />
            <span className="text-[11px] text-slate-500 mt-1 block">
              За замовчуванням 5 (0 / 5 слотів).
            </span>
          </div>

          {/* Risk per trade */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Розмір позиції (% від балансу)
            </label>
            <div className="relative">
              <input
                type="number"
                step="0.5"
                min="1"
                max="50"
                value={form.riskPerTradePercent}
                onChange={(e) => setForm({ ...form, riskPerTradePercent: parseFloat(e.target.value) || 5 })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">%</span>
            </div>
            <span className="text-[11px] text-slate-500 mt-1 block">
              Частка депозиту, що виділяється на одну угоду.
            </span>
          </div>

          {/* Leverage */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Кредитне плече (Futures)
            </label>
            <div className="relative">
              <input
                type="number"
                min="1"
                max="50"
                value={form.leverage}
                onChange={(e) => setForm({ ...form, leverage: parseInt(e.target.value) || 1 })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">x</span>
            </div>
            <span className="text-[11px] text-slate-500 mt-1 block">
              Множник позиції для USDT-M ф'ючерсів.
            </span>
          </div>

          {/* Slippage tolerance */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Допустиме відхилення входу (Slippage)
            </label>
            <div className="relative">
              <input
                type="number"
                step="0.05"
                min="0.05"
                max="2"
                value={form.slippageTolerancePercent}
                onChange={(e) => setForm({ ...form, slippageTolerancePercent: parseFloat(e.target.value) || 0.2 })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">%</span>
            </div>
            <span className="text-[11px] text-slate-500 mt-1 block">
              Макс. відхилення ринкової ціни від точки входу формації.
            </span>
          </div>

          {/* Taker Commission */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Комісія біржі (Taker Fee)
            </label>
            <div className="relative">
              <input
                type="number"
                step="0.01"
                min="0"
                max="0.5"
                value={form.takerFeePercent}
                onChange={(e) => setForm({ ...form, takerFeePercent: parseFloat(e.target.value) || 0.04 })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">%</span>
            </div>
            <span className="text-[11px] text-slate-500 mt-1 block">
              Враховується на вході та виході з угоди.
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          {savedSuccess && (
            <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
              <ShieldCheck className="w-4 h-4" /> Налаштування успішно збережено!
            </span>
          )}
          <button
            type="submit"
            className="px-5 py-2 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Зберегти налаштування</span>
          </button>
        </div>
      </form>
    </div>
  );
};
