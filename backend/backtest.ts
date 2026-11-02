import type { Candle, Exchange } from './config';
import { detectEdwinSetups, type EdwinSettings, type EdwinSignal } from './edwinStrategy';
import { fetchTradeChartCandles } from './tradeChartCandles';

export type BacktestInput = {
  exchange: Exchange;
  symbol: string;
  timeframe: '1m' | '5m';
  bars: 500 | 1000 | 1500;
  startingBalance: number;
  notional: number;
  feeBps: number;
  slippageBps: number;
};

export type BacktestTrade = {
  signalId: string; formation: string; direction: 'LONG' | 'SHORT';
  entryAt: number; exitAt: number; entryPrice: number; exitPrice: number;
  stopLoss: number; takeProfit: number; fee: number; grossPnl: number;
  netPnl: number; reason: 'TP' | 'SL' | 'TIME' | 'END';
  balance: number;
};

export function validateBacktestInput(input: any): BacktestInput {
  if (!input || typeof input !== 'object') throw new Error('Некоректні параметри бектесту');
  const symbol = String(input.symbol || '').toUpperCase().trim();
  const exchange = input.exchange;
  const timeframe = input.timeframe;
  const bars = Number(input.bars ?? 500);
  const startingBalance = Number(input.startingBalance ?? 1000);
  const notional = Number(input.notional ?? 100);
  const feeBps = Number(input.feeBps ?? 5);
  const slippageBps = Number(input.slippageBps ?? 2);
  if (!['binance','bybit'].includes(exchange) || !/^[A-Z0-9]{3,30}USDT$/.test(symbol) ||
      !['1m','5m'].includes(timeframe) || ![500,1000,1500].includes(bars) ||
      !Number.isFinite(startingBalance) || startingBalance < 100 || startingBalance > 100_000 ||
      !Number.isFinite(notional) || notional < 10 || notional > startingBalance ||
      !Number.isFinite(feeBps) || feeBps < 0 || feeBps > 30 ||
      !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 50)
    throw new Error('Некоректна біржа, монета, таймфрейм або ліміти бектесту');
  return { exchange, symbol, timeframe, bars: bars as BacktestInput['bars'],
    startingBalance, notional, feeBps, slippageBps };
}

/** Actual closed OHLC from a tracked instrument, with bounded, backwards-only paging.
 * Never feeds this data to the live/paper trading engine.
 */
export async function loadBacktestCandles(input: BacktestInput, fetcher: typeof fetch = fetch): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < input.bars) {
    const page = await fetchTradeChartCandles(
      input.exchange, input.symbol, input.timeframe, 500, endTime, fetcher);
    if (!page.length) throw new Error('Біржа не повернула історичні свічки');
    all.unshift(...page);
    endTime = page[0].time - 1;
    if (all.length > input.bars + 500) throw new Error('Забагато даних бектесту');
  }
  const rows = all.slice(-input.bars);
  const tfMs = input.timeframe === '1m' ? 60_000 : 300_000;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].time - rows[i - 1].time !== tfMs)
      throw new Error('Історія біржі має пропуски. Бектест не запускається.');
  }
  return rows;
}

/** Retrospective CANDLE-ONLY approximation. Not an Ev-Test paper replay:
 * historical formation eligibility and real orderbook walls are unavailable.
 * Decisions use only closed bars, next-bar open for entry, and pessimistic
 * stop-priority when TP and SL coexist inside an OHLC candle.
 */
export function runCandleBacktest(
  rows: Candle[], input: BacktestInput, strategy: EdwinSettings,
) {
  const tfMs = input.timeframe === '1m' ? 60_000 : 300_000;
  if (rows.length !== input.bars || rows.length < 120 ||
    rows.some((bar, i) => !Number.isSafeInteger(bar.time) ||
      [bar.open,bar.high,bar.low,bar.close,bar.volume].some(x => !Number.isFinite(x)) ||
      bar.low <= 0 || bar.high < Math.max(bar.open,bar.close,bar.low) ||
      (i && bar.time - rows[i-1].time !== tfMs)))
    throw new Error('Бектест потребує справжніх послідовних закритих свічок');

  let balance = input.startingBalance;
  let maxEquity = balance, maxDrawdownPercent = 0;
  let signals = 0, skipped = 0;
  const trades: BacktestTrade[] = [];
  const equity: {at:number;balance:number}[] = [{at:rows[0].time,balance}];
  type Active = {
    signal: EdwinSignal; entryAt: number; entryPrice: number;
    qty: number; entryFee: number; startIndex: number;
  };
  let active: Active | null = null;
  const slip = input.slippageBps / 10_000;
  const feeRate = input.feeBps / 10_000;
  const adverse = (price:number, direction:'LONG'|'SHORT', action:'entry'|'exit') =>
    price * (1 + (direction === 'LONG' ? (action === 'entry' ? 1 : -1)
      : (action === 'entry' ? -1 : 1)) * slip);
  const close = (at: number, px: number, reason: BacktestTrade['reason']) => {
    if (!active) return;
    const a = active;
    const direction = a.signal.direction;
    const exitPrice = adverse(px, direction, 'exit');
    const grossPnl = a.qty * (exitPrice - a.entryPrice) * (direction === 'LONG' ? 1 : -1);
    const fee = a.entryFee + Math.abs(a.qty * exitPrice) * feeRate;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({
      signalId:a.signal.id, formation:a.signal.pattern, direction, entryAt:a.entryAt,exitAt:at,
      entryPrice:a.entryPrice,exitPrice,stopLoss:a.signal.stopLoss,
      takeProfit:a.signal.takeProfit,fee,grossPnl,netPnl,reason,balance,
    });
    maxEquity = Math.max(maxEquity,balance);
    maxDrawdownPercent = Math.max(maxDrawdownPercent,
      maxEquity > 0 ? (maxEquity-balance)/maxEquity*100 : 0);
    equity.push({at,balance});
    active = null;
  };

  // Begin after enough bars to initialize all detector windows.
  for (let i = 120; i < rows.length; i++) {
    const bar = rows[i];
    if (active) {
      const a = active;
      const dir = a.signal.direction;
      const sl = a.signal.stopLoss, tp = a.signal.takeProfit;
      // Apply a worse opening price on a gap through SL/TP; don't assume a
      // profit fill at the TP when opening beyond the target.
      const stopOpen = dir === 'LONG' ? bar.open <= sl : bar.open >= sl;
      if (stopOpen) close(bar.time, bar.open, 'SL');
      else {
        const stopHit = dir === 'LONG' ? bar.low <= sl : bar.high >= sl;
        const takeHit = dir === 'LONG' ? bar.high >= tp : bar.low <= tp;
        if (stopHit) close(bar.time + tfMs, sl, 'SL');
        else if (takeHit) close(bar.time + tfMs, tp, 'TP');
        else if (bar.time + tfMs - a.entryAt >= strategy.maxHoldMinutes * 60_000)
          close(bar.time + tfMs, bar.close, 'TIME');
      }
    }

    if (active || i === rows.length - 1) continue;
    // At bar i, ONLY data through closed bar i-1 is visible.
    const prior = rows.slice(0,i);
    const found = detectEdwinSetups(input.exchange,input.symbol,
      input.timeframe === '1m' ? prior : [],
      input.timeframe === '5m' ? prior : [],
      strategy).filter(x => x.timeframe === input.timeframe);
    if (!found.length) continue;
    signals += found.length;
    const signal = found[0]; // deterministic single-position execution
    const entryPrice = adverse(bar.open,signal.direction,'entry');
    // Gap beyond either strategy level means the signal is no longer valid.
    const valid = signal.direction === 'LONG'
      ? entryPrice > signal.stopLoss && entryPrice < signal.takeProfit
      : entryPrice < signal.stopLoss && entryPrice > signal.takeProfit;
    if (!valid || balance <= 0) { skipped++; continue; }
    const qty = input.notional / entryPrice;
    active = {
      signal, entryAt:bar.time, entryPrice, qty,
      entryFee: input.notional * feeRate, startIndex:i,
    };
    // Model SL/TP during the very first candle, including ambiguous-stop-first.
    const stopHit = signal.direction === 'LONG' ? bar.low <= signal.stopLoss : bar.high >= signal.stopLoss;
    const takeHit = signal.direction === 'LONG' ? bar.high >= signal.takeProfit : bar.low <= signal.takeProfit;
    if (stopHit) close(bar.time + tfMs, signal.stopLoss, 'SL');
    else if (takeHit) close(bar.time + tfMs, signal.takeProfit, 'TP');
  }
  if (active) close(rows.at(-1)!.time + tfMs, rows.at(-1)!.close, 'END');
  const winners = trades.filter(x=>x.netPnl>0).length;
  return {
    model:'CANDLE_ONLY_INDICATIVE' as const,
    disclaimer:'Індикативний свічковий бектест Ev-Test. Без архіву реальних щільностей h00k.top, відбору формацій, фактичного spread/VWAP, funding, маржі, ліквідації та затримки виконання. Не є відтворенням Paper-торгівлі і не гарантує реальних входів.',
    input, period:{from:rows[0].time,to:rows.at(-1)!.time+tfMs},
    candles:rows.length, signals, skipped,
    summary:{
      trades:trades.length, winners, losers:trades.length-winners,
      winRatePercent: trades.length ? winners/trades.length*100 : 0,
      startBalance:input.startingBalance, endBalance:balance,
      netPnl:balance-input.startingBalance, returnPercent:(balance/input.startingBalance-1)*100,
      maxDrawdownPercent,
      grossProfit:trades.filter(t=>t.netPnl>0).reduce((a,b)=>a+b.netPnl,0),
      grossLoss:trades.filter(t=>t.netPnl<0).reduce((a,b)=>a+b.netPnl,0),
    }, equity, trades,
  };
}
