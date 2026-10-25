export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h';

export type Direction = 'LONG' | 'SHORT';

export type MarketType = 'futures' | 'spot';

export interface FormationSignal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  formation: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit1?: number;
  currentPrice: number;
  riskRewardRatio: string;
  confidence: number;
  description: string;
  source: string;
  detectedAt: string;
  status: 'pending' | 'near_entry' | 'triggered' | 'closed';
  isQuickScalp5m?: boolean;
}

export interface Position {
  id: string;
  symbol: string;
  formation: string;
  direction: Direction;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  amountUsdt: number;
  stopLoss: number;
  takeProfit: number;
  timeframe: Timeframe;
  marketType: MarketType;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  openedAt: string;
  openedTimestamp: number;
  expiresAtTimestamp?: number;
  status: 'active' | 'closing';
  isReversed?: boolean;
  isQuickScalp5m?: boolean;
}

export interface TradeHistoryItem {
  id: string;
  symbol: string;
  formation: string;
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  result: 'TP' | 'SL' | 'MANUAL' | 'TIME_5M';
  grossPnl: number;
  fee: number;
  netPnl: number;
  pnlPercent: number;
  openedAt: string;
  closedAt: string;
  durationSeconds?: number;
  timeframe: Timeframe;
  marketType: MarketType;
  isReversed?: boolean;
  isQuickScalp5m?: boolean;
}

export interface BotSettings {
  timeframe: Timeframe;
  reverseEnabled: boolean;
  marketType: MarketType;
  maxPositions: number;
  initialBalance: number;
  riskPerTradePercent: number; // e.g. 5% of balance per position
  leverage: number; // e.g. 5x
  slippageTolerancePercent: number; // e.g. 0.20%
  minRiskReward: number; // e.g. 1.8
  takerFeePercent: number; // e.g. 0.04%
  useBreakEvenAt50: boolean;
  h00kUrl: string;
  vpsScreenerTfs: string;
  autoCronIntervalSeconds: number;
  isAutoCronRunning: boolean;
  binanceTestnet: boolean;
  telegramAlerts: boolean;

  // New: 5-minute Quick Scalp mode with tight take and tight stop
  quickScalp5mEnabled: boolean;
  quickTpPercent: number; // e.g. 0.45%
  quickSlPercent: number; // e.g. 0.25%
  quickScalpMaxDurationSeconds: number; // 300 seconds = 5 minutes
}

export interface BotStats {
  balance: number;
  startBalance: number;
  equity: number;
  equityChangePercent: number;
  closedNetPnl: number;
  totalCommissions: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  profitFactor: number | null;
  grossProfit: number;
  grossLoss: number;
  maxDrawdownPercent: number;
  openPositionsCount: number;
  maxPositionsCount: number;
  unrealizedPnl: number;
  lastRunUtc: string;
  screenerChannelStatus: string;
  h00kLatencyMs?: number;
  isH00kOnline?: boolean;
  vpsPlanReceived: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
  details?: string;
}
