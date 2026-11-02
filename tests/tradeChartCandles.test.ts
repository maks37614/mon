import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTradeChartCandles } from '../backend/tradeChartCandles';

const minute = 60_000;
const fetchStub = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
function binanceBars(n: number, interval = minute) {
  const lastOpen = Math.floor(Date.now() / interval) * interval - interval;
  return Array.from({length:n}, (_,i) => {
    const t = lastOpen - (n-i-1)*interval;
    return [t,'100','110','90','102','123', t+interval-1];
  });
}

test('display-only Binance futures chart returns actual normalized closed candles', async () => {
  const candles = await fetchTradeChartCandles('binance','BTCUSDT','1m',60,
    undefined, fetchStub(binanceBars(60)));
  assert.equal(candles.length,60);
  assert.equal(candles[0].open,100);
  assert.equal(candles[0].close,102);
  assert.equal(candles[0].high,110);
  assert.equal(candles[0].low,90);
  assert.equal(candles[0].volume,123);
  assert.equal(candles[59].time - candles[58].time,minute);
});

test('Bybit futures reversed real candles are sorted and normalized',async()=>{
  const rows=binanceBars(60,5*minute).reverse().map(b=>b.map(String));
  let requested: URL | undefined;
  const fetcher = (async (url: URL) => {
    requested=new URL(String(url));
    return Response.json({retCode:0,result:{list:rows}});
  }) as typeof fetch;
  const candles=await fetchTradeChartCandles('bybit','ETHUSDT','5m',60,
    undefined,fetcher);
  assert.equal(candles.length,60);
  assert.equal(candles[0].close,102);
  assert.equal(candles[59].time-candles[58].time,300000);
  assert.equal(requested?.pathname,'/v5/market/kline');
  assert.equal(requested?.searchParams.get('symbol'),'ETHUSDT');
  assert.equal(requested?.searchParams.get('interval'),'5');
});

test('chart-only fallback refuses unsupported symbols, intervals, HTML and gaps',async()=>{
  const good=binanceBars(60);
  await assert.rejects(fetchTradeChartCandles('binance','BTCUSDT','1h',60,
    undefined,fetchStub(good)),/Unsupported/);
  await assert.rejects(fetchTradeChartCandles('binance','BAD/USDT','1m',60,
    undefined,fetchStub(good)),/Unsupported/);
  await assert.rejects(fetchTradeChartCandles('binance','BTCUSDT','1m',60,
    undefined,(async()=>new Response('<!doctype html>',{
      status:200,headers:{'content-type':'text/html'}
    })) as typeof fetch),/unavailable/);
  const gap=[...good.slice(0,20),...good.slice(21)];
  await assert.rejects(fetchTradeChartCandles('binance','BTCUSDT','1m',60,
    undefined,fetchStub(gap)),/noncontiguous/);
});
