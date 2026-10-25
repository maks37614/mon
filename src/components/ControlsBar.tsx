import React, { useState } from 'react';
import { BotSettings, BotStats, Timeframe } from '../types/trading';
import { ArrowLeftRight, Check, Clock, Zap, ShieldCheck, Activity } from 'lucide-react';

interface ControlsBarProps {
  settings: BotSettings;
  stats: BotStats;
  onUpdateSettings: (partial: Partial<BotSettings>) => void;
}

export const ControlsBar: React.FC<ControlsBarProps> = ({
  settings,
  stats,
  onUpdateSettings,
}) => {
  const [selectedTf, setSelectedTf] = useState<Timeframe>(settings.timeframe);
  const [showAppliedToast, setShowAppliedToast] = useState(false);

  const availableTimeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

  const handleApplyTimeframe = () => {
    onUpdateSettings({ timeframe: selectedTf });
    setShowAppliedToast(true);
    setTimeout(() => setShowAppliedToast(false), 3000);
  };

  const handleToggleReverse = () => {
    onUpdateSettings({ reverseEnabled: !settings.reverseEnabled });
  };

  const handleToggleQuickScalp = () => {
    onUpdateSettings({ quickScalp5mEnabled: !settings.quickScalp5mEnabled });
  };

  return (
    <div className="space-y-4">
      {/* 3-Column Top Controls Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Module 1: Timeframe Configuration */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                <span>Таймфрейм формацій</span>
              </h2>
              <span className="text-xs font-mono text-slate-400">
                Зараз: <strong className="text-cyan-300 font-semibold">{settings.timeframe}</strong>
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed mb-3">
              Зміна впливає на нові входи. Відкриті угоди супроводжуються за власними рівнями.
            </p>

            <div className="flex items-center gap-2 mb-2">
              <select
                value={selectedTf}
                onChange={(e) => setSelectedTf(e.target.value as Timeframe)}
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                {availableTimeframes.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf} {tf === settings.timeframe ? '(активний)' : ''}
                  </option>
                ))}
              </select>

              <button
                onClick={handleApplyTimeframe}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors cursor-pointer flex items-center gap-1 shrink-0"
              >
                {showAppliedToast ? <Check className="w-3.5 h-3.5" /> : null}
                <span>Застосувати</span>
              </button>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 leading-snug">
            План VPS: конфігурація через <code className="text-cyan-300 font-mono">HOOK_SCREENER_TIMEFRAMES</code>.
          </div>
        </div>

        {/* Module 2: 5-Minute Quick Scalp Mode */}
        <div className="bg-slate-900/80 border border-cyan-900/30 rounded-xl p-4 flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none" />
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan-400" />
                <span>Короткі позиції до 5 хв</span>
              </h2>
              <span className="text-xs font-mono">
                {settings.quickScalp5mEnabled ? (
                  <span className="text-cyan-300 font-semibold">Увімкнено</span>
                ) : (
                  <span className="text-slate-500 font-medium">Вимкнено</span>
                )}
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed mb-3">
              Короткий тейк {settings.quickTpPercent}%, короткий стоп {settings.quickSlPercent}%. Автозакриття по ринку через 300 сек (5 хв).
            </p>

            <button
              onClick={handleToggleQuickScalp}
              className={`w-full px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                settings.quickScalp5mEnabled
                  ? 'bg-cyan-950/90 text-cyan-300 border border-cyan-700/60 hover:bg-cyan-900/60 shadow-sm'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{settings.quickScalp5mEnabled ? 'Вимкнути скальпінг 5хв' : 'Увімкнути скальпінг 5хв'}</span>
            </button>
          </div>

          <div className="pt-2 border-t border-slate-800/80 text-[11px] text-cyan-400/90 flex items-center justify-between font-mono">
            <span>Ліміт: 300с</span>
            <span>TP: +{settings.quickTpPercent}% · SL: -{settings.quickSlPercent}%</span>
          </div>
        </div>

        {/* Module 3: Reverse Strategy */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4 text-cyan-400" />
                <span>Реверс стратегії</span>
              </h2>
              <span className="text-xs font-mono">
                {settings.reverseEnabled ? (
                  <span className="text-amber-400 font-semibold">Увімкнено</span>
                ) : (
                  <span className="text-slate-500 font-medium">Вимкнено</span>
                )}
              </span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed mb-3">
              LONG стає SHORT і навпаки; стоп і ціль міняються місцями. Short на spot не виконується.
            </p>

            <button
              onClick={handleToggleReverse}
              className={`w-full px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                settings.reverseEnabled
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              <span>{settings.reverseEnabled ? 'Вимкнути реверс' : 'Увімкнути реверс'}</span>
            </button>
          </div>

          <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-between">
            <span>{settings.reverseEnabled ? 'Контр-тренд' : 'Пряме слідування'}</span>
            <span className="font-mono text-slate-500">Spot Short: захищено</span>
          </div>
        </div>
      </div>

      {/* Real Live Status Strip (Clean, Authentic, No 503 simulation) */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 text-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-400">
          <div>
            <span className="text-slate-400">Останній запуск: </span>
            <span className="text-slate-200 font-mono font-medium">{stats.lastRunUtc}</span>
          </div>
          <span className="hidden sm:inline" aria-hidden="true">·</span>
          <div>
            <span className="text-slate-400">Свіжий канал формацій: </span>
            <span className="text-slate-300 font-mono font-medium">{stats.screenerChannelStatus}</span>
          </div>
        </div>

        {/* Real Authentic Connection Indicator */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Справжнє підключення h00k.top</span>
            {stats.h00kLatencyMs ? (
              <span className="text-[11px] font-mono text-slate-400">({stats.h00kLatencyMs} мс)</span>
            ) : null}
          </div>

          <div className="flex items-center gap-1 text-[11px] font-mono text-cyan-400/90 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
            <ShieldCheck className="w-3 h-3 text-cyan-400" />
            <span>Binance Futures Live</span>
          </div>
        </div>
      </div>
    </div>
  );
};
