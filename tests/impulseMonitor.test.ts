import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../backend/store";
import { IMPULSE_STREAM_URL, ImpulseMonitor, confirmImpulse, impulseTickerCandidate } from "../backend/impulseMonitor";

const now=1_800_000_030_000;
const makeCandles=(direction:"LONG"|"SHORT"="LONG")=>{
  const candleStart=Math.floor(now/60_000)*60_000;
  const previous=Array.from({length:49},(_,i)=>({
    time:candleStart-(49-i)*60_000,
    open:100,close:100,high:100.1,low:99.9,volume:100,
  }));
  const current={
    time:candleStart,open:100,close:direction==="LONG"?101.1:98.9,
    high:direction==="LONG"?101.2:100.0,
    low:direction==="SHORT"?98.8:99.9,volume:450,
  };
  return [...previous,current];
};
const candidate=(direction:"LONG"|"SHORT"="LONG")=>({
  symbol:"COINUSDT",direction,changePct:direction==="LONG"?1:-1,
  price:direction==="LONG"?101.1:98.9,at:now,
});

test("all-market stream: valid USDT ticker triggers both directions after live price movement",()=>{
  const history=[{at:now-20_000,price:100}];
  const up=impulseTickerCandidate({s:"COINUSDT",c:"101",q:"50",st:1,E:now},history,true,now);
  assert.equal(up?.direction,"LONG");
  assert.ok((up?.changePct||0)>0.9);
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"98.8",q:"50",st:1,E:now},history,true,now)?.direction,"SHORT");
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"101",q:"50",st:2,E:now},history,true,now),null);
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"101",q:"50",st:1,E:now},history,false,now),null);
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"101",q:"50",st:1,E:now-18_000},history,true,now),null);
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"0",q:"50",st:1,E:now},history,true,now),null);
  assert.equal(impulseTickerCandidate({s:"COINUSDT",c:"101",q:"50",st:1,E:now},[],true,now),null);
});

test("1m confirmation rejects weak volume/no breakout and accepts real intraminute LONG / SHORT",()=>{
  const long=confirmImpulse(candidate(),makeCandles(),now);
  assert.equal(long?.symbol,"COINUSDT");
  assert.equal(long?.direction,"LONG");
  assert.equal(long?.formation,"Impulse Breakout");
  assert.equal(long?.status,"confirmed");
  assert.equal(long?.timeframe,"1m");
  assert.ok((long?.confidence||0)>=75);
  assert.equal(confirmImpulse(candidate("SHORT"),makeCandles("SHORT"),now)?.direction,"SHORT");
  const weak=makeCandles(); weak.at(-1)!.volume=30;
  assert.equal(confirmImpulse(candidate(),weak,now),null);
  const noBreakout=makeCandles();
  noBreakout.at(-2)!.high=110;
  assert.equal(confirmImpulse(candidate(),noBreakout,now),null);
  assert.equal(confirmImpulse({...candidate(),at:now-20_000},makeCandles(),now),null);
  const noMove=makeCandles(); noMove.at(-1)!.close=100.3;
  assert.equal(confirmImpulse(candidate(),noMove,now),null);
});

test("monitor uses one Binance websocket, filters inactive/non-USDT/COIN-M, and no h00k requests",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{stopLossPercent:0.25,takeProfitPercent:0.45});
  let clock=now-20_000,created=0,marketsCalls=0,candlesCalls=0;
  class FakeSocket {
    private events=new Map<string,Array<(event:any)=>void>>();
    readyState=1;
    addEventListener(event:string,handler:(event:any)=>void){
      const handlers=this.events.get(event)||[];
      handlers.push(handler);
      this.events.set(event,handlers);
    }
    emit(event:string,data?:any){
      for(const handler of this.events.get(event)||[])handler(data);
    }
    close(){this.readyState=3;this.emit("close");}
  }
  let socket!:FakeSocket;
  const m=new ImpulseMonitor(store,{
    getMarkets:async(exchange:string)=>{
      assert.equal(exchange,"binance");
      marketsCalls++;
      return [{symbol:"COINUSDT"},{symbol:"OTHUSDT"}];
    },
    getCandles:async(exchange:string,symbol:string,tf:string,limit:number)=>{
      assert.equal(exchange,"binance");
      assert.equal(symbol,"COINUSDT");
      assert.equal(tf,"1m");
      assert.equal(limit,50);
      candlesCalls++;
      return makeCandles();
    },
  } as any,(url:string)=>{
    assert.equal(url,IMPULSE_STREAM_URL);
    created++;
    socket=new FakeSocket();
    return socket as any;
  },()=>clock);
  await m.start();
  t.after(()=>m.stop());
  assert.equal(created,1);
  assert.equal(marketsCalls,1);
  assert.equal(m.status().markets,2);
  socket.emit("open");
  const ticker=(at:number,price:number,other:any={})=>
    ({e:"24hrTicker",s:"COINUSDT",E:at,c:String(price),q:"1234",st:1,...other});
  socket.emit("message",{data:JSON.stringify([
    ticker(clock,100),
    ticker(clock,100,{s:"UNKNOWNUSDT"}),
    ticker(clock,100,{st:2}),
  ])});
  clock=now;
  socket.emit("message",{data:JSON.stringify([
    ticker(clock,101.1),
    ticker(clock,102,{s:"OTHUSDT",q:"0"}),
  ])});
  assert.equal(m.status().queue,1);
  await (m as any).verifyNext();
  assert.equal(candlesCalls,1);
  assert.equal(m.status().found,1);
  const signals=store.get<any[]>("signals",[]);
  assert.equal(signals.length,1);
  assert.equal(signals[0].symbol,"COINUSDT");
  assert.equal(m.status().tracked,2); // Both active futures are tracked, even if only one triggers.
  m.stop();
  assert.equal(m.status().state,"stopped");
});
