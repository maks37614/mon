import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Signal } from "../backend/config";
import { HookFormationSources, readHookCandidates } from "../backend/hookFormationSources";
const now=1_800_000_000_000;
const coin={symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m",quoteAsset:"USDT",currentPrice:100,lastUpdated:now,formationData:{contiguous:true,collectedAt:now,lastClosedAt:now},formations:[{id:"r",bias:"bullish",status:"breakout",validation:{enoughData:true,finiteData:true}}],earlyFormations:[{id:"e",bias:"bullish",stage:"forming"}]};
const settings={...DEFAULT_SETTINGS};
const key={exchange:"binance" as const,symbol:"BTCUSDT",timeframe:"1m"};
test("source rows reject spot, wrong exchange/timeframe, stale, empty, preview",()=>{
  for(const bad of [{marketType:"spot"},{exchange:"bybit"},{timeframe:"5m"},{lastUpdated:now-120001},{formationData:undefined},{formationData:{...coin.formationData,collectedAt:now-120001}},{formations:[{...coin.formations[0],status:"target_reached"}]},{formations:[]},{formations:[{...coin.formations[0],source:"screener_24h_preview"}]}]){
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

test("valid short symbols, early potential, and empty replacement",async()=>{
  assert.equal(readHookCandidates([{...coin,symbol:"XUSDT"}],"binance","1m","regular",now).length,1);
  assert.equal(readHookCandidates([{...coin,earlyFormations:[{...coin.earlyFormations[0],stage:"potential"}]}],"binance","1m","early",now).length,1);
  let clock=now, data:unknown=[coin];
  const source=new HookFormationSources((async()=>Response.json({success:true,data})) as typeof fetch,()=>clock);
  await source.refresh(settings); assert.equal(source.allows(key,settings),true);
  clock+=45000; assert.equal(source.allows(key,settings),false);
  data=[]; await source.refresh(settings); assert.equal(source.allows(key,settings),false);
});
test("an in-flight result cannot repopulate an invalidated allowlist",async()=>{
  let resolve!: (response: Response)=>void;
  const source=new HookFormationSources((()=>new Promise<Response>(r=>{resolve=r;})) as typeof fetch,()=>now);
  const pending=source.refresh(settings); source.invalidate(); resolve(Response.json({success:true,data:[coin]})); await pending;
  assert.equal(source.allows(key,settings),false);
});
