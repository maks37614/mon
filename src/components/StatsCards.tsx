import React from 'react';
import { BotStats } from '../types/trading';

interface StatsCardsProps {
  stats: BotStats;
}

export const StatsCards: React.FC<StatsCardsProps> = ({ stats }) => {
  const formatMoney = (val: number) => {
    return val.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const isEquityUp = stats.equityChangePercent >= 0;
  const isPnlPositive = stats.closedNetPnl >= 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {/* 1. Еквіті */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Еквіті</span>
          <span className="text-[11px] text-slate-400 block">із відкритим P&L</span>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold font-mono text-slate-100 tracking-tight">
            {formatMoney(stats.equity)}
          </div>
          <div className={`text-xs font-mono font-medium mt-0.5 ${isEquityUp ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isEquityUp ? '+' : ''}{stats.equityChangePercent.toFixed(2)}% від старту
          </div>
        </div>
      </div>

      {/* 2. Баланс */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Баланс</span>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold font-mono text-slate-100 tracking-tight">
            {formatMoney(stats.balance)}
          </div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">
            Старт: {formatMoney(stats.startBalance)}
          </div>
        </div>
      </div>

      {/* 3. Чистий P&L закритих */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Чистий P&L закритих</span>
          <span className="text-[11px] text-slate-400 block">реалізований прибуток</span>
        </div>
        <div className="mt-3">
          <div className={`text-xl font-bold font-mono tracking-tight ${isPnlPositive ? 'text-slate-100' : 'text-rose-400'}`}>
            {isPnlPositive && stats.closedNetPnl > 0 ? '+' : ''}{formatMoney(stats.closedNetPnl)}
          </div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">
            Комісії всіх угод: {formatMoney(stats.totalCommissions)}
          </div>
        </div>
      </div>

      {/* 4. Win rate */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Win rate</span>
          <span className="text-[11px] text-slate-400 block">успішність сигналів</span>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold font-mono text-slate-100 tracking-tight">
            {stats.winRate}%
          </div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">
            <span>{stats.totalTrades} завершених</span>
            <span aria-hidden="true"> · </span>
            <span>PF {stats.profitFactor !== null ? stats.profitFactor : '—'}</span>
          </div>
        </div>
      </div>

      {/* 5. Макс. просадка */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Макс. просадка</span>
          <span className="text-[11px] text-slate-400 block">глибина корекції</span>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold font-mono text-slate-100 tracking-tight">
            {stats.maxDrawdownPercent.toFixed(2)}%
          </div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">
            За спостереженнями cron
          </div>
        </div>
      </div>

      {/* 6. Відкрито позицій */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Відкрито позицій</span>
          <span className="text-[11px] text-slate-400 block">активні слоти</span>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold font-mono text-cyan-400 tracking-tight">
            {stats.openPositionsCount} / {stats.maxPositionsCount}
          </div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">
            <span>Нереалізований P&L: </span>
            <span className={stats.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {stats.unrealizedPnl >= 0 ? '+' : ''}{formatMoney(stats.unrealizedPnl)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
