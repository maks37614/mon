import type { Exchange, Candle } from './config';

// Read-only chart data for symbols already present in the user's Paper book.
// NEVER use these candles for LIVE Ev-Test signals, density checks or execution.
// Historical read-only candle research/backtesting may call this adapter, with
// clear limitations: OHLC cannot reconstruct historical order-book liquidity.
export async function fetchTradeChartCandles(
  exchange: Exchange, symbol: string, timeframe: string, limit: number,
  endTime?: number, fetcher: typeof fetch = fetch,
): Promise<Candle[]> {
  if (!['binance', 'bybit'].includes(exchange) ||
    !/^[A-Z0-9]{3,40}$/.test(symbol) ||
    !['1m', '5m'].includes(timeframe) ||
    !Number.isInteger(limit) || limit < 30 || limit > 500 ||
    (endTime !== undefined && (!Number.isSafeInteger(endTime) || endTime <= 0 || endTime > Date.now())))
    throw new Error('Unsupported read-only trade chart request');

  const interval = timeframe === '1m' ? 60_000 : 300_000;
  const url = exchange === 'binance'
    ? new URL('https://fapi.binance.com/fapi/v1/klines')
    : new URL('https://api.bybit.com/v5/market/kline');
  const params = exchange === 'binance'
    ? { symbol, interval: timeframe, limit: String(limit), ...(endTime ? { endTime: String(endTime) } : {}) }
    : { category: 'linear', symbol, interval: timeframe === '1m' ? '1' : '5',
        limit: String(limit), ...(endTime ? { end: String(endTime) } : {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetcher(url, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('json'))
    throw new Error('Official exchange chart candles unavailable');
  let raw: any;
  try { raw = await response.json(); } catch { throw new Error('Invalid exchange chart JSON'); }
  const rows = exchange === 'binance' ? raw : raw?.retCode === 0 ? raw?.result?.list : null;
  if (!Array.isArray(rows)) throw new Error('Invalid exchange chart payload');

  const now = Date.now();
  const candles: Candle[] = rows.map((k: any): Candle => ({
    time: Number(k?.[0]),
    open: Number(k?.[1]),
    high: Number(k?.[2]),
    low: Number(k?.[3]),
    close: Number(k?.[4]),
    volume: Number(k?.[5]),
  })).filter((k: Candle) =>
    Number.isSafeInteger(k.time) && k.time > 0 &&
    k.time + interval <= now &&
    (endTime === undefined || k.time + interval <= endTime + interval) &&
    [k.open, k.high, k.low, k.close, k.volume].every(Number.isFinite) &&
    k.open > 0 && k.close > 0 && k.low > 0 &&
    k.high >= Math.max(k.open, k.close, k.low) &&
    k.low <= Math.min(k.open, k.close) && k.volume >= 0
  ).sort((a: Candle,b: Candle) => a.time-b.time);
  if (candles.length < 30 || candles.length > limit ||
    candles.some((k, i) => i > 0 && k.time - candles[i-1].time !== interval))
    throw new Error('Official exchange chart has insufficient or noncontiguous closed candles');
  if (endTime === undefined &&
    now - (candles[candles.length-1].time + interval) > interval + 30_000)
    throw new Error('Official exchange chart candles are stale');
  return candles;
}
