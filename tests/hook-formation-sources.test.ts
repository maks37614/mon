import test from "node:test";
import assert from "node:assert/strict";
import {DEFAULT_SETTINGS,type Signal} from "../backend/config";
import {HookFormationSources,readHookCandidates} from "../backend/hookFormationSources";
const now=1_800_000_000_000;
const validation={enoughData:true,finiteData:true,closedCandleOnly:true,lookAheadSafe:true,passed:true,confirmed:true,breakoutConfirmed:true,entryMode:"BREAKOUT",regularPlan:{breakoutClosedAt:now},confluence:{total:87.5}};
const pattern={id:"r",patternKey:"double_bottom",bias:"bullish",status:"breakout",validation,confidence:88,levels:{entryPrice:100,stopLossPrice:99,targetPrice:102},detectedAt:now-60000};
const coin={symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m",quoteAsset:"USDT",currentPrice:100,lastUpdated:now,formationData:{contiguous:true,collectedAt:now,lastClosedAt:now},formations:[pattern],earlyFormations:[{id:"e",patternKey:"double_bottom",bias:"bullish",stage:"forming",breakoutEntry:100,breakoutStopLoss:99,target:102,observedAt:now}]};
const settings={...DEFAULT_SETTINGS};
const key={exchange:"binance" as const,symbol:"BTCUSDT",timeframe:"1m"};
const read=(c:unknown=coin)=>readHookCandidates([c],"binance","1m","regular",now);
test("exact source confirmation and valid levels",()=>{
  const s=read()[0].signal; assert.equal(s.status,"confirmed"); assert.equal(s.confidence,87.5);assert.equal(s.sourceFormationId,"r");
  for(const bad of [{passed:false},{confirmed:false},{breakoutConfirmed:false},{entryMode:"WAIT_RETEST"}]){
    assert.equal(read({...coin,formations:[{...pattern,validation:{...validation,...bad}}]})[0].signal.status,"watching");
  }
  for(const status of ["forming","ready_to_break"]) assert.equal(read({...coin,formations:[{...pattern,status}]})[0].signal.status,"watching");
  assert.equal(read({...coin,formations:[{...pattern,status:"retest",validation:{...validation,entryMode:"RETEST",regularPlan:{retestClosedAt:now}}}]})[0].signal.status,"confirmed");
  assert.equal(read({...coin,formations:[{...pattern,status:"target_reached"}]}).length,0);
});
test("reject malformed stale wrong market and unknown patterns",()=>{
  for(const bad of [{marketType:"spot"},{exchange:"bybit"},{timeframe:"5m"},{lastUpdated:now-120001},{formationData:undefined},{formations:[]},{formations:[{...pattern,patternKey:"unknown"}]},{formations:[{...pattern,source:"screener_24h_preview"}]},{formations:[{...pattern,levels:{...pattern.levels,stopLossPrice:101}}]}])assert.equal(read({...coin,...bad}).length,0);
  assert.equal(read({...coin,symbol:"XUSDT"}).length,1);
});
test("exact identity; same coin cannot authorize a different type or old signal",async()=>{
  let clock=now,data:unknown=[coin],fail=false,requests=0;
  const source=new HookFormationSources((async()=>{requests++;return fail?new Response("",{status:503}):Response.json({success:true,data});}) as typeof fetch,()=>clock);
  assert.equal(source.allows(key,settings),false);
  await source.refresh(settings);assert.equal(requests,1);
  const s=source.signals(settings)[0];assert.ok(source.allowsEntry(s,settings));
  for(const bad of [{id:"other"},{source:undefined},{sourceFormationId:"other"},{formation:"Double Top"},{direction:"SHORT"},{status:"watching"},{entryPrice:101}])assert.equal(source.allowsEntry({...s,...bad} as Signal,settings),false);
  assert.equal(source.allowsEntry(s,{...settings,hookRegularFormations:false}),false);
  clock+=45000;assert.equal(source.allowsEntry(s,settings),false);
  data=[{...coin,formations:[{...pattern,validation:{...validation,passed:false}}]}];await source.refresh(settings);
  assert.equal(source.signals(settings).length,0);assert.equal(source.allowsEntry(s,settings),false);
  const watching=source.signals({...settings,confirmedOnly:false})[0];assert.equal(watching.status,"watching");assert.ok(source.allowsEntry(watching,{...settings,confirmedOnly:false}));
  clock+=45000;fail=true;await source.refresh(settings);assert.equal(source.allows(key,settings),false);
});
test("early is opt-in, unscored and never invents confirmation",async()=>{
  const source=new HookFormationSources((async()=>Response.json({success:true,scan:{params:{exchange:"binance",marketType:"futures",timeframe:"1m"},status:"running",missingSources:[],failed:0,data:[coin]}})) as typeof fetch,()=>now);
  const s={...settings,hookRegularFormations:false,hookEarlyFormations:true,confirmedOnly:false};
  await source.refresh(s);const early=source.signals(s)[0];assert.equal(early.source,"hook_early");assert.equal(early.status,"watching");assert.equal(source.signals({...s,confirmedOnly:true}).length,0);
  assert.equal(source.allowsEntry(early,s),false);assert.equal(source.allowsEntry({...early,status:"confirmed"},s),false);assert.equal(source.allows(key,{...s,hookEarlyFormations:false}),false);
});
test("invalidated request cannot restore authorization",async()=>{
  let resolve!:(response:Response)=>void;
  const source=new HookFormationSources((()=>new Promise<Response>(r=>{resolve=r;})) as typeof fetch,()=>now);
  const pending=source.refresh(settings);source.invalidate();resolve(Response.json({success:true,data:[coin]}));await pending;assert.equal(source.allows(key,settings),false);
});
