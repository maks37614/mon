import test from 'node:test';
import assert from 'node:assert/strict';
import { HookMarketClient, HookFormationSource, HookMarketData } from '../backend/hookMarketFeed';
import { Store } from '../backend/store';
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION } from '../backend/config';
import { EDWIN_DEFAULTS } from '../backend/edwinStrategy';
import { StrategyBuilderScanner } from '../backend/strategyBuilder';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOKEN = 's'.repeat(48);
function makeFeed(now: number, override: Record<string,unknown> = {}) {
  return {
    version:1, success:true, generatedAt:now,
    snapshots:[{ key:'all_futures_1m_100000', generatedAt:now,
      data:[{ symbol:'BTCUSDT', exchange:'binance',marketType:'futures',timeframe:'1m',
        formationData:{ collectedAt:now-1000,lastClosedAt:now-60000,contiguous:true },
        formations:[{ id:'verified-1',nameEn:'Double Bottom',confidence:84,
          validation:{enoughData:true,finiteData:true}}] }] }],
    market:{quotes:[{exchange:'binance',marketType:'futures',symbol:'BTCUSDT',
      price:70000,updatedAt:now}]},
    density:[{ instrument:'binance:futures:BTCUSDT',source:'exchange-websocket',sampledAt:now,
      book:{status:'LIVE',dataValid:true,sequenceGap:false,lastReceivedAt:now,
        timestamp:now,bestBid:69999,bestAsk:70001,
        bids:[{price:69999,quantity:20}], asks:[{price:70001,quantity:20}]},
      densities:[{side:'BID',price:70000,notionalUsd:1400000,
        ageSeconds:30,classification:'PERSISTENT_LIQUIDITY',qualityScore:80}] }],
    ...override,
  };
}
function client(response: () => any) {
  const fakeFetch = (async () => new Response(JSON.stringify(response()), {
    status:200,headers:{'content-type':'application/json'},
  })) as typeof fetch;
  return new HookMarketClient('https://h00k.top', TOKEN, fakeFetch);
}

test('formation source only imports verified eligible symbols; no fabricated legacy entry', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'hook-krystian-test-'));
  const store=new Store(dir);
  try {
    const hook=client(()=>makeFeed(Date.now()));
    const source=new HookFormationSource(store,hook);
    await source.sync();
    const signals=store.get<any[]>('signals',[]);
    assert.equal(signals.length,1);
    assert.match(signals[0].id,/^hook:/);
    assert.equal(signals[0].status,'watching');
    assert.equal(signals[0].entryPrice,0);
    assert.equal(signals[0].formation,'Double Bottom');
    assert.equal(store.get<any>('hook:source',{}).connected,true);
  } finally {store.close(); rmSync(dir,{recursive:true,force:true});}
});

test('orderbook and persistent density evidence must be live and fresh',async()=>{
  const now=Date.now();
  const h=client(()=>makeFeed(now));
  assert.equal(await h.verifiedDensity('binance','BTCUSDT','BID',70000),true);
  assert.equal(await h.verifiedDensity('binance','BTCUSDT','ASK',70000),false);
  const bad=client(()=>makeFeed(Date.now(),{
    density:[{...makeFeed(Date.now()).density[0],
      book:{...makeFeed(Date.now()).density[0].book,status:'STALE',dataValid:false}}]
  }));
  await assert.rejects(bad.book('binance','BTCUSDT'),/No fresh synchronized/);
});

test('hook candle adapter rejects missing, gaps and incompatible contract',async()=>{
  const now=Date.now();
  const candles=Array.from({length:60},(_,i)=>({
    time:Math.floor(now/60000)*60-60*60+i*60,
    open:1,high:1.1,low:0.9,close:1,volume:10,
  }));
  const h=client(()=>({
    version:1,success:true,marketType:'futures',exchange:'binance',symbol:'BTCUSDT',
    timeframe:'1m',collectedAt:Date.now(),lastClosedAt:(candles[candles.length-1].time+60)*1000,
    contiguous:true,candles,
  }));
  const md=new HookMarketData(()=>DEFAULT_SETTINGS,h);
  const got=await md.getCandles('binance','BTCUSDT','1m',60,true);
  assert.equal(got.length,60);
  assert.equal(got[0].time,candles[0].time*1000);
  await assert.rejects(md.getCandles('binance','BTCUSDT','1h',60,true),/Unsupported/);
  const corrupt=client(()=>({
    version:1,success:true,marketType:'futures',exchange:'binance',symbol:'BTCUSDT',
    timeframe:'1m',collectedAt:Date.now(),lastClosedAt:(candles[candles.length-1].time+60)*1000,
    contiguous:true,candles:[...candles.slice(0,30),...candles.slice(31)],
  }));
  await assert.rejects(corrupt.candles('binance','BTCUSDT','1m',60),/gaps/);
});

test('live book universe excludes untracked or stale formation symbols', async () => {
  const now = Date.now();
  const baseline = makeFeed(now);
  const stale = {
    ...baseline.density[0], instrument:'binance:futures:LITUSDT',
    book:{...baseline.density[0].book, lastReceivedAt: now-10_000},
  };
  const otherExchange = {
    ...baseline.density[0], instrument:'bybit:futures:SOLUSDT',
  };
  const h = client(() => makeFeed(now, {
    density:[baseline.density[0],stale,otherExchange],
  }));
  const live = await h.liveBookSymbols('binance');
  assert.deepEqual([...live],['BTCUSDT']);
  await assert.rejects(h.book('binance','LITUSDT'),/No fresh synchronized/);
});

test('Ev-Test skips LITUSDT without live h00k depth before any candle requests', async () => {
  const dir = mkdtempSync(path.join(tmpdir(),'hook-scan-'));
  const store = new Store(dir);
  try {
    const now = Date.now();
    const h = client(() => makeFeed(now));
    const market = new HookMarketData(() => DEFAULT_SETTINGS, h);
    let candleRequests = 0;
    market.getCandles = async () => { candleRequests++; throw new Error('Unexpected candles request'); };
    store.set('signals',[{
      id: 'hook:binance:LITUSDT:1m:form1', exchange:'binance',symbol:'LITUSDT',
      timeframe:'1m',formation:'Double Bottom',direction:'LONG',
      entryPrice:0,currentPrice:0,stopLoss:0,takeProfit:0,
      confidence:85,analysisVersion:FORMATION_ANALYSIS_VERSION,status:'watching',
      candleAt:now-1000,detectedAt:now-1000,description:'source-only',
    }]);
    store.set('builder:edwin:config',{ ...EDWIN_DEFAULTS, enabled:true });
    const scanner = new StrategyBuilderScanner(store,market,()=> 'binance');
    assert.equal(scanner.start(true).accepted,true);
    await scanner.task;
    const status = store.get<any>('builder:edwin:status',{});
    assert.equal(status.formationSymbols,1);
    assert.equal(status.withoutLiveBook,1);
    assert.equal(status.total,0);
    assert.equal(status.failed,0);
    assert.equal(candleRequests,0);
    assert.deepEqual(store.get('builder:edwin:signals',[]),[]);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
