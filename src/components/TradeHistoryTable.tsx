import React, { useState } from 'react';
import { TradeHistoryItem } from '../types/trading';
import { Download, ChevronLeft, ChevronRight, ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react';

interface TradeHistoryTableProps {
  history: TradeHistoryItem[];
  grossProfit: number;
  grossLoss: number;
  onExportCsv: () => void;
}

export const TradeHistoryTable: React.FC<TradeHistoryTableProps> = ({
  history,
  grossProfit,
  grossLoss,
  onExportCsv,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const totalPages = Math.max(1, Math.ceil(history.length / itemsPerPage));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const displayedTrades = history.slice(startIndex, startIndex + itemsPerPage);

  const formatMoney = (val: number) => {
    return val.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const getResultBadge = (result: TradeHistoryItem['result']) => {
    switch (result) {
      case 'TP':
        return <span className="text-emerald-400 font-bold">Take Profit (Тейк)</span>;
      case 'SL':
        return <span className="text-rose-400 font-bold">Stop Loss (Стоп)</span>;
      case 'TIME_5M':
        return <span className="text-amber-400 font-bold">Таймаут 5 хв (300с)</span>;
      default:
        return <span className="text-slate-400 font-medium">Вручну</span>;
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
      {/* Header bar */}
      <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-100">Історія угод</h3>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1.5 font-mono flex-nowrap overflow-x-auto whitespace-nowrap scrollbar-none pb-0.5">
            <span>Прибуток: {formatMoney(grossProfit)}</span>
            <span aria-hidden="true">·</span>
            <span>збитки: {formatMoney(grossLoss)}</span>
            <span aria-hidden="true">·</span>
            <span>{history.length} угод цього бота</span>
            <span aria-hidden="true">·</span>
            <span>загальний ліміт 1000</span>
          </div>
        </div>

        <button
          onClick={onExportCsv}
          className="self-start md:self-auto px-3.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5 text-slate-400" />
          <span>Експорт CSV</span>
        </button>
      </div>

      {/* Table content */}
      {history.length === 0 ? (
        <div className="py-12 px-4 text-center">
          <p className="text-sm text-slate-400">
            Тут з’являться закриті угоди зі стопами, цілями та результатом після комісій.
          </p>
          <span className="text-xs text-slate-500 block mt-1 font-mono">
            Запис відкривається під час відкриття ордера та фіксується після досягнення TP/SL або таймауту 5 хвилин
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 font-medium">
                <th className="py-3 px-4">Інструмент / формація</th>
                <th className="py-3 px-4">Напрямок</th>
                <th className="py-3 px-4">Вхід → вихід</th>
                <th className="py-3 px-4">Стоп / ціль</th>
                <th className="py-3 px-4">Результат</th>
                <th className="py-3 px-4">Чистий P&L</th>
                <th className="py-3 px-4">Період, UTC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {displayedTrades.map((t) => {
                const isWin = t.netPnl >= 0;
                const isLong = t.direction === 'LONG';

                return (
                  <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                    {/* Symbol / Formation */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <span className="font-bold text-slate-100">{t.symbol}</span>
                        {t.isQuickScalp5m && (
                          <span className="text-[10px] text-cyan-300 font-sans flex items-center">
                            <Zap className="w-2.5 h-2.5 mr-0.5" /> &le;5м
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-sans truncate max-w-[150px]">
                        {t.formation}
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
                        {t.isReversed && (
                          <span className="text-[10px] text-amber-400 font-sans">(рев)</span>
                        )}
                      </div>
                    </td>

                    {/* Entry -> Exit */}
                    <td className="py-3 px-4">
                      <div className="text-slate-200">
                        {t.entryPrice} → {t.exitPrice}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {t.durationSeconds ? `${t.durationSeconds}с утримання` : `Обсяг: ${t.quantity}`}
                      </div>
                    </td>

                    {/* Stop / Target */}
                    <td className="py-3 px-4">
                      <div className="text-rose-400">SL: {t.stopLoss}</div>
                      <div className="text-emerald-400">TP: {t.takeProfit}</div>
                    </td>

                    {/* Result */}
                    <td className="py-3 px-4">
                      {getResultBadge(t.result)}
                    </td>

                    {/* Net P&L */}
                    <td className="py-3 px-4">
                      <div
                        className={`font-semibold ${
                          isWin ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isWin ? '+' : ''}
                        {formatMoney(t.netPnl)} USDT
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Ком: -{t.fee.toFixed(3)}
                      </div>
                    </td>

                    {/* Period UTC */}
                    <td className="py-3 px-4 text-slate-400 text-[11px]">
                      <div>Відкр: {t.openedAt}</div>
                      <div>Закр: {t.closedAt}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination matching "1 / 1" */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between text-xs text-slate-400">
        <div>
          Показано {displayedTrades.length} з {history.length} угод
        </div>
        <div className="flex items-center gap-2 font-mono">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-slate-300 font-semibold px-2">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
