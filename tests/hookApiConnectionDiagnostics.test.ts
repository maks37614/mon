import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../backend/config";
import { HookFormationSources, readHookCandidates } from "../backend/hookFormationSources";

const settings = {...DEFAULT_SETTINGS, timeframes:["5m"], hookRegularFormations:true, hookEarlyFormations:false};
const initial = 1_795_811_200_000;

test("API failures retain diagnostics, back off, and recover without stale trading signals", async () => {
  let now=initial, calls=0, fail=false;
  const fetcher: typeof fetch=async () => {
    calls++;
    return fail ? new Response("unavailable",{status:503}) :
      Response.json({success:true,count:0,data:[]});
  };
  const source=new HookFormationSources(fetcher,()=>now);
  await source.refresh(settings);
  assert.equal(source.coverage(settings)[0].lastSuccessAt,initial);
  assert.equal(source.coverage(settings)[0].fresh,true);
  now+=30_000; fail=true;
  await source.refresh(settings);
  let state=source.coverage(settings)[0];
  assert.equal(state.fresh,false);
  assert.equal(state.consecutiveFailures,1);
  assert.equal(state.lastSuccessAt,initial);
  assert.equal(state.nextRetryAt,now+15_000);
  assert.deepEqual(source.eligibleSignals(settings),[]);
  await source.refresh(settings);
  assert.equal(calls,2);
  now+=15_000;
  await source.refresh(settings);
  state=source.coverage(settings)[0];
  assert.equal(state.consecutiveFailures,2);
  assert.equal(state.nextRetryAt,now+30_000);
  now+=30_000; fail=false;
  await source.refresh(settings);
  state=source.coverage(settings)[0];
  assert.equal(state.fresh,true);
  assert.equal(state.lastSuccessAt,now);
  assert.equal(state.consecutiveFailures,0);
  assert.equal(state.nextRetryAt,null);
  assert.equal(state.error,null);
});

test("stale source data are counted and remain ineligible", () => {
  const rejected:Record<string,number>={};
  const rows=readHookCandidates([{
    symbol:"BTCUSDT", exchange:"binance", marketType:"futures", timeframe:"5m",
    quoteAsset:"USDT", currentPrice:60000, lastUpdated:initial-120_001,
    formations:[{},{}],
  }],"binance","5m","regular",initial,0,rejected);
  assert.equal(rows.length,0);
  assert.equal(rejected["Застарілі дані монети"],2);
});

test("source disabled is distinct from a successful empty API response", async () => {
  const source=new HookFormationSources(async()=>Response.json({success:true,count:0,data:[]}),()=>initial);
  assert.deepEqual(source.coverage({...settings,hookRegularFormations:false}),[]);
  await source.refresh(settings);
  assert.equal(source.coverage(settings)[0].receivedPatterns,0);
  assert.equal(source.coverage(settings)[0].lastSuccessAt,initial);
});

test("formation API Retry-After delays retries and does not restore stale data", async () => {
  let now=initial, calls=0;
  const source=new HookFormationSources(async()=>{
    calls++;
    return calls===2 ? new Response("",{status:429,headers:{"Retry-After":"90"}})
      : Response.json({success:true,count:0,data:[]});
  },()=>now);
  await source.refresh(settings);
  now+=30_000;
  await source.refresh(settings);
  assert.equal(source.coverage(settings)[0].nextRetryAt,now+90_000);
  assert.equal(source.coverage(settings)[0].fresh,false);
  assert.deepEqual(source.eligibleSignals(settings),[]);
  now+=89_000;
  await source.refresh(settings);
  assert.equal(calls,2);
  now+=1_000;
  await source.refresh(settings);
  assert.equal(calls,3);
  assert.equal(source.coverage(settings)[0].fresh,true);
});

test("incomplete early job and transient errors preserve the job ID without authorizing trades", async () => {
  let now=initial;
  const id="12345678-1234-1234-1234-123456789abc";
  const calls:string[]=[];
  const source=new HookFormationSources(async input=>{
    calls.push(String(input));
    if(calls.length===2) return new Response("",{status:503});
    if(calls.length===4) return new Response("",{status:404});
    return Response.json({success:true,scan:{id,params:{exchange:"binance",marketType:"futures",timeframe:"5m"},status:"running",missingSources:calls.length===1?["candles"]:[],failed:0,data:[]}});
  },()=>now);
  const early={...settings,hookRegularFormations:false,hookEarlyFormations:true};
  await source.refresh(early);
  assert.equal(source.coverage(early)[0].fresh,false);
  now+=15_000;
  await source.refresh(early);
  assert.match(calls[1],/early\/status\?id=/);
  now+=30_000;
  await source.refresh(early);
  assert.match(calls[2],/early\/status\?id=/);
  assert.equal(source.coverage(early)[0].fresh,true);
  assert.deepEqual(source.eligibleSignals(early),[]);
  now+=30_000;
  await source.refresh(early);
  assert.match(calls[3],/early\/status\?id=/);
  now+=15_000;
  await source.refresh(early);
  assert.match(calls[4],/early\/start$/);
});
