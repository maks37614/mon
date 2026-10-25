import React, { useState, useEffect } from 'react';
import { Position } from '../types/trading';
import { HookChart } from './HookChart';
import {
  ArrowDownRight,
  ArrowUpRight,
  XSquare,
  Clock,
  Zap,
  BarChart2,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  List
} from 'lucide-react';

interface OpenPositionsTableProps {
  positions: Position[];
  timeframe: string;
  marketType: string;
  onClosePosition: (id: string) => void;
}

export const OpenPositionsTable: React.FC<OpenPositionsTableProps> = ({
  positions,
  timeframe,
  marketType,
  onClosePosition,
}) => {
  // Live ticker for time remaining on 5-minute quick scalp positions
  const [, setTick] = useState(0);
  const [expandedCharts, setExpandedCharts] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'table' | 'charts'>('table');

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // By default, if there are positions and user switches to chart view, open them
  const toggleChart = (id: string) => {
    setExpandedCharts((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const getRemainingTimeFormatted = (pos: Position) => {
    if (!pos.isQuickScalp5m || !pos.expiresAtTimestamp) return null;
    const remainingSec = Math.max(0, Math.round((pos.expiresAtTimestamp - Date.now()) / 1000));
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const progressPercent = Math.max(0, Math.min(100, (remainingSec / 300) * 100));

    return {
      text: `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
      remainingSec,
      progressPercent,
      isUrgent: remainingSec < 60,
    };
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden space-y-0">
      {/* Table Header with View Switcher */}
      <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-cyan-400" />
              <span>Відкриті позиції</span>
            </h3>
            <span className="text-xs text-slate-400 font-mono">({positions.length} активних)</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Рівні входу, короткого стопа й цілі з живими графіками HookChart (h00k.top).
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 flex-nowrap whitespace-nowrap self-start sm:self-auto">
          {/* Switch Table vs HookCharts View */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs shrink-0 flex-nowrap whitespace-nowrap">
            <button
              onClick={() => setViewMode('table')}
              className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0 ${
                viewMode === 'table'
                  ? 'bg-slate-800 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Табличний вигляд з можливістю розгортання графіків"
            >
              <List className="w-3.5 h-3.5" />
              <span>Таблиця</span>
            </button>
            <button
              onClick={() => setViewMode('charts')}
              className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0 ${
                viewMode === 'charts'
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/40 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Візуальний вигляд з усіма графіками HookChart"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Графіки HookChart</span>
            </button>
          </div>

          {/* Filter Indicator */}
          <div className="text-xs font-mono text-cyan-400 flex items-center gap-1.5 bg-slate-950/80 px-2.5 py-1 rounded border border-slate-800 shrink-0 whitespace-nowrap">
            <span>{timeframe}</span>
            <span aria-hidden="true">·</span>
            <span>all</span>
            <span aria-hidden="true">·</span>
            <span>{marketType}</span>
          </div>
        </div>
      </div>

      {/* Table Body or HookCharts Grid */}
      {positions.length === 0 ? (
        <div className="py-12 px-4 text-center">
          <p className="text-sm text-slate-400">
            Позицій ще немає. Бот відкриває лише підтверджені сигнали біля ціни входу.
          </p>
          <span className="text-xs text-slate-500 block mt-1 font-mono">
            Очікування наступного циклу cron або виявлення нових точок входу скрінером h00k.top
          </span>
        </div>
      ) : viewMode === 'charts' ? (
        /* Grid of HookCharts for All Open Positions */
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {positions.map((pos) => {
            const isLong = pos.direction === 'LONG';
            const isPnlPositive = pos.unrealizedPnl >= 0;

            return (
              <div
                key={pos.id}
                className="bg-slate-950/80 border border-slate-800 rounded-xl overflow-hidden flex flex-col justify-between"
              >
                <HookChart
                  symbol={pos.symbol}
                  entryPrice={pos.entryPrice}
                  stopLoss={pos.stopLoss}
                  takeProfit={pos.takeProfit}
                  currentPrice={pos.currentPrice}
                  direction={pos.direction}
                  formationName={pos.formation}
                  isQuickScalp5m={pos.isQuickScalp5m}
                  expiresAtTimestamp={pos.expiresAtTimestamp}
                  height={260}
                />

                {/* Bottom position actions */}
                <div className="p-3 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-3">
                    <span className="text-slate-400">
                      Вхід: <strong className="text-slate-200">{pos.entryPrice}</strong> ({pos.quantity})
                    </span>
                    <span className={isPnlPositive ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      P&L: {isPnlPositive ? '+' : ''}{pos.unrealizedPnl.toFixed(2)} USDT ({isPnlPositive ? '+' : ''}{pos.unrealizedPnlPercent.toFixed(2)}%)
                    </span>
                  </div>

                  <button
                    onClick={() => onClosePosition(pos.id)}
                    className="px-3 py-1 text-xs font-sans font-medium rounded bg-rose-950/60 text-rose-300 hover:bg-rose-900/60 border border-rose-800/40 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <XSquare className="w-3.5 h-3.5" />
                    <span>Закрити по ринку</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Standard Table with Expandable HookCharts */
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 font-medium">
                <th className="py-3 px-4">Інструмент / формація</th>
                <th className="py-3 px-4">Напрямок</th>
                <th className="py-3 px-4">Вхід / кількість</th>
                <th className="py-3 px-4">Стоп / ціль</th>
                <th className="py-3 px-4">Ціна / P&L</th>
                <th className="py-3 px-4">Таймер 5 хв / Графік</th>
                <th className="py-3 px-4 text-right">Дія</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {positions.map((pos) => {
                const isLong = pos.direction === 'LONG';
                const isPnlPositive = pos.unrealizedPnl >= 0;
                const timerData = getRemainingTimeFormatted(pos);
                const isChartOpen = !!expandedCharts[pos.id];

                return (
                  <React.Fragment key={pos.id}>
                    <tr className="hover:bg-slate-800/30 transition-colors">
                      {/* Symbol / Formation */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-slate-100">{pos.symbol}</span>
                          {pos.isQuickScalp5m && (
                            <span className="text-[10px] font-sans font-semibold text-cyan-300 flex items-center">
                              <Zap className="w-2.5 h-2.5 mr-0.5 fill-cyan-400" /> &le;5м
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 font-sans truncate max-w-[170px]">
                          {pos.formation}
                        </div>
                      </td>

                      {/* Direction */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          {isLong ? (
                            <span className="text-emerald-400 font-bold flex items-center">
                              <ArrowUpRight className="w-3.5 h-3.5" /> LONG
                            </span>
                          ) : (
                            <span className="text-rose-400 font-bold flex items-center">
                              <ArrowDownRight className="w-3.5 h-3.5" /> SHORT
                            </span>
                          )}
                          {pos.isReversed && (
                            <span className="text-[10px] text-amber-400 font-sans">
                              (рев)
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Entry / Quantity */}
                      <td className="py-3 px-4">
                        <div className="text-slate-200">{pos.entryPrice}</div>
                        <div className="text-[11px] text-slate-400">
                          {pos.quantity} (${pos.amountUsdt})
                        </div>
                      </td>

                      {/* Stop / Target */}
                      <td className="py-3 px-4">
                        <div className="text-rose-400">SL: {pos.stopLoss}</div>
                        <div className="text-emerald-400">TP: {pos.takeProfit}</div>
                      </td>

                      {/* Current Price / P&L */}
                      <td className="py-3 px-4">
                        <div className="text-slate-100">{pos.currentPrice}</div>
                        <div
                          className={`font-semibold ${
                            isPnlPositive ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isPnlPositive ? '+' : ''}
                          {pos.unrealizedPnl.toFixed(2)} USDT ({isPnlPositive ? '+' : ''}
                          {pos.unrealizedPnlPercent.toFixed(2)}%)
                        </div>
                      </td>

                      {/* 5-Min Timer & HookChart Trigger */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          {timerData ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5">
                                <Clock className={`w-3 h-3 ${timerData.isUrgent ? 'text-rose-400 animate-pulse' : 'text-cyan-400'}`} />
                                <span className={`text-xs font-bold ${timerData.isUrgent ? 'text-rose-400' : 'text-cyan-300'}`}>
                                  {timerData.text}
                                </span>
                              </div>
                              <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-1000 ${
                                    timerData.isUrgent ? 'bg-rose-500' : 'bg-cyan-500'
                                  }`}
                                  style={{ width: `${timerData.progressPercent}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[11px]">Супровід</span>
                          )}

                          {/* HookChart Toggle Button */}
                          <button
                            onClick={() => toggleChart(pos.id)}
                            className={`ml-2 px-2 py-1 rounded text-[11px] font-sans font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                              isChartOpen
                                ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/40'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                            }`}
                            title="Показати/приховати графік HookChart"
                          >
                            <BarChart2 className="w-3 h-3 text-cyan-400" />
                            <span>HookChart</span>
                            {isChartOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        </div>
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => onClosePosition(pos.id)}
                          className="px-2.5 py-1 text-[11px] font-sans font-medium rounded bg-rose-950/60 text-rose-300 hover:bg-rose-900/60 border border-rose-800/40 transition-colors inline-flex items-center gap-1 cursor-pointer"
                          title="Закрити позицію по ринку"
                        >
                          <XSquare className="w-3 h-3" />
                          <span>Закрити</span>
                        </button>
                      </td>
                    </tr>

                    {/* Expandable Inline HookChart */}
                    {isChartOpen && (
                      <tr>
                        <td colSpan={7} className="p-3 bg-slate-950/90 border-b border-slate-800">
                          <div className="rounded-xl overflow-hidden border border-cyan-900/40 shadow-inner">
                            <HookChart
                              symbol={pos.symbol}
                              entryPrice={pos.entryPrice}
                              stopLoss={pos.stopLoss}
                              takeProfit={pos.takeProfit}
                              currentPrice={pos.currentPrice}
                              direction={pos.direction}
                              formationName={pos.formation}
                              isQuickScalp5m={pos.isQuickScalp5m}
                              expiresAtTimestamp={pos.expiresAtTimestamp}
                              height={280}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
