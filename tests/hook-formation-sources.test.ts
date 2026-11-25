import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Signal } from "../backend/config";
import { HookFormationSources, readHookCandidates } from "../backend/hookFormationSources";
const now=1_800_000_000_000;
const coin={symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m",quoteAsset:"USDT",currentPrice:100,lastUpdated:now,formations:[{id:"r",bias:"bullish",validation:{enoughData:true,finiteData:true}}],earlyFormations:[{id:"e",bias:"bullish",stage:"forming"}]};
const settings={...DEFAULT_SETTINGS};
const key={exchange:"binance" as const,symbol:"BTCUSDT",timeframe:"1m"};
test("source rows reject spot, wrong exchange/timeframe, stale, empty, preview",()=>{
  for(const bad of [{marketType:"spot"},{exchange:"bybit"},{timeframe:"5m"},{lastUpdated:now-120001},{formations:[]},{formations:[{...coin.formations[0],source:"screener_24h_preview"}]}]){
    assert.equal(readHookCandidates([{...coin,...bad}],"binance","1m","regular",now).length,0);
  }
  assert.equal(readHookCandidates([coin],"binance","1m","regular",now).length,1);
});
test("regular is default; expiry, unknown symbol, source disabled and HTTP failure deny entries",async()=>{
  let clock=now, fail=false, requests=0;
  const source=new HookFormationSources((async()=>{requests++;return fail?new Response("",{status:503}):Response.json({success:true,data:[coin]});}) as typeof fetch,()=>clock);
  assert.equal(source.allows(key,settings),false);
  await source.refresh(settings);
  assert.equal(requests,1);
  assert.equal(source.allows(key,settings),true);
  assert.equal(source.allows({...key,symbol:"ETHUSDT"},settings),false);
  assert.equal(source.allows(key,{...settings,hookRegularFormations:false}),false);
  clock+=46000; fail=true; await source.refresh(settings);
  assert.equal(source.allows(key,settings),false);
  fail=false; await source.refresh(settings); clock=now+120001;
  assert.equal(source.allows(key,settings),false);
});
test("early only is opt-in and never allows unconfirmed entry",async()=>{
  const source=new HookFormationSources((async()=>Response.json({success:true,scan:{params:{exchange:"binance",marketType:"futures",timeframe:"1m"},status:"running",missingSources:[],failed:0,data:[coin]}})) as typeof fetch,()=>now);
  const s={...settings,hookRegularFormations:false,hookEarlyFormations:true,confirmedOnly:false};
  await source.refresh(s);
  assert.equal(source.allows(key,s),true);
  assert.equal(source.allowsEntry({...key,status:"watching"} as Signal,s),false);
  assert.equal(source.allowsEntry({...key,status:"confirmed"} as Signal,s),true);
  assert.equal(source.allows(key,{...s,hookEarlyFormations:false}),false);
});
