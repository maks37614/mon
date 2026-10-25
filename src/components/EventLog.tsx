import React, { useState } from 'react';
import { LogEntry } from '../types/trading';
import { FileText, Trash2, Search, Filter } from 'lucide-react';

interface EventLogProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export const EventLog: React.FC<EventLogProps> = ({ logs, onClearLogs }) => {
  const [filterLevel, setFilterLevel] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');

  const filteredLogs = logs.filter((l) => {
    const matchesLevel = filterLevel === 'ALL' || l.level === filterLevel;
    const matchesSearch =
      l.message.toLowerCase().includes(search.toLowerCase()) ||
      (l.details && l.details.toLowerCase().includes(search.toLowerCase()));
    return matchesLevel && matchesSearch;
  });

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'TRADE':
        return 'text-cyan-400 font-bold';
      case 'SUCCESS':
        return 'text-emerald-400 font-semibold';
      case 'WARN':
        return 'text-amber-400 font-medium';
      case 'ERROR':
        return 'text-rose-400 font-bold';
      default:
        return 'text-slate-400';
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
      {/* Header & Filters */}
      <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-cyan-400" />
            <span>Журнал подій (System Logs)</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Фіксація операцій cron, отримання точок входу з h00k.top, закриття по TP/SL та помилок.
          </p>
        </div>

        <button
          onClick={onClearLogs}
          className="self-start sm:self-auto px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5 text-slate-400" />
          <span>Очистити журнал</span>
        </button>
      </div>

      {/* Filter and Search Bar - strictly single-line */}
      <div className="p-3 bg-slate-950/60 border-b border-slate-800 flex items-center gap-3 flex-nowrap overflow-x-auto whitespace-nowrap scrollbar-none">
        <div className="relative min-w-[180px] max-w-xs flex-1 shrink-0">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Фільтр за повідомленням..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-md pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        <div className="flex items-center gap-1 text-xs shrink-0 flex-nowrap whitespace-nowrap">
          {['ALL', 'TRADE', 'SUCCESS', 'WARN', 'ERROR', 'INFO'].map((lvl) => (
            <button
              key={lvl}
              onClick={() => setFilterLevel(lvl)}
              className={`px-2.5 py-1 rounded transition-colors text-[11px] font-mono whitespace-nowrap shrink-0 cursor-pointer ${
                filterLevel === lvl
                  ? 'bg-slate-800 text-slate-100 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>
      </div>

      {/* Log Feed */}
      <div className="p-4 max-h-[460px] overflow-y-auto space-y-2 font-mono text-xs">
        {filteredLogs.length === 0 ? (
          <div className="py-12 text-center text-slate-500">
            Записів не знайдено за вибраним критерієм.
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className="py-1.5 px-2 rounded hover:bg-slate-800/40 transition-colors flex flex-col sm:flex-row sm:items-baseline gap-1.5 sm:gap-3"
            >
              <span className="text-slate-400 shrink-0 text-[11px] select-none">
                [{log.timestamp}]
              </span>
              <span className={`shrink-0 w-16 text-[11px] ${getLevelColor(log.level)}`}>
                {log.level}
              </span>
              <div className="flex-1 text-slate-200">
                <span>{log.message}</span>
                {log.details && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {log.details}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
