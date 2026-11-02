import test from 'node:test';
import assert from 'node:assert/strict';
import { EDWIN_DEFAULTS, type EdwinSignal } from '../backend/edwinStrategy';
import { validateBacktestInput, loadBacktestCandles, runCandleBacktest } from '../backend/backtest';
import type { Candle } from '../backend/config';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BacktestPanel } from '../src/components/BacktestPanel';

const input = validateBacktestInput({
  exchange:'binance',symbol:'BTCUSDT',timeframe:'1m',bars:500,
  startingBalance:1000,notional:100,feeBps:5,slippageBps:2,
});
const ms=60_000;
function fixtures():Candle[] {
  const end=Math.floor(Date.now()/ms)*ms-ms;
  return Array.from({length:500},(_,i)=>({
    time:end-(499-i)*ms,open:100,high:100.1,low:99.9,close:100,volume:30,
  }));
}
function signal(candle:Candle):EdwinSignal{
  return {
    strategyId:'ev-test-v1',id:'fake-test-only',exchange:'binance',symbol:'BTCUSDT',
    timeframe:'1m',zone:2,pattern:'Fixture',
    direction:'LONG',candleAt:candle.time+ms,detectedAt:0,
    entryPrice:100,stopLoss:99.5,takeProfit:102.5,
    positionFraction:1,description:'synthetic test signal never sent to trading',
  };
}
test('backtest UI separates indicative candles from live Paper money',()=>{
  const html=renderToStaticMarkup(React.createElement(BacktestPanel));
  assert.match(html,/Бектест на історичних свічках/);
  assert.match(html,/не повний бектест виконання Ev-Test/);
  assert.match(html,/не впливає на Paper-баланс/);
  assert.match(html,/Запустити бектест/);
});

test('input validation refuses unsupported venue, timeframe, or huge balance',()=>{
  assert.throws(()=>validateBacktestInput({...input,symbol:'BTC/USDT'}),/Некорект/);
  assert.throws(()=>validateBacktestInput({...input,timeframe:'1h'}),/Некорект/);
  assert.throws(()=>validateBacktestInput({...input,bars:20000}),/Некорект/);
  assert.throws(()=>validateBacktestInput({...input,startingBalance:1e12}),/Некорект/);
});

test('historical backtest pages only real, contiguous, closed exchange candles',async()=>{
  const history=fixtures();
  const requests:string[]=[];
  const stub=(async (url:URL)=>{
    const u=new URL(String(url));requests.push(u.toString());
    assert.equal(u.hostname,'fapi.binance.com');
    assert.equal(u.pathname,'/fapi/v1/klines');
    const end=Number(u.searchParams.get('endTime')||Number.MAX_SAFE_INTEGER);
    const rows=history.filter(k=>k.time<=end).slice(-500).map(k=>
      [k.time,''+k.open,''+k.high,''+k.low,''+k.close,''+k.volume]);
    return Response.json(rows);
  }) as typeof fetch;
  const got=await loadBacktestCandles(input,stub);
  assert.equal(got.length,500);
  assert.equal(requests.length,1);
  assert.equal(got.at(-1)?.time,history.at(-1)?.time);
  const longer=await loadBacktestCandles({...input,bars:1000},stub).catch(e=>e);
  assert.ok(longer instanceof Error,'insufficient older exchange history must fail, not invent');
});

test('signals detected at candle close enter at NEXT candle open; ambiguous TP+SL chooses SL',()=>{
  const rows=fixtures();
  rows[120]={...rows[120],high:103,low:99};
  let detected=0;
  const fn = (_e:any,_s:any,fast:Candle[]) => {
    if(fast.length===120){detected++;return [signal(fast.at(-1)!)];}
    return [];
  };
  const result=runCandleBacktest(rows,input,EDWIN_DEFAULTS,fn as any);
  assert.equal(detected,1);
  assert.equal(result.model,'CANDLE_ONLY_INDICATIVE');
  assert.equal(result.summary.trades,1);
  assert.equal(result.summary.winners,0);
  assert.equal(result.trades[0].reason,'SL');
  assert.equal(result.trades[0].entryAt,rows[120].time);
  assert.ok(result.trades[0].entryPrice>rows[120].open,'entry slippage must be adverse');
  assert.ok(result.trades[0].exitPrice<99.5,'exit slippage must be adverse');
  assert.ok(result.trades[0].fee>0,'both entry and exit fees must be counted');
  assert.ok(result.summary.netPnl<0);
});

test('a trade closed within candle does not reenter at same elapsed candle open',()=>{
  const rows=fixtures();
  rows[121]={...rows[121],low:99,high:100.2};
  const inspected:number[]=[];
  const fn = (_e:any,_s:any,fast:Candle[])=>{
    inspected.push(fast.length);
    return fast.length===120 || fast.length===121 ? [signal(fast.at(-1)!)] : [];
  };
  const result=runCandleBacktest(rows,input,EDWIN_DEFAULTS,fn as any);
  assert.equal(result.summary.trades,1);
  assert.ok(!inspected.includes(121),'no decision at the old open of a bar used to close an active trade');
  assert.equal(result.trades[0].reason,'SL');
});

test('no real candle setup produces zero trades rather than a fabricated result',()=>{
  const r=runCandleBacktest(fixtures(),input,EDWIN_DEFAULTS,()=>[]);
  assert.equal(r.summary.trades,0);
  assert.equal(r.summary.netPnl,0);
  assert.equal(r.summary.endBalance,1000);
  assert.equal(r.equity.length,1);
});
