import test from "node:test";
import assert from "node:assert/strict";
import { MarketData } from "../backend/market";
import { DEFAULT_SETTINGS } from "../backend/config";

const mock = (used:number):typeof fetch => (async (url:URL)=>{
  if(!String(url).includes("/fapi/v1/ticker/price"))throw new Error("Only ticker expected");
  return new Response(JSON.stringify([{symbol:"BTCUSDT",price:"100.0"}]),{
    status:200,
    headers:{"Content-Type":"application/json","x-mbx-used-weight-1m":String(used)},
  });
}) as typeof fetch;

test("auto-mon does not apply old 800-unit early stop at shared IP usage 900",async()=>{
  const m=new MarketData(()=>DEFAULT_SETTINGS,mock(900),1200);
  const response=await m.getPrices("binance");
  assert.equal(response.data.BTCUSDT,100);
  assert.equal(m.weightStatus().used,900);
  assert.equal(m.weightStatus().localBudget,1200);
  assert.equal(m.weightStatus().pausedUntil,null);
});

test("auto-mon still fails closed when observed weight exceeds conservative 1200 threshold",async()=>{
  const m=new MarketData(()=>DEFAULT_SETTINGS,mock(1250),1200);
  await m.getPrices("binance");
  assert.ok((m.weightStatus().pausedUntil||0)>Date.now());
  assert.equal(m.weightStatus().used,1250);
  assert.ok(m.status().binance>Date.now());
});
