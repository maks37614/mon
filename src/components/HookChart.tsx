import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  RefreshCw,
  Maximize2,
  Minimize2,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  Layers,
  Crosshair,
  TrendingUp,
  Minus,
  Ruler,
  Eraser,
} from 'lucide-react';
import { Timeframe } from '../types/trading';
import { HookChartCanvas, Candle } from './HookChartCanvas';

export interface HookChartProps {
  symbol: string;
  exchange?: 'binance' | 'bybit';
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  currentPrice?: number;
  direction?: 'LONG' | 'SHORT';
  formationName?: string;
  isQuickScalp5m?: boolean;
  expiresAtTimestamp?: number;
  height?: number;
  initialTimeframe?: Timeframe;
  compact?: boolean;
}

// Candle close countdown calculation copied directly from h00k.top Wj(e)
function getCandleCountdown(tf: string) {
  const t = Date.now();
  let n = 60000;
  switch (tf) {
    case '1m': n = 60000; break;
    case '5m': n = 300000; break;
    case '15m': n = 900000; break;
    case '30m': n = 1800000; break;
    case '1h': n = 3600000; break;
    case '4h': n = 14400000; break;
    case '1d': n = 86400000; break;
    default: n = 60000;
  }
  const r = Math.ceil(t / n) * n;
  const diff = Math.max(0, r - t);
  const totalSec = Math.floor(diff / 1000);
  const m = Math.floor((totalSec % 3600) / 60);
  const h = Math.floor(totalSec / 3600);
  const s = totalSec % 60;
  const isUrgent = totalSec <= (tf === '1m' ? 15 : tf === '5m' ? 30 : 45);
  return {
    formatted: `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`,
    totalSec,
    isUrgent,
  };
}

export const HookChart: React.FC<HookChartProps> = ({
  symbol,
  exchange = 'binance',
  entryPrice,
  stopLoss,
  takeProfit,
  currentPrice: initialCurrentPrice,
  direction = 'LONG',
  formationName,
  isQuickScalp5m,
  expiresAtTimestamp,
  height = 360,
  initialTimeframe = '1m',
  compact = false,
}) => {
  // Chart Engine Provider: 'hookchart' (native Canvas engine from h00k.top) or 'tradingview' (real embed)
  const [provider, setProvider] = useState<'hookchart' | 'tradingview'>('hookchart');
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [livePrice, setLivePrice] = useState<number>(initialCurrentPrice || entryPrice || 0);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [activeTool, setActiveTool] = useState<string>('cursor');

  const isDisposedRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 24h Stats
  const [stats24h, setStats24h] = useState<{ high: number; low: number; volume: number }>({
    high: 0,
    low: 0,
    volume: 0,
  });

  // Countdown timer for current candle
  const [candleCountdown, setCandleCountdown] = useState(getCandleCountdown(timeframe));

  // 5-minute quick scalp remaining seconds
  const [remainingTimeSec, setRemainingTimeSec] = useState<number | null>(null);

  useEffect(() => {
    isDisposedRef.current = false;
    return () => {
      isDisposedRef.current = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCandleCountdown(getCandleCountdown(timeframe));
      if (isQuickScalp5m && expiresAtTimestamp) {
        setRemainingTimeSec(Math.max(0, Math.round((expiresAtTimestamp - Date.now()) / 1000)));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [timeframe, isQuickScalp5m, expiresAtTimestamp]);

  // Fetch real klines from backend
  const fetchKlines = useCallback(async () => {
    if (isDisposedRef.current) return;
    try {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const res = await fetch(
        `/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=300`,
        { signal: controller.signal }
      );

      if (isDisposedRef.current) return;

      if (res.ok) {
        const raw = await res.json();
        if (isDisposedRef.current) return;

        if (Array.isArray(raw) && raw.length > 0) {
          const formattedCandles: Candle[] = raw.map((k: any) => ({
            t: k.time,
            o: k.open,
            h: k.high,
            l: k.low,
            c: k.close,
            v: k.volume,
            n: 0,
          }));

          setCandles(formattedCandles);

          const latest = formattedCandles[formattedCandles.length - 1];
          setLivePrice(latest.c);

          const highs = formattedCandles.map((k) => k.h);
          const lows = formattedCandles.map((k) => k.l);
          const totalVol = formattedCandles.reduce((sum, k) => sum + k.v, 0);
          setStats24h({
            high: Math.max(...highs),
            low: Math.min(...lows),
            volume: Math.round(totalVol),
          });
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError' && !isDisposedRef.current) {
        console.error('Failed to load klines for HookChart:', err);
      }
    } finally {
      if (!isDisposedRef.current) {
        setIsLoading(false);
      }
    }
  }, [symbol, timeframe, exchange]);

  // Initial fetch on symbol / timeframe change
  useEffect(() => {
    setIsLoading(true);
    fetchKlines();
  }, [fetchKlines]);

  // Periodic klines refresh every 3 seconds
  useEffect(() => {
    if (provider !== 'hookchart') return;
    const interval = setInterval(() => {
      if (!isDisposedRef.current) {
        fetchKlines();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [provider, fetchKlines]);

  // TradingView widget URL
  const tvInterval = ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' } as const)[timeframe];
  const tvSymbol = `${exchange === 'bybit' ? 'BYBIT' : 'BINANCE'}:${symbol.toUpperCase()}.P`;
  const tvWidgetUrl = `https://s.tradingview.com/widgetembed/?${new URLSearchParams({
    symbol: tvSymbol,
    interval: tvInterval,
    theme: 'dark',
    style: '1',
    timezone: 'exchange',
    withdateranges: '0',
    hide_top_toolbar: '0',
    hide_side_toolbar: '0',
    allow_symbol_change: '0',
    save_image: '0',
    hide_legend: '0',
    locale: 'uk',
    toolbar_bg: '#090d16',
    gridColor: 'rgba(30,41,59,0.3)',
    gridTransparency: '100',
  }).toString()}`;

  // Profit/Loss calculation
  const pnlPercent =
    entryPrice && livePrice
      ? ((direction === 'LONG' ? livePrice - entryPrice : entryPrice - livePrice) /
          entryPrice) *
        100
      : 0;
  const isProfit = pnlPercent >= 0;

  return (
    <div
      className={`rounded-xl border border-slate-800 bg-[#090d16] overflow-hidden flex flex-col font-sans transition-all ${
        isExpanded ? 'fixed inset-3 z-50 shadow-2xl border-cyan-500/50 bg-[#090d16]' : ''
      }`}
      style={{ height: isExpanded ? 'calc(100vh - 24px)' : `${height}px` }}
    >
      {/* Top Header Controls Toolbar */}
      <div className="px-3 py-1.5 bg-[#0e1319] border-b border-slate-800/90 flex flex-wrap items-center justify-between gap-2 text-xs select-none">
        <div className="flex items-center gap-2">
          {/* Symbol & Direction Badge */}
          <div className="font-mono font-bold text-slate-100 flex items-center gap-1.5">
            <span className="text-sm">{symbol}</span>
            {direction && (
              <span
                className={`text-[11px] font-bold flex items-center ${
                  direction === 'LONG' ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {direction === 'LONG' ? (
                  <ArrowUpRight className="w-3.5 h-3.5" />
                ) : (
                  <ArrowDownRight className="w-3.5 h-3.5" />
                )}
                {direction}
              </span>
            )}
          </div>

          {/* Formation name */}
          {formationName && (
            <span className="text-slate-400 text-[11px] hidden md:inline truncate max-w-[150px]">
              {formationName}
            </span>
          )}

          {/* Quick Scalp 5m Timer Badge */}
          {isQuickScalp5m && (
            <div className="flex items-center gap-1 text-[11px] font-mono text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-700/50">
              <Zap className="w-3 h-3 fill-cyan-400" />
              <span>&le;5м</span>
              {remainingTimeSec !== null && (
                <span
                  className={`font-bold ml-0.5 ${
                    remainingTimeSec < 60
                      ? 'text-rose-400 animate-pulse'
                      : 'text-cyan-300'
                  }`}
                >
                  {Math.floor(remainingTimeSec / 60)
                    .toString()
                    .padStart(2, '0')}
                  :{(remainingTimeSec % 60).toString().padStart(2, '0')}
                </span>
              )}
            </div>
          )}

          {/* Candle close countdown from h00k.top */}
          <div className="hidden sm:flex items-center gap-1 text-[11px] font-mono text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
            <span>Свічка:</span>
            <span
              className={`font-bold ${
                candleCountdown.isUrgent ? 'text-amber-400' : 'text-slate-200'
              }`}
            >
              {candleCountdown.formatted}
            </span>
          </div>
        </div>

        {/* Center / Right: Engine Switcher, Drawing Tools, TF, Controls */}
        <div className="flex items-center gap-2">
          {/* Quick Drawing Tools (HookChart Canvas native) */}
          {provider === 'hookchart' && (
            <div className="hidden lg:flex items-center gap-0.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[10px]">
              <button
                onClick={() => setActiveTool('cursor')}
                className={`p-1 rounded cursor-pointer ${
                  activeTool === 'cursor'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Курсор / Переміщення"
              >
                <Crosshair className="w-3 h-3" />
              </button>
              <button
                onClick={() => setActiveTool('trend')}
                className={`p-1 rounded cursor-pointer ${
                  activeTool === 'trend'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Лінія тренду"
              >
                <TrendingUp className="w-3 h-3" />
              </button>
              <button
                onClick={() => setActiveTool('level')}
                className={`p-1 rounded cursor-pointer ${
                  activeTool === 'level'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Горизонтальний рівень"
              >
                <Minus className="w-3 h-3" />
              </button>
              <button
                onClick={() => setActiveTool('ruler')}
                className={`p-1 rounded cursor-pointer ${
                  activeTool === 'ruler'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Лінійка (% дистанція)"
              >
                <Ruler className="w-3 h-3" />
              </button>
              <button
                onClick={() => setActiveTool('erase')}
                className={`p-1 rounded cursor-pointer ${
                  activeTool === 'erase'
                    ? 'bg-rose-950 text-rose-300'
                    : 'text-slate-400 hover:text-rose-300'
                }`}
                title="Стерти фігуру"
              >
                <Eraser className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Engine Mode Toggle (HookChart vs TradingView as on h00k.top) */}
          <div className="flex items-center gap-0.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[10px] font-mono">
            <button
              onClick={() => setProvider('hookchart')}
              className={`px-2 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer ${
                provider === 'hookchart'
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/50 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Оригінальний Canvas-графік h00k.top"
            >
              <Layers className="w-3 h-3 text-cyan-400" />
              <span>HookChart</span>
            </button>
            <button
              onClick={() => setProvider('tradingview')}
              className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                provider === 'tradingview'
                  ? 'bg-slate-800 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="TradingView Pro віджет"
            >
              <span>TradingView</span>
            </button>
          </div>

          {/* Timeframe Switcher */}
          <div className="flex items-center gap-0.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[10px] font-mono">
            {(['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                  timeframe === tf
                    ? 'bg-cyan-600 text-white font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Live P&L badge */}
          {entryPrice && (
            <div className="text-[11px] font-mono flex items-center gap-1 font-semibold pl-1">
              <span className={isProfit ? 'text-emerald-400' : 'text-rose-400'}>
                {isProfit ? '+' : ''}
                {pnlPercent.toFixed(2)}%
              </span>
            </div>
          )}

          {/* Expand / Minimize */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
            title={isExpanded ? 'Згорнути' : 'Розгорнути на весь екран'}
          >
            {isExpanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Main Chart Canvas Stage */}
      <div className="flex-1 relative w-full h-full min-h-[180px] bg-[#131722]">
        {provider === 'hookchart' ? (
          <>
            {isLoading && !candles.length && (
              <div className="absolute inset-0 z-20 flex items-center justify-center text-xs font-mono text-slate-400 gap-2 bg-[#131722]/90 backdrop-blur-xs">
                <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                <span>Завантаження HookChart ({symbol})...</span>
              </div>
            )}

            <HookChartCanvas
              candles={candles}
              symbol={symbol}
              tf={timeframe}
              entryPrice={entryPrice}
              takeProfit={takeProfit}
              stopLoss={stopLoss}
              direction={direction}
              formationName={formationName}
              tool={activeTool}
              showVolumes={true}
              candleLongColor="#0ECB81"
              candleShortColor="#F6465D"
            />
          </>
        ) : (
          /* TradingView Embed Widget */
          <iframe
            src={tvWidgetUrl}
            title={`TradingView-${symbol}`}
            className="w-full h-full border-0"
            allow="fullscreen"
          />
        )}
      </div>

      {/* Market Stats Bar copied verbatim from h00k.top */}
      {!compact && (
        <div className="px-3 py-1 bg-[#0e1319] border-t border-slate-800/80 flex flex-wrap items-center justify-between text-[10px] font-mono text-slate-400">
          <div className="flex items-center gap-2.5">
            <span>
              Джерело: <b className="text-slate-200">h00k.top / Binance Futures</b>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Max 24h:{' '}
              <b className="text-emerald-400">
                {stats24h.high
                  ? stats24h.high < 10
                    ? stats24h.high.toFixed(4)
                    : stats24h.high.toFixed(2)
                  : '—'}
              </b>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Min 24h:{' '}
              <b className="text-rose-400">
                {stats24h.low
                  ? stats24h.low < 10
                    ? stats24h.low.toFixed(4)
                    : stats24h.low.toFixed(2)
                  : '—'}
              </b>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Vol 24h:{' '}
              <b className="text-slate-300">
                {stats24h.volume.toLocaleString()}
              </b>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {stopLoss && (
              <span className="text-rose-400 font-semibold">SL: {stopLoss}</span>
            )}
            {entryPrice && (
              <span className="text-cyan-400 font-semibold">Вхід: {entryPrice}</span>
            )}
            {takeProfit && (
              <span className="text-emerald-400 font-semibold">TP: {takeProfit}</span>
            )}
            <a
              href="https://h00k.top"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 ml-1"
            >
              <span>h00k.top</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
};
