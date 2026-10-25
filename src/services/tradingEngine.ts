import { BotSettings, BotStats, FormationSignal, LogEntry, Position, Timeframe, TradeHistoryItem } from '../types/trading';

const STORAGE_KEYS = {
  SETTINGS: 'autoscalp_settings',
  POSITIONS: 'autoscalp_positions',
  HISTORY: 'autoscalp_history',
  STATS: 'autoscalp_stats',
  LOGS: 'autoscalp_logs',
};

export const DEFAULT_SETTINGS: BotSettings = {
  timeframe: '1m',
  reverseEnabled: false,
  marketType: 'futures',
  maxPositions: 5,
  initialBalance: 1000.0,
  riskPerTradePercent: 5.0,
  leverage: 5,
  slippageTolerancePercent: 0.20,
  minRiskReward: 1.8,
  takerFeePercent: 0.04,
  useBreakEvenAt50: true,
  h00kUrl: 'https://h00k.top',
  vpsScreenerTfs: '1m,5m,15m,30m,1h,4h',
  autoCronIntervalSeconds: 10,
  isAutoCronRunning: true,
  binanceTestnet: false,
  telegramAlerts: true,

  // Quick Scalp mode <= 5 min
  quickScalp5mEnabled: true, // Enabled by default to highlight new feature
  quickTpPercent: 0.45,       // Tight TP 0.45%
  quickSlPercent: 0.25,       // Tight SL 0.25%
  quickScalpMaxDurationSeconds: 300, // 5 minutes hard limit
};

export class TradingEngineService {
  private settings: BotSettings;
  private positions: Position[] = [];
  private history: TradeHistoryItem[] = [];
  private logs: LogEntry[] = [];
  private stats: BotStats;
  private peakEquity: number = 1000.0;
  private listeners: (() => void)[] = [];

  constructor() {
    this.settings = this.loadFromStorage(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
    this.positions = this.loadFromStorage(STORAGE_KEYS.POSITIONS, []);
    this.history = this.loadFromStorage(STORAGE_KEYS.HISTORY, []);
    this.logs = this.loadFromStorage(STORAGE_KEYS.LOGS, [
      {
        id: 'init_log_1',
        timestamp: this.formatUtcDate(new Date()),
        level: 'INFO',
        message: 'Ініціалізація АвтоСкальпінг Формації v2.5 (Справжнє підключення h00k.top)'
      },
      {
        id: 'init_log_2',
        timestamp: this.formatUtcDate(new Date()),
        level: 'TRADE',
        message: 'Активовано функцію коротких позицій до 5 хв: короткий тейк 0.45%, короткий стоп 0.25%, автозакриття через 300с.'
      }
    ]);

    this.stats = this.loadFromStorage(STORAGE_KEYS.STATS, {
      balance: this.settings.initialBalance,
      startBalance: this.settings.initialBalance,
      equity: this.settings.initialBalance,
      equityChangePercent: 0,
      closedNetPnl: 0,
      totalCommissions: 0,
      totalTrades: 0,
      winTrades: 0,
      lossTrades: 0,
      winRate: 0,
      profitFactor: null,
      grossProfit: 0,
      grossLoss: 0,
      maxDrawdownPercent: 0,
      openPositionsCount: 0,
      maxPositionsCount: this.settings.maxPositions,
      unrealizedPnl: 0,
      lastRunUtc: this.formatUtcDate(new Date()),
      screenerChannelStatus: 'Підключено (h00k.top)',
      isH00kOnline: true,
      h00kLatencyMs: 38,
      vpsPlanReceived: true,
    });

    this.recalculateStats();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    this.saveToStorage();
    this.listeners.forEach(l => l());
  }

  private loadFromStorage<T>(key: string, defaultValue: T): T {
    try {
      const saved = localStorage.getItem(key);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return defaultValue;
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
      localStorage.setItem(STORAGE_KEYS.POSITIONS, JSON.stringify(this.positions));
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(this.history));
      localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(this.logs.slice(0, 300)));
      localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(this.stats));
    } catch {
      // ignore
    }
  }

  public formatUtcDate(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const day = pad(date.getUTCDate());
    const month = pad(date.getUTCMonth() + 1);
    const year = date.getUTCFullYear();
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds} UTC`;
  }

  public getSettings(): BotSettings {
    return { ...this.settings };
  }

  public getPositions(): Position[] {
    return [...this.positions];
  }

  public getHistory(): TradeHistoryItem[] {
    return [...this.history];
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public getStats(): BotStats {
    return { ...this.stats };
  }

  public addLog(level: LogEntry['level'], message: string, details?: string): void {
    const entry: LogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: this.formatUtcDate(new Date()),
      level,
      message,
      details,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 500) {
      this.logs.pop();
    }
    this.notify();
  }

  public clearLogs(): void {
    this.logs = [];
    this.addLog('INFO', 'Журнал подій очищено користувачем');
  }

  public updateSettings(partial: Partial<BotSettings>): void {
    const oldTf = this.settings.timeframe;
    const oldRev = this.settings.reverseEnabled;
    const oldQs = this.settings.quickScalp5mEnabled;

    this.settings = { ...this.settings, ...partial };

    if (partial.timeframe && partial.timeframe !== oldTf) {
      this.addLog(
        'INFO',
        `Таймфрейм змінено з ${oldTf} на ${partial.timeframe}. Бот перевірить готовий кеш під час наступного cron. Відкриті угоди супроводжуються за власними рівнями.`
      );
    }

    if (partial.reverseEnabled !== undefined && partial.reverseEnabled !== oldRev) {
      this.addLog(
        'WARN',
        `Реверс ${partial.reverseEnabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}. Після вихідних фільтрів LONG стає SHORT і навпаки; стоп і ціль міняються ролями.`
      );
    }

    if (partial.quickScalp5mEnabled !== undefined && partial.quickScalp5mEnabled !== oldQs) {
      this.addLog(
        'TRADE',
        `Режим коротких позицій (до 5 хв): ${partial.quickScalp5mEnabled ? 'АКТИВОВАНО' : 'ДЕАКТИВОВАНО'}. Тейк: ${this.settings.quickTpPercent}%, Стоп: ${this.settings.quickSlPercent}%, Ліміт: 300 сек.`
      );
    }

    this.stats.maxPositionsCount = this.settings.maxPositions;
    this.notify();
  }

  /**
   * Executes a complete Cron cycle with REAL live connection to h00k.top and Binance
   */
  public async runCronCycle(): Promise<void> {
    const runTime = this.formatUtcDate(new Date());
    this.stats.lastRunUtc = runTime;

    this.addLog('INFO', `[Cron] Запуск циклу. TF: ${this.settings.timeframe} | Режим: ${this.settings.quickScalp5mEnabled ? 'Швидкий скальпінг (<=5 хв)' : 'Стандартний'} | Реверс: ${this.settings.reverseEnabled ? 'УВІМК' : 'ВИМК'}`);

    // Step 1: Monitor active positions and check 5-minute timeout / TP / SL
    await this.updateLivePricesAndPositions();

    // Step 2: Check real status of h00k.top
    try {
      const statusRes = await fetch('/api/h00k/status');
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        this.stats.isH00kOnline = statusJson.online;
        this.stats.h00kLatencyMs = statusJson.latencyMs;
      }
    } catch {
      // ignore
    }

    // Step 3: Fetch real formations from h00k.top screener engine
    try {
      const quickScalpParam = this.settings.quickScalp5mEnabled ? 'true' : 'false';
      const res = await fetch(`/api/h00k/formations?timeframe=${this.settings.timeframe}&quickScalp=${quickScalpParam}`);
      if (!res.ok) {
        this.stats.screenerChannelStatus = `Помилка джерела (${res.status})`;
        this.addLog('ERROR', `Помилка зв'язку зі скрінером h00k.top (HTTP ${res.status})`);
        this.notify();
        return;
      }

      const json = await res.json();
      this.stats.screenerChannelStatus = `Справжнє підключення (${json.count || 0} формацій)`;
      const signals: FormationSignal[] = json.data || [];

      this.addLog('INFO', `Отримано ${signals.length} формацій зі скрінера h00k.top для TF ${this.settings.timeframe}`);

      // Step 4: Evaluate signals and open trades
      this.evaluateSignalsForEntry(signals);

    } catch (err: any) {
      this.stats.screenerChannelStatus = 'Збій мережі';
      this.addLog('ERROR', `Помилка запиту формацій: ${err.message}`);
    }

    this.recalculateStats();
    this.notify();
  }

  /**
   * Fetches latest live prices and checks TP, SL, and 5-MINUTE TIME LIMIT
   */
  public async updateLivePricesAndPositions(): Promise<void> {
    if (this.positions.length === 0) return;

    try {
      const res = await fetch('/api/binance/prices');
      if (!res.ok) return;
      const prices: { symbol: string; price: string }[] = await res.json();
      const priceMap = new Map<string, number>();
      prices.forEach(p => priceMap.set(p.symbol, parseFloat(p.price)));

      const activePositions: Position[] = [];
      const now = Date.now();

      for (const pos of this.positions) {
        const live = priceMap.get(pos.symbol);
        if (!live) {
          activePositions.push(pos);
          continue;
        }

        pos.currentPrice = live;
        const isLong = pos.direction === 'LONG';
        const diff = isLong ? (live - pos.entryPrice) : (pos.entryPrice - live);
        pos.unrealizedPnl = diff * pos.quantity;
        pos.unrealizedPnlPercent = ((diff / pos.entryPrice) * 100) * (pos.marketType === 'futures' ? this.settings.leverage : 1);

        // 1. Check Take Profit
        const isTpHit = isLong ? (live >= pos.takeProfit) : (live <= pos.takeProfit);
        // 2. Check Stop Loss
        const isSlHit = isLong ? (live <= pos.stopLoss) : (live >= pos.stopLoss);
        // 3. Check 5-MINUTE TIME LIMIT for Quick Scalping (<= 300 sec)
        const isExpired5m = pos.isQuickScalp5m && pos.expiresAtTimestamp && now >= pos.expiresAtTimestamp;

        if (isTpHit) {
          this.closePositionRecord(pos, pos.takeProfit, 'TP');
        } else if (isSlHit) {
          this.closePositionRecord(pos, pos.stopLoss, 'SL');
        } else if (isExpired5m) {
          // Auto close at market after 5 minutes
          this.closePositionRecord(pos, live, 'TIME_5M');
        } else {
          activePositions.push(pos);
        }
      }

      this.positions = activePositions;
      this.recalculateStats();
      this.notify();
    } catch {
      // ignore
    }
  }

  /**
   * Evaluates formation signals to open trades based on settings, quick scalping, & reverse mode
   */
  public evaluateSignalsForEntry(signals: FormationSignal[]): void {
    if (this.positions.length >= this.settings.maxPositions) {
      return;
    }

    const openSymbols = new Set(this.positions.map(p => p.symbol));

    for (const signal of signals) {
      if (this.positions.length >= this.settings.maxPositions) break;
      if (openSymbols.has(signal.symbol)) continue;

      let direction = signal.direction;
      let stopLoss = signal.stopLoss;
      let takeProfit = signal.takeProfit;
      const isReversed = this.settings.reverseEnabled;
      const isQuick = this.settings.quickScalp5mEnabled;

      // Reverse transformation if active
      if (isReversed) {
        direction = direction === 'LONG' ? 'SHORT' : 'LONG';
        const oldSl = stopLoss;
        stopLoss = takeProfit;
        takeProfit = oldSl;
      }

      // Quick scalping recalculation for tight TP & SL if enabled
      const live = signal.currentPrice;
      if (isQuick) {
        const isLong = direction === 'LONG';
        const tightTpDist = live * (this.settings.quickTpPercent / 100);
        const tightSlDist = live * (this.settings.quickSlPercent / 100);

        takeProfit = isLong ? (live + tightTpDist) : (live - tightTpDist);
        stopLoss = isLong ? (live - tightSlDist) : (live + tightSlDist);
      }

      // Spot market protection: no shorting on spot
      if (this.settings.marketType === 'spot' && direction === 'SHORT') {
        this.addLog('WARN', `Пропуск сигналу ${signal.symbol}: Short на spot ринку не виконується.`);
        continue;
      }

      // Slippage tolerance verification
      const entry = signal.entryPrice;
      const deviationPercent = Math.abs(live - entry) / entry * 100;
      if (deviationPercent > this.settings.slippageTolerancePercent && !isQuick) {
        continue;
      }

      // Position sizing
      const positionUsdt = (this.stats.balance * (this.settings.riskPerTradePercent / 100)) * (this.settings.marketType === 'futures' ? this.settings.leverage : 1);
      const quantity = positionUsdt / live;

      const now = Date.now();
      const expiresAt = now + (this.settings.quickScalpMaxDurationSeconds * 1000);

      const precision = live < 1 ? 6 : (live < 10 ? 4 : 2);

      const newPosition: Position = {
        id: `pos_${signal.symbol}_${Date.now()}`,
        symbol: signal.symbol,
        formation: signal.formation,
        direction,
        entryPrice: Number(live.toFixed(precision)),
        currentPrice: Number(live.toFixed(precision)),
        quantity: Number(quantity.toFixed(4)),
        amountUsdt: Number(positionUsdt.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(precision)),
        takeProfit: Number(takeProfit.toFixed(precision)),
        timeframe: this.settings.timeframe,
        marketType: this.settings.marketType,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        openedAt: this.formatUtcDate(new Date()),
        openedTimestamp: now,
        expiresAtTimestamp: isQuick ? expiresAt : undefined,
        status: 'active',
        isReversed,
        isQuickScalp5m: isQuick,
      };

      this.positions.push(newPosition);
      openSymbols.add(signal.symbol);

      this.addLog(
        'TRADE',
        `🚀 [ВХІД ${isQuick ? '⚡ ШВИДКИЙ СКАЛЬП $\\le$ 5хв' : ''}] ${signal.symbol} [${direction}]${isReversed ? ' (РЕВЕРС)' : ''}`,
        `Вхід: ${live} | Короткий Стоп: ${newPosition.stopLoss} | Короткий Тейк: ${newPosition.takeProfit} | Ліміт: 300с`
      );
    }
  }

  public manualEnterTrade(signal: FormationSignal): void {
    let direction = signal.direction;
    let stopLoss = signal.stopLoss;
    let takeProfit = signal.takeProfit;
    const isReversed = this.settings.reverseEnabled;
    const isQuick = this.settings.quickScalp5mEnabled;

    if (isReversed) {
      direction = direction === 'LONG' ? 'SHORT' : 'LONG';
      const oldSl = stopLoss;
      stopLoss = takeProfit;
      takeProfit = oldSl;
    }

    const live = signal.currentPrice;
    if (isQuick) {
      const isLong = direction === 'LONG';
      const tightTpDist = live * (this.settings.quickTpPercent / 100);
      const tightSlDist = live * (this.settings.quickSlPercent / 100);

      takeProfit = isLong ? (live + tightTpDist) : (live - tightTpDist);
      stopLoss = isLong ? (live - tightSlDist) : (live + tightSlDist);
    }

    if (this.settings.marketType === 'spot' && direction === 'SHORT') {
      this.addLog('WARN', `Пропуск ручного входу ${signal.symbol}: Short на spot ринку не виконується.`);
      return;
    }

    const positionUsdt = (this.stats.balance * (this.settings.riskPerTradePercent / 100)) * (this.settings.marketType === 'futures' ? this.settings.leverage : 1);
    const quantity = positionUsdt / live;
    const now = Date.now();
    const expiresAt = now + (this.settings.quickScalpMaxDurationSeconds * 1000);
    const precision = live < 1 ? 6 : (live < 10 ? 4 : 2);

    const newPosition: Position = {
      id: `pos_${signal.symbol}_${Date.now()}`,
      symbol: signal.symbol,
      formation: signal.formation,
      direction,
      entryPrice: Number(live.toFixed(precision)),
      currentPrice: Number(live.toFixed(precision)),
      quantity: Number(quantity.toFixed(4)),
      amountUsdt: Number(positionUsdt.toFixed(2)),
      stopLoss: Number(stopLoss.toFixed(precision)),
      takeProfit: Number(takeProfit.toFixed(precision)),
      timeframe: this.settings.timeframe,
      marketType: this.settings.marketType,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      openedAt: this.formatUtcDate(new Date()),
      openedTimestamp: now,
      expiresAtTimestamp: isQuick ? expiresAt : undefined,
      status: 'active',
      isReversed,
      isQuickScalp5m: isQuick,
    };

    if (this.positions.length >= this.settings.maxPositions) {
      const removed = this.positions.shift();
      if (removed) {
        this.closePositionRecord(removed, removed.currentPrice, 'MANUAL');
        this.addLog('INFO', `Досягнуто ліміт позицій. Для ручного входу закрито найстарішу позицію ${removed.symbol}`);
      }
    }

    this.positions.push(newPosition);
    this.recalculateStats();
    this.notify();

    this.addLog(
      'TRADE',
      `🚀 [РУЧНИЙ ВХІД ${isQuick ? '⚡ ШВИДКИЙ СКАЛЬП $\\le$ 5хв' : ''}] ${signal.symbol} [${direction}]${isReversed ? ' (РЕВЕРС)' : ''}`,
      `Вхід: ${live} | Стоп: ${newPosition.stopLoss} | Тейк: ${newPosition.takeProfit}`
    );
  }

  public closePositionManually(positionId: string): void {
    const pos = this.positions.find(p => p.id === positionId);
    if (!pos) return;

    this.positions = this.positions.filter(p => p.id !== positionId);
    this.closePositionRecord(pos, pos.currentPrice, 'MANUAL');
    this.recalculateStats();
    this.notify();
  }

  private closePositionRecord(pos: Position, exitPrice: number, result: 'TP' | 'SL' | 'MANUAL' | 'TIME_5M'): void {
    const isLong = pos.direction === 'LONG';
    const diff = isLong ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
    const grossPnl = diff * pos.quantity;

    const feeOpen = (pos.entryPrice * pos.quantity) * (this.settings.takerFeePercent / 100);
    const feeClose = (exitPrice * pos.quantity) * (this.settings.takerFeePercent / 100);
    const totalFee = feeOpen + feeClose;
    const netPnl = grossPnl - totalFee;
    const pnlPercent = (netPnl / (pos.amountUsdt / (pos.marketType === 'futures' ? this.settings.leverage : 1))) * 100;

    const closedAt = this.formatUtcDate(new Date());
    const durationSeconds = Math.round((Date.now() - pos.openedTimestamp) / 1000);

    const precision = exitPrice < 1 ? 6 : (exitPrice < 10 ? 4 : 2);

    const trade: TradeHistoryItem = {
      id: pos.id,
      symbol: pos.symbol,
      formation: pos.formation,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: Number(exitPrice.toFixed(precision)),
      quantity: pos.quantity,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      result,
      grossPnl: Number(grossPnl.toFixed(2)),
      fee: Number(totalFee.toFixed(4)),
      netPnl: Number(netPnl.toFixed(2)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
      openedAt: pos.openedAt,
      closedAt,
      durationSeconds,
      timeframe: pos.timeframe,
      marketType: pos.marketType,
      isReversed: pos.isReversed,
      isQuickScalp5m: pos.isQuickScalp5m,
    };

    this.history.unshift(trade);
    if (this.history.length > 1000) {
      this.history.pop();
    }

    this.stats.balance += netPnl;
    this.stats.closedNetPnl += netPnl;
    this.stats.totalCommissions += totalFee;
    this.stats.totalTrades++;

    if (netPnl >= 0) {
      this.stats.winTrades++;
      this.stats.grossProfit += netPnl;
    } else {
      this.stats.lossTrades++;
      this.stats.grossLoss += Math.abs(netPnl);
    }

    const resultLabel = result === 'TP'
      ? 'Take Profit'
      : result === 'SL'
      ? 'Stop Loss'
      : result === 'TIME_5M'
      ? 'Таймаут 5 хв (Time Stop)'
      : 'Вручну';

    this.addLog(
      netPnl >= 0 ? 'SUCCESS' : 'WARN',
      `Угода ${pos.symbol} закрита по [${resultLabel}]. P&L: ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} USDT (тривалість ${durationSeconds}с)`,
      `Вхід: ${pos.entryPrice} -> Вихід: ${exitPrice}`
    );
  }

  private recalculateStats(): void {
    const totalUnrealized = this.positions.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0);
    this.stats.unrealizedPnl = Number(totalUnrealized.toFixed(2));
    this.stats.equity = Number((this.stats.balance + totalUnrealized).toFixed(2));
    this.stats.openPositionsCount = this.positions.length;
    this.stats.maxPositionsCount = this.settings.maxPositions;

    const diffFromStart = this.stats.equity - this.stats.startBalance;
    this.stats.equityChangePercent = Number(((diffFromStart / this.stats.startBalance) * 100).toFixed(2));

    if (this.stats.totalTrades > 0) {
      this.stats.winRate = Math.round((this.stats.winTrades / this.stats.totalTrades) * 100);
      this.stats.profitFactor = this.stats.grossLoss > 0
        ? Number((this.stats.grossProfit / this.stats.grossLoss).toFixed(2))
        : (this.stats.grossProfit > 0 ? 99.9 : null);
    } else {
      this.stats.winRate = 0;
      this.stats.profitFactor = null;
    }

    if (this.stats.equity > this.peakEquity) {
      this.peakEquity = this.stats.equity;
    }
    const dd = ((this.peakEquity - this.stats.equity) / this.peakEquity) * 100;
    if (dd > this.stats.maxDrawdownPercent) {
      this.stats.maxDrawdownPercent = Number(dd.toFixed(2));
    }
  }

  public resetToDefaultState(): void {
    this.positions = [];
    this.history = [];
    this.peakEquity = this.settings.initialBalance;
    this.stats = {
      balance: this.settings.initialBalance,
      startBalance: this.settings.initialBalance,
      equity: this.settings.initialBalance,
      equityChangePercent: 0,
      closedNetPnl: 0,
      totalCommissions: 0,
      totalTrades: 0,
      winTrades: 0,
      lossTrades: 0,
      winRate: 0,
      profitFactor: null,
      grossProfit: 0,
      grossLoss: 0,
      maxDrawdownPercent: 0,
      openPositionsCount: 0,
      maxPositionsCount: this.settings.maxPositions,
      unrealizedPnl: 0,
      lastRunUtc: this.formatUtcDate(new Date()),
      screenerChannelStatus: 'Підключено (h00k.top)',
      isH00kOnline: true,
      h00kLatencyMs: 38,
      vpsPlanReceived: true,
    };
    this.addLog('INFO', 'Стан бота скинуто до початкових 1 000.00 USDT');
    this.notify();
  }

  public exportHistoryCsv(): void {
    if (this.history.length === 0) {
      this.addLog('WARN', 'Історія угод порожня. Немає даних для CSV.');
      return;
    }

    const headers = ['ID', 'Інструмент', 'Формація', 'Напрямок', 'Вхід', 'Вихід', 'Кількість', 'Стоп-лос', 'Тейк-профіт', 'Результат', 'Чистий PnL', 'Комісія', 'Тривалість (сек)', 'Відкрито UTC', 'Закрито UTC', 'Реверс', 'Швидкий скальп 5хв'];
    const rows = this.history.map(t => [
      t.id,
      t.symbol,
      `"${t.formation}"`,
      t.direction,
      t.entryPrice,
      t.exitPrice,
      t.quantity,
      t.stopLoss,
      t.takeProfit,
      t.result,
      t.netPnl,
      t.fee,
      t.durationSeconds || 0,
      `"${t.openedAt}"`,
      `"${t.closedAt}"`,
      t.isReversed ? 'Так' : 'Ні',
      t.isQuickScalp5m ? 'Так' : 'Ні'
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `autoscalp_trades_${this.settings.timeframe}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.addLog('INFO', `Експортовано ${this.history.length} угод у CSV файл.`);
  }
}

export const tradingEngine = new TradingEngineService();
