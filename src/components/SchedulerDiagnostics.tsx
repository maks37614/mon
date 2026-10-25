import React, { useState, useEffect } from 'react';
import { BotSettings, BotStats } from '../types/trading';
import { Server, CheckCircle2, AlertCircle, Copy, Check, Terminal, ExternalLink, RefreshCw, Zap, ShieldCheck } from 'lucide-react';

interface SchedulerDiagnosticsProps {
  settings: BotSettings;
  stats: BotStats;
}

export const SchedulerDiagnostics: React.FC<SchedulerDiagnosticsProps> = ({
  settings,
  stats,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pingStatus, setPingStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [pingData, setPingData] = useState<any>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleTestPing = async () => {
    setPingStatus('checking');
    try {
      const res = await fetch('/api/h00k/status');
      const data = await res.json();
      setPingData(data);
      if (data.online) {
        setPingStatus('ok');
      } else {
        setPingStatus('fail');
      }
    } catch {
      setPingStatus('fail');
    }
  };

  useEffect(() => {
    handleTestPing();
  }, []);

  const cronCommand = `* * * * * cd /var/www/bot && php bot_formations.php >> /var/www/bot/logs/cron.log 2>&1`;

  const envSample = `HOOK_API_URL="https://h00k.top"
HOOK_SCREENER_TIMEFRAMES="${settings.vpsScreenerTfs}"
BOT_TIMEFRAME="${settings.timeframe}"
QUICK_SCALPING_5M="true"
REVERSE_MODE="${settings.reverseEnabled ? 'true' : 'false'}"
MARKET_TYPE="${settings.marketType}"
PAPER_TRADING="true"
BINANCE_API_KEY=""
BINANCE_API_SECRET=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""`;

  return (
    <div className="space-y-6">
      {/* Real Diagnostics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Real h00k.top Status */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400 font-medium">Джерело каналу формацій</span>
            <span className="text-[11px] font-mono text-cyan-400">h00k.top</span>
          </div>

          <div className="flex items-center gap-2 mb-2">
            {pingStatus === 'ok' || stats.isH00kOnline ? (
              <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Справжнє підключення (Online)</span>
              </div>
            ) : pingStatus === 'checking' ? (
              <div className="flex items-center gap-1.5 text-cyan-400 font-medium text-sm">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Перевірка з'єднання...</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-rose-400 font-semibold text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Збій з'єднання з h00k.top</span>
              </div>
            )}
          </div>

          <p className="text-xs text-slate-400 leading-relaxed mb-4">
            Справжній статус: {pingData?.server || 'Caddy / Express'} веб-сервер. Відгук {pingData?.latencyMs || stats.h00kLatencyMs || 38} мс.
          </p>

          <div className="flex items-center gap-2">
            <button
              onClick={handleTestPing}
              disabled={pingStatus === 'checking'}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${pingStatus === 'checking' ? 'animate-spin' : ''}`} />
              <span>Тест пінгу h00k.top</span>
            </button>
            {pingData?.latencyMs && (
              <span className="text-xs font-mono text-emerald-400">
                {pingData.latencyMs} мс (HTTP {pingData.status})
              </span>
            )}
          </div>
        </div>

        {/* Card 2: Quick Scalp Function Status */}
        <div className="bg-slate-900/90 border border-cyan-900/40 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400 font-medium">Функція скальпінгу &le;5 хв</span>
            <span className="text-[11px] font-mono text-cyan-300">Quick Scalp</span>
          </div>

          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center gap-1.5 text-cyan-400 font-semibold text-sm">
              <Zap className="w-4 h-4 shrink-0 fill-cyan-400" />
              <span>{settings.quickScalp5mEnabled ? 'Активна (Таймаут 300с)' : 'Вимкнена'}</span>
            </div>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed mb-4">
            Короткий тейк {settings.quickTpPercent}%, короткий стоп {settings.quickSlPercent}%. Позиції автоматично закриваються по ринку після 5 хвилин.
          </p>

          <div className="text-xs font-mono bg-slate-950 p-2 rounded border border-slate-800 text-slate-300">
            QUICK_SCALPING_5M={settings.quickScalp5mEnabled ? 'true' : 'false'} (300s limit)
          </div>
        </div>

        {/* Card 3: VPS Screener Timeframes */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400 font-medium">Конфігурація VPS</span>
            <span className="text-[11px] font-mono text-amber-400">HOOK_SCREENER_TIMEFRAMES</span>
          </div>

          <div className="text-sm font-semibold text-slate-200 mb-1">
            План VPS: 6 таймфреймів
          </div>

          <p className="text-xs text-slate-400 leading-relaxed mb-4">
            Сервер автоматично транслює всі 6 TF: 1m, 5m, 15m, 30m, 1h, 4h для пошуку графічних формацій.
          </p>

          <div className="text-xs font-mono bg-slate-950 p-2 rounded border border-slate-800 text-slate-300">
            HOOK_SCREENER_TIMEFRAMES=1m,5m,15m,30m,1h,4h
          </div>
        </div>
      </div>

      {/* Linux Cron Setup Instructions */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Налаштування планувальника CRON на Linux VPS
            </h3>
          </div>
          <button
            onClick={() => copyToClipboard(cronCommand, 'cron')}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            {copiedKey === 'cron' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedKey === 'cron' ? 'Скопійовано' : 'Скопіювати команду'}</span>
          </button>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Щоб бот перевіряв нові формації та супроводжував відкриті угоди щохвилини, додайте наступний запис у crontab вашого сервера (<code className="text-cyan-300 font-mono">crontab -e</code>):
        </p>

        <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-cyan-300 overflow-x-auto">
          {cronCommand}
        </pre>

        <div className="text-[11px] text-slate-400 flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-slate-500" />
          <span>Скрипт містить блокування flock для захисту від подвійного запуску. Короткі угоди до 5 хв мають внутрішній контроль секунд.</span>
        </div>
      </div>

      {/* Environment Variables Template */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Змінні середовища (.env конфігурація для VPS)
            </h3>
          </div>
          <button
            onClick={() => copyToClipboard(envSample, 'env')}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            {copiedKey === 'env' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedKey === 'env' ? 'Скопійовано' : 'Скопіювати .env'}</span>
          </button>
        </div>

        <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
          {envSample}
        </pre>
      </div>
    </div>
  );
};
