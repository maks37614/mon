import test from "node:test";
import assert from "node:assert/strict";
import {DEFAULT_SETTINGS,type Signal} from "../backend/config";
import {HookFormationSources,readHookCandidates} from "../backend/hookFormationSources";
const now=1_800_000_000_000;
const validation={enoughData:true,finiteData:true,closedCandleOnly:true,lookAheadSafe:true,passed:true,confirmed:true,breakoutConfirmed:true,entryMode:"BREAKOUT",regularPlan:{breakoutClosedAt:now},confluence:{total:87.5}};
const pattern={id:"r",patternKey:"double_bottom",bias:"bullish",status:"breakout",validation,confidence:88,levels:{entryPrice:100,stopLossPrice:99,targetPrice:102},detectedAt:now-60000};
const coin={symbol:"BTCUSDT",exchange:"binance",marketType:"futures",timeframe:"1m",quoteAsset:"USDT",currentPrice:100,volume24hUsd:100000,lastUpdated:now,formationData:{contiguous:true,collectedAt:now,lastClosedAt:now},formations:[pattern],earlyFormations:[{id:"e",patternKey:"double_bottom",bias:"bullish",stage:"forming",breakoutEntry:100,breakoutStopLoss:99,target:102,observedAt:now}]};
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

test("disabling confirmation never revives a stopped, expired or flow-blocked plan",async()=>{
  for(const extra of [{regularPlan:{...validation.regularPlan,afterEntry:[[101,98]]}},{regularPlan:{...validation.regularPlan,entryExpired:true}},{regularPlan:{...validation.regularPlan,structureActive:false}},{entryMode:"WAIT_RETEST"},{confluence:{total:87.5,flow:{entryBlockedByFlow:true}}}]){
    const data=[{...coin,formations:[{...pattern,validation:{...validation,...extra,passed:false}}]}];
    const source=new HookFormationSources((async()=>Response.json({success:true,data})) as typeof fetch,()=>now);
    const s={...settings,confirmedOnly:false};await source.refresh(s);
    assert.ok(source.signals(s)[0]);assert.equal(source.allowsEntry(source.signals(s)[0],s),false);
  }
});

test("source coverage distinguishes received, filtered, eligible and expired patterns",async()=>{
 let clock=now,requests=0;const source=new HookFormationSources((async()=>{requests++;return Response.json({success:true,data:[coin]});}) as typeof fetch,()=>clock);
 await source.refresh(settings);let c=source.coverage(settings)[0];assert.equal(c.receivedCoins,1);assert.equal(c.validPatterns,1);assert.equal(c.eligiblePatterns,1);
 assert.equal(source.coverage({...settings,minScore:95})[0].visiblePatterns,0);
 clock+=30000;await source.refresh(settings);assert.equal(requests,2);
 clock+=45000;assert.equal(source.coverage(settings)[0].fresh,false);assert.equal(source.coverage(settings)[0].eligiblePatterns,0);
});
test("conflicting duplicate source identity fails closed",async()=>{
 const other={...pattern,validation:{...validation,passed:false}};const source=new HookFormationSources((async()=>Response.json({success:true,data:[{...coin,formations:[pattern,other]}]})) as typeof fetch,()=>now);
 await source.refresh(settings);assert.equal(source.signals(settings).length,0);assert.match(Object.values(source.diagnostics())[0],/дублікати/);
});

test("early source normalizes seconds and polls a running shared job instead of starting again",async()=>{
 const id="12345678-1234-1234-1234-123456789abc";let clock=now;const calls:string[]=[];
 const source=new HookFormationSources((async(input,init)=>{calls.push(String(input));return Response.json({success:true,scan:{id,params:{exchange:"binance",marketType:"futures",timeframe:"1m",minVolumeUsd:50000},status:"running",missingSources:[],failed:0,data:[{...coin,earlyFormations:[{...coin.earlyFormations[0],observedAt:now/1000}]}]}});}) as typeof fetch,()=>clock);
 const s={...settings,hookRegularFormations:false,hookEarlyFormations:true,confirmedOnly:false,hookMinVolumeUsd:50000};
 await source.refresh(s);assert.equal(source.signals(s)[0].detectedAt,now);clock+=30000;await source.refresh(s);
 assert.match(calls[0],/early\/start$/);assert.match(calls[1],/early\/status\?id=/);assert.equal(source.allowsEntry(source.signals(s)[0],s),false);
});
test("regular request uses chosen volume and rejects inconsistent response counts",async()=>{
 let request="";const source=new HookFormationSources((async(input)=>{request=String(input);return Response.json({success:true,count:2,data:[coin]});}) as typeof fetch,()=>now);
 await source.refresh({...settings,hookMinVolumeUsd:50000});assert.match(request,/minVolume=50000/);assert.equal(source.signals({...settings,hookMinVolumeUsd:50000}).length,0);assert.match(Object.values(source.diagnostics())[0],/Неповна/);
});

test("volume scopes cannot reuse old authorization or accept below-threshold coins",async()=>{
 const source=new HookFormationSources((async()=>Response.json({success:true,data:[coin]})) as typeof fetch,()=>now);
 const low={...settings,hookMinVolumeUsd:50000},high={...settings,hookMinVolumeUsd:200000};
 await source.refresh(low);const signal=source.signals(low)[0];assert.ok(signal);assert.equal(source.allowsEntry(signal,high),false);
 await source.refresh(high);assert.equal(source.signals(high).length,0);assert.equal(source.coverage(high)[0].receivedPatterns,1);
 assert.equal(source.allowsEntry(signal,low),true);
});
test("contradictory breakout status and retest entry mode never confirm",()=>{
 const result=read({...coin,formations:[{...pattern,validation:{...validation,entryMode:"RETEST"}}]});assert.equal(result[0].signal.status,"watching");
});

test("blocked source rows expose accurate reasons without changing authorization",async()=>{
 const data=[{...coin,formations:[{...pattern,validation:{...validation,entryMode:"WAIT_RETEST",passed:false}}]}];
 const source=new HookFormationSources((async()=>Response.json({success:true,data})) as typeof fetch,()=>now);
 const s={...settings,confirmedOnly:false};await source.refresh(s);const row=source.signals(s)[0];assert.ok(row);
 assert.equal(source.allowsEntry(row,s),false);assert.ok(source.entryReasons(row,s).some(r=>r.includes("ретесту")));
});
