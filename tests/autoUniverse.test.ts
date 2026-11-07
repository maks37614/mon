import test from "node:test";
import assert from "node:assert/strict";
import { SiteUniverse, parseSiteCoins, AUTO_REFRESH_MS } from "../backend/siteUniverse";

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
