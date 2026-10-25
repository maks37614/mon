import React from 'react';
import { RefreshCw } from 'lucide-react';
import { BotSettings, BotStats } from '../types/trading';

interface HeaderProps {
  stats: BotStats;
  settings: BotSettings;
  onRunCron: () => void;
  isCronRunning: boolean;
  onToggleAutoCron: () => void;
  onSelectTab: (tab: string) => void;
  activeTab: string;
}

export const Header: React.FC<HeaderProps> = ({
  stats,
  settings,
  onRunCron,
  isCronRunning,
  onToggleAutoCron,
  onSelectTab,
  activeTab,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Platform Info */}
          <div className="flex items-center gap-4">
            <a
              href="https://h00k.top"
              target="_blank"
              rel="noreferrer"
              className="flex items-center focus:outline-none transition-opacity hover:opacity-90"
              title="h00k.top"
            >
              <img
                src="https://www.h00k.top/h00k-logo.svg"
                alt="h00k.top"
                width="194"
                height="48"
                className="block h-6 w-auto max-w-none shrink-0 sm:h-7"
              />
            </a>

            {/* Navigation Tabs - strictly single-line */}
            <nav className="hidden md:flex items-center gap-1 ml-4 bg-slate-900/90 p-1 rounded-lg border border-slate-800 flex-nowrap overflow-x-auto whitespace-nowrap scrollbar-none">
              <button
                onClick={() => onSelectTab('overview')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'overview'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Торгівля та Статистика
              </button>
              <button
                onClick={() => onSelectTab('screener')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'screener'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Скрінер h00k.top Live
              </button>
              <button
                onClick={() => onSelectTab('settings')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'settings'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Налаштування стратегії
              </button>
              <button
                onClick={() => onSelectTab('diagnostics')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'diagnostics'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Планувальник і діагностика
              </button>
              <button
                onClick={() => onSelectTab('logs')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'logs'
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Журнал подій
              </button>
            </nav>
          </div>

          {/* Quick Actions & Cron trigger */}
          <div className="flex items-center gap-2.5 shrink-0 flex-nowrap whitespace-nowrap">
            <button
              onClick={onToggleAutoCron}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors flex items-center gap-1.5 ${
                settings.isAutoCronRunning
                  ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/40 hover:bg-emerald-900/40'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
              title="Автоматичний виклик cron кожні кілька секунд"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${settings.isAutoCronRunning ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              <span>Авто-Cron: {settings.isAutoCronRunning ? 'Активний' : 'Пауза'}</span>
            </button>

            <button
              onClick={onRunCron}
              disabled={isCronRunning}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-cyan-600 hover:bg-cyan-500 text-white transition-all shadow-sm flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isCronRunning ? 'animate-spin' : ''}`} />
              <span>Виконати Cron зараз</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
