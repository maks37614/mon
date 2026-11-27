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
