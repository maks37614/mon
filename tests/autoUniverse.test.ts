import test from "node:test";
import assert from "node:assert/strict";
import { SiteUniverse, parseSiteCoins, AUTO_REFRESH_MS } from "../backend/siteUniverse";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../backend/store";
import { Scanner } from "../backend/scanner";
import { Trading } from "../backend/trading";
import { Vault } from "../backend/security";
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION } from "../backend/config";

const NOW = 1_800_000_000_000;
const src = (status = "live", updatedAt = NOW-1000) =>
  ({ exchange:"binance",marketType:"futures",status,updatedAt });
const coin = (symbol:string,volatility:number,extra:Record<string,unknown> = {}) => ({
  symbol, exchange:"binance", marketType:"futures",quoteAsset:"USDT",price:1,
  volumeUsd:5_000_000,volatility24hPct:volatility,isActiveCoin:true,...extra,
});
const response = (data:unknown[]) => ({success:true,partial:false,data,sources:[src()]});

test("h00k adapter selects at most 10 active high-volatility Binance futures",()=>{
  const coins = Array.from({length:16},(_,i)=>coin("COIN"+i+"USDT",i+5));
  coins.push(coin("BTCUSDT",100,{exchange:"bybit"}));
  coins.push(coin("ETHUSDT",110,{isActiveCoin:false}));
  coins.push(coin("SOLUSDT",115,{marketType:"spot"}));
  coins.push(coin("XRPUSDT",1));
  const selected=parseSiteCoins(response(coins),NOW);
  assert.equal(selected.length,10);
  assert.deepEqual(selected,Array.from({length:10},(_,i)=>"COIN"+(15-i)+"USDT"));
});

test("h00k adapter rejects partial, stale, and missing source data",()=>{
  assert.throws(()=>parseSiteCoins({...response([coin("BTCUSDT",6)]),partial:true},NOW));
  assert.throws(()=>parseSiteCoins({...response([coin("BTCUSDT",6)]),sources:[src("stale")]},NOW));
  assert.throws(()=>parseSiteCoins({...response([coin("BTCUSDT",6)]),sources:[src("live",NOW-120000)]},NOW));
});

test("site requests are throttled; failures clear authorization",async()=>{
  let now=NOW, calls=0, fail=false;
  const provider = new SiteUniverse(async (_url:any,_init:any)=>{
    calls++;
    if(fail) return new Response(null,{status:503});
    return Response.json({...response([coin("BTCUSDT",8)]),sources:[src("live",now-1000)]});
  },()=>now);
  assert.deepEqual(await provider.current(),["BTCUSDT"]);
  assert.equal(provider.allows("BTCUSDT"),true);
  now+=120_000;
  assert.deepEqual(await provider.current(),["BTCUSDT"]);
  assert.equal(calls,1);
  now+=AUTO_REFRESH_MS;
  fail=true;
  await assert.rejects(provider.current(),/503/);
  assert.equal(provider.allows("BTCUSDT"),false);
  assert.equal(provider.status().selected.length,0);
  await assert.rejects(provider.current(),/503/);
  assert.equal(calls,2);
});

test("mon scanner only fetches the 10 selected site symbols, not the full exchange",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-auto-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,scanBatchSize:100,timeframes:["1m"]});
  const site=new SiteUniverse(async()=>Response.json(response(
    Array.from({length:12},(_,i)=>coin("COIN"+i+"USDT",20+i))
  )),()=>NOW);
  const calls:string[]=[];
  const market:any={
    getMarkets: async()=>Array.from({length:20},(_,i)=>({symbol:"COIN"+i+"USDT"})),
    getCandles: async(_exchange:string,symbol:string)=>{
      calls.push(symbol);
      return Array.from({length:100},(_,i)=>({time:NOW-(100-i)*60000,open:100,high:101,low:99,close:100,volume:50}));
    },
    status:()=>({}),
  };
  const scanner=new Scanner(store,market,site);
  const started=scanner.start();
  assert.equal(started.accepted,true);
  await scanner.task;
  assert.equal(calls.length,10);
  assert.equal(store.get<any>("scanner",{}).total,10);
  assert.deepEqual(new Set(calls),new Set(Array.from({length:10},(_,i)=>"COIN"+(11-i)+"USDT")));
});

test("mon trader rejects entries for symbols not in current h00k top-ten",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-auto-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,mode:"paper",exchange:"binance"});
  const now=Date.now();
  const site=new SiteUniverse(async()=>Response.json({...response([coin("BTCUSDT",10)]),sources:[src("live",now-1000)]}),()=>now);
  await site.current();
  const signal={
    id:"other",exchange:"binance" as const,symbol:"ETHUSDT",timeframe:"1m",
    formation:"Double Bottom",direction:"LONG" as const,
    entryPrice:100,currentPrice:100,stopLoss:99,takeProfit:101,
    confidence:90,analysisVersion:FORMATION_ANALYSIS_VERSION,
    status:"confirmed" as const,candleAt:Date.now()-1000,
    detectedAt:Date.now(),description:"test",
  };
  store.set("signals",[signal]);
  const trader=new Trading(store,{} as any,new Vault(store,randomBytes(32).toString("base64")),{} as any,false,site);
  await assert.rejects(trader.enter("other"),/монета не входить/);
  assert.equal(trader.snapshot().signals.length,0);
  assert.equal(trader.snapshot().formations.length,0);
  await assert.rejects(trader.updateSettings({...DEFAULT_SETTINGS,exchange:"bybit"}),/лише Binance/);
  await assert.rejects(trader.updateSettings({...DEFAULT_SETTINGS,mode:"live"}),/лише Binance/);
});
