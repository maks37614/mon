/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { ControlsBar } from './components/ControlsBar';
import { StatsCards } from './components/StatsCards';
import { OpenPositionsTable } from './components/OpenPositionsTable';
import { TradeHistoryTable } from './components/TradeHistoryTable';
import { FormationsScreener } from './components/FormationsScreener';
import { StrategySettings } from './components/StrategySettings';
import { SchedulerDiagnostics } from './components/SchedulerDiagnostics';
import { EventLog } from './components/EventLog';
import { tradingEngine } from './services/tradingEngine';
import { BotSettings, BotStats, FormationSignal, Position, TradeHistoryItem } from './types/trading';

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [settings, setSettings] = useState<BotSettings>(tradingEngine.getSettings());
  const [stats, setStats] = useState<BotStats>(tradingEngine.getStats());
  const [positions, setPositions] = useState<Position[]>(tradingEngine.getPositions());
  const [history, setHistory] = useState<TradeHistoryItem[]>(tradingEngine.getHistory());
  const [logs, setLogs] = useState(tradingEngine.getLogs());
  const [isCronRunning, setIsCronRunning] = useState<boolean>(false);

  // Sync engine state to React
  useEffect(() => {
    const unsubscribe = tradingEngine.subscribe(() => {
      setSettings(tradingEngine.getSettings());
      setStats(tradingEngine.getStats());
      setPositions(tradingEngine.getPositions());
      setHistory(tradingEngine.getHistory());
      setLogs(tradingEngine.getLogs());
    });
    return () => unsubscribe();
  }, []);

  const handleRunCron = useCallback(async () => {
    if (isCronRunning) return;
    setIsCronRunning(true);
    try {
      await tradingEngine.runCronCycle();
    } finally {
      setIsCronRunning(false);
    }
  }, [isCronRunning]);

  // Auto-cron timer
  useEffect(() => {
    if (!settings.isAutoCronRunning) return;

    const interval = setInterval(() => {
      handleRunCron();
    }, Math.max(5000, settings.autoCronIntervalSeconds * 1000));

    return () => clearInterval(interval);
  }, [settings.isAutoCronRunning, settings.autoCronIntervalSeconds, handleRunCron]);

  // Periodic live price updater for open positions (every 2.5 seconds)
  useEffect(() => {
    const priceInterval = setInterval(() => {
      tradingEngine.updateLivePricesAndPositions();
    }, 2500);
    return () => clearInterval(priceInterval);
  }, []);

  const handleUpdateSettings = (partial: Partial<BotSettings>) => {
    tradingEngine.updateSettings(partial);
  };

  const handleClosePosition = (id: string) => {
    tradingEngine.closePositionManually(id);
  };

  const handleEnterTrade = (signal: FormationSignal) => {
    tradingEngine.manualEnterTrade(signal);
  };

  const handleToggleAutoCron = () => {
    tradingEngine.updateSettings({
      isAutoCronRunning: !settings.isAutoCronRunning,
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/20 selection:text-cyan-300">
      {/* Top Bar Header */}
      <Header
        stats={stats}
        settings={settings}
        onRunCron={handleRunCron}
        isCronRunning={isCronRunning}
        onToggleAutoCron={handleToggleAutoCron}
        onSelectTab={setActiveTab}
        activeTab={activeTab}
      />

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Mobile Navigation Tabs - strictly single-line */}
        <div className="md:hidden flex items-center gap-1.5 flex-nowrap overflow-x-auto whitespace-nowrap pb-1 text-xs scrollbar-none">
          {[
            { id: 'overview', label: 'Торгівля' },
            { id: 'screener', label: 'Скрінер Live' },
            { id: 'settings', label: 'Налаштування' },
            { id: 'diagnostics', label: 'Діагностика' },
            { id: 'logs', label: 'Журнал' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-slate-800 text-white font-medium'
                  : 'text-slate-400 bg-slate-900 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab 1: Primary Trading & Overview */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Top Quick Controls: Timeframe, Quick Scalp <= 5m, Reverse, Real Status */}
            <ControlsBar
              settings={settings}
              stats={stats}
              onUpdateSettings={handleUpdateSettings}
            />

            {/* 6 KPI Statistic Cards */}
            <StatsCards stats={stats} />

            {/* Open Positions Table with 5-min timer */}
            <OpenPositionsTable
              positions={positions}
              timeframe={settings.timeframe}
              marketType={settings.marketType}
              onClosePosition={handleClosePosition}
            />

            {/* Trade History Table with CSV Export */}
            <TradeHistoryTable
              history={history}
              grossProfit={stats.grossProfit}
              grossLoss={stats.grossLoss}
              onExportCsv={() => tradingEngine.exportHistoryCsv()}
            />
          </div>
        )}

        {/* Tab 2: Live Formations Screener */}
        {activeTab === 'screener' && (
          <FormationsScreener
            activeTimeframe={settings.timeframe}
            reverseEnabled={settings.reverseEnabled}
            quickScalp5mEnabled={settings.quickScalp5mEnabled}
            onEnterTrade={handleEnterTrade}
          />
        )}

        {/* Tab 3: Strategy & Risk Settings */}
        {activeTab === 'settings' && (
          <StrategySettings
            settings={settings}
            onSaveSettings={handleUpdateSettings}
            onResetSimulation={() => tradingEngine.resetToDefaultState()}
          />
        )}

        {/* Tab 4: Scheduler & Real Diagnostics */}
        {activeTab === 'diagnostics' && (
          <SchedulerDiagnostics
            settings={settings}
            stats={stats}
          />
        )}

        {/* Tab 5: Event Log */}
        {activeTab === 'logs' && (
          <EventLog
            logs={logs}
            onClearLogs={() => tradingEngine.clearLogs()}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-4 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span>АвтоСкальпінг Формації · h00k.top</span>
            <span aria-hidden="true">·</span>
            <span>PHP 8.1+ Cron Engine</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
            <span>TF: {settings.timeframe}</span>
            <span aria-hidden="true">·</span>
            <span className="text-cyan-400">Скальп &le;5хв: {settings.quickScalp5mEnabled ? 'АКТИВНИЙ' : 'ВИМК'}</span>
            <span aria-hidden="true">·</span>
            <span>Реверс: {settings.reverseEnabled ? 'УВІМК' : 'ВИМК'}</span>
            <span aria-hidden="true">·</span>
            <span>Баланс: {stats.balance.toFixed(2)} USDT</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
