import React, { useState, useEffect } from 'react';
import { FormationSignal, Timeframe } from '../types/trading';
import { Search, Play, ArrowUpRight, ArrowDownRight, RefreshCw, ExternalLink, Zap, ShieldCheck, BarChart2 } from 'lucide-react';
import { HookChart } from './HookChart';

interface FormationsScreenerProps {
  activeTimeframe: Timeframe;
  reverseEnabled: boolean;
  quickScalp5mEnabled: boolean;
  onEnterTrade: (signal: FormationSignal) => void;
}

export const FormationsScreener: React.FC<FormationsScreenerProps> = ({
  activeTimeframe,
  reverseEnabled,
  quickScalp5mEnabled,
  onEnterTrade,
}) => {
  const [signals, setSignals] = useState<FormationSignal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [selectedTf, setSelectedTf] = useState<Timeframe>(activeTimeframe);
  const [sourceNotice, setSourceNotice] = useState<string>('');
  const [selectedChartSignal, setSelectedChartSignal] = useState<FormationSignal | null>(null);

  const fetchSignals = async (tf: Timeframe) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/h00k/formations?timeframe=${tf}&quickScalp=${quickScalp5mEnabled ? 'true' : 'false'}`);
      if (res.ok) {
        const json = await res.json();
        setSignals(json.data || []);
        setSourceNotice(json.source || 'Офіційний алгоритм h00k.top (Live Binance Futures)');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setSelectedTf(activeTimeframe);
    fetchSignals(activeTimeframe);
  }, [activeTimeframe, quickScalp5mEnabled]);

  const filteredSignals = signals.filter((s) => {
    const matchesSearch = s.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.formation.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDir = directionFilter === 'ALL' || s.direction === directionFilter;
    return matchesSearch && matchesDir;
  });

  return (
    <div className="space-y-4">
      {/* Header & Filter Controls */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 sm:p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                Скрінер Формацій h00k.top (Справжні дані)
              </h2>
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Engine
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Точки входу, короткого тейку та стопу за офіційним алгоритмом патернів h00k.top та 100-свічковими котируваннями Binance Futures.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-nowrap whitespace-nowrap self-start md:self-auto">
            <button
              onClick={() => fetchSignals(selectedTf)}
              disabled={isLoading}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Оновити скрінер</span>
            </button>

            <a
              href="https://h00k.top"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <span>Відкрити h00k.top</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Quick Scalp & Reverse Notification Banners - strictly single-line */}
        <div className="mt-3 pt-3 border-t border-slate-800 flex items-center gap-2 text-xs flex-nowrap overflow-x-auto whitespace-nowrap scrollbar-none pb-1">
          {quickScalp5mEnabled && (
            <div className="bg-cyan-950/60 text-cyan-300 border border-cyan-800/50 px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono whitespace-nowrap shrink-0">
              <Zap className="w-3 h-3 fill-cyan-400" />
              <span>Швидкий скальпінг (&le;5 хв) увімкнено: короткий TP (+0.45%) та SL (-0.25%)</span>
            </div>
          )}

          {reverseEnabled && (
            <div className="bg-amber-950/50 text-amber-300 border border-amber-800/50 px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono whitespace-nowrap shrink-0">
              <span>Реверс: LONG &harr; SHORT</span>
            </div>
          )}
        </div>

        {/* Search, Timeframe and Direction Filter Tabs - strictly single-line */}
        <div className="mt-3 flex items-center gap-2.5 flex-nowrap overflow-x-auto whitespace-nowrap scrollbar-none pb-1">
          <div className="relative min-w-[200px] max-w-sm flex-1 shrink-0">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Пошук монети або патерну (BTC, Трикутник, W-патерн)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          {/* Timeframe selector */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 shrink-0 flex-nowrap whitespace-nowrap">
            {(['1m', '5m', '15m', '30m', '1h', '4h'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  setSelectedTf(tf);
                  fetchSignals(tf);
                }}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedTf === tf
                    ? 'bg-cyan-600 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Direction toggle */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 shrink-0 flex-nowrap whitespace-nowrap">
            <button
              onClick={() => setDirectionFilter('ALL')}
              className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                directionFilter === 'ALL'
                  ? 'bg-slate-800 text-slate-100 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Всі
            </button>
            <button
              onClick={() => setDirectionFilter('LONG')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                directionFilter === 'LONG'
                  ? 'bg-emerald-950/80 text-emerald-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Long
            </button>
            <button
              onClick={() => setDirectionFilter('SHORT')}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                directionFilter === 'SHORT'
                  ? 'bg-rose-950/80 text-rose-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Short
            </button>
          </div>
        </div>
      </div>

      {/* Grid of Formation Cards */}
      {isLoading ? (
        <div className="py-16 text-center text-slate-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-cyan-400" />
          <span className="text-xs font-mono">Аналіз свічок Binance через алгоритм h00k.top...</span>
        </div>
      ) : filteredSignals.length === 0 ? (
        <div className="py-16 text-center text-slate-400 bg-slate-900/60 border border-slate-800 rounded-xl">
          <p className="text-sm">Формацій за вибраними фільтрами не знайдено.</p>
          <span className="text-xs text-slate-500 font-mono mt-1 block">
            Спробуйте перемкнути таймфрейм або змінити пошуковий запит
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filteredSignals.map((sig) => {
            const effectiveDir = reverseEnabled
              ? sig.direction === 'LONG'
                ? 'SHORT'
                : 'LONG'
              : sig.direction;
            const effectiveSl = reverseEnabled ? sig.takeProfit : sig.stopLoss;
            const effectiveTp = reverseEnabled ? sig.stopLoss : sig.takeProfit;
            const deviation = Math.abs(sig.currentPrice - sig.entryPrice) / sig.entryPrice * 100;

            return (
              <div
                key={sig.id}
                className="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-xl p-4 transition-all flex flex-col justify-between"
              >
                <div>
                  {/* Top line: Symbol, Direction, TF */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100 font-mono text-sm">
                        {sig.symbol}
                      </span>
                      <span className="text-[11px] font-mono text-cyan-400">
                        {sig.timeframe}
                      </span>
                      {quickScalp5mEnabled && (
                        <span className="text-[10px] text-cyan-300 font-sans flex items-center bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/40">
                          <Zap className="w-2.5 h-2.5 mr-0.5" /> &le;5хв
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {effectiveDir === 'LONG' ? (
                        <span className="text-xs font-bold font-mono text-emerald-400 flex items-center">
                          <ArrowUpRight className="w-3.5 h-3.5" /> LONG
                        </span>
                      ) : (
                        <span className="text-xs font-bold font-mono text-rose-400 flex items-center">
                          <ArrowDownRight className="w-3.5 h-3.5" /> SHORT
                        </span>
                      )}
                      {reverseEnabled && (
                        <span className="text-[10px] text-amber-400 font-mono">(рев)</span>
                      )}
                    </div>
                  </div>

                  {/* Formation Name & Description */}
                  <div className="mt-2">
                    <div className="text-xs font-medium text-slate-200">
                      {sig.formation}
                    </div>
                    <div className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">
                      {sig.description}
                    </div>
                  </div>

                  {/* Price Levels Grid */}
                  <div className="mt-3.5 bg-slate-950/70 border border-slate-800/80 rounded-lg p-3 text-xs font-mono space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 font-sans">Вхід (Entry):</span>
                      <span className="text-slate-100 font-semibold">{sig.entryPrice}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-rose-400 font-sans">Короткий Стоп (SL):</span>
                      <span className="text-rose-400 font-semibold">{effectiveSl}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-emerald-400 font-sans">Короткий Тейк (TP):</span>
                      <span className="text-emerald-400 font-semibold">{effectiveTp}</span>
                    </div>

                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-800/80 text-[11px]">
                      <span className="text-slate-400 font-sans">Поточна ціна Binance:</span>
                      <span className="text-cyan-300">{sig.currentPrice}</span>
                    </div>
                  </div>
                </div>

                {/* Footer metadata & Manual Trigger */}
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                  <div className="text-[11px] text-slate-400">
                    <span>R:R {sig.riskRewardRatio}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{sig.confidence}%</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setSelectedChartSignal(sig)}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1 cursor-pointer"
                      title="Відкрити інтерактивний графік HookChart"
                    >
                      <BarChart2 className="w-3 h-3 text-cyan-400" />
                      <span>Графік</span>
                    </button>

                    <button
                      onClick={() => onEnterTrade(sig)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <Play className="w-3 h-3 fill-white" />
                      <span>Вхід</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal for HookChart preview on screener card */}
      {selectedChartSignal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col">
            <div className="p-3.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-cyan-400" />
                <span className="font-bold text-slate-100 font-mono text-sm">
                  HookChart — {selectedChartSignal.symbol}
                </span>
                <span className="text-xs text-slate-400 font-sans">
                  ({selectedChartSignal.formation})
                </span>
              </div>
              <button
                onClick={() => setSelectedChartSignal(null)}
                className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              >
                Закрити
              </button>
            </div>
            <div className="p-2">
              <HookChart
                symbol={selectedChartSignal.symbol}
                entryPrice={selectedChartSignal.entryPrice}
                stopLoss={reverseEnabled ? selectedChartSignal.takeProfit : selectedChartSignal.stopLoss}
                takeProfit={reverseEnabled ? selectedChartSignal.stopLoss : selectedChartSignal.takeProfit}
                currentPrice={selectedChartSignal.currentPrice}
                direction={reverseEnabled ? (selectedChartSignal.direction === 'LONG' ? 'SHORT' : 'LONG') : selectedChartSignal.direction}
                formationName={selectedChartSignal.formation}
                isQuickScalp5m={quickScalp5mEnabled}
                height={400}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
