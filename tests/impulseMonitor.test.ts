import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../backend/store";
import { Trading } from "../backend/trading";
import { Vault } from "../backend/security";
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION } from "../backend/config";
import { randomBytes } from "node:crypto";
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
  const missingMinute=makeCandles(); missingMinute.at(-2)!.time-=60_000;
  assert.equal(confirmImpulse(candidate(),missingMinute,now),null,
    "missing one closed minute cannot be treated as a confirmed 20m breakout");
});

test("monitor uses ONE all-market stream plus bounded kline stream, with only optional one-time REST history seed",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{stopLossPercent:0.25,takeProfitPercent:0.45});
  let clock=now-20_000,tickerCreated=0,klineCreated=0,marketsCalls=0,candlesCalls=0;
  class FakeSocket {
    private events=new Map<string,Array<(event:any)=>void>>();
    readyState=1;
    sent:any[]=[];
    addEventListener(event:string,handler:(event:any)=>void){
      const handlers=this.events.get(event)||[];
      handlers.push(handler);
      this.events.set(event,handlers);
    }
    send(raw:string){this.sent.push(JSON.parse(raw));}
    emit(event:string,data?:any){for(const fn of this.events.get(event)||[])fn(data);}
    close(){this.readyState=3;this.emit("close");}
  }
  let ticker!:FakeSocket,kline!:FakeSocket;
  const m=new ImpulseMonitor(store,{
    status:()=>({}),
    weightStatus:()=>({used:100,observedAt:Date.now(),localBudget:1200,pausedUntil:null}),
    getMarkets:async(exchange:string)=>{
      assert.equal(exchange,"binance");
      marketsCalls++;
      return [{symbol:"COINUSDT"},{symbol:"OTHUSDT"}];
    },
    getCandles:async(exchange:string,symbol:string,tf:string,limit:number)=>{
      assert.equal(exchange,"binance");
      assert.equal(symbol,"COINUSDT");
      assert.equal(tf,"1m");assert.equal(limit,31);
      candlesCalls++;
      return makeCandles().slice(-31);
    },
  } as any,(url:string)=>{
    assert.equal(url,IMPULSE_STREAM_URL);tickerCreated++;
    ticker=new FakeSocket();return ticker as any;
  },()=>clock,(url:string)=>{
    assert.equal(url,"wss://fstream.binance.com/market/stream");klineCreated++;
    kline=new FakeSocket();return kline as any;
  });
  await m.start();
  t.after(()=>m.stop());
  assert.equal(tickerCreated,1);assert.equal(klineCreated,1);
  assert.equal(marketsCalls,1);
  ticker.emit("open");kline.emit("open");
  const quote=(at:number,price:number,other:any={})=>
    ({e:"24hrTicker",s:"COINUSDT",E:at,c:String(price),q:"1234",st:1,...other});
  ticker.emit("message",{data:JSON.stringify([
    quote(clock,100),quote(clock,100,{s:"UNKNOWNUSDT"}),
    quote(clock,100,{st:2}),
  ])});
  clock=now;
  ticker.emit("message",{data:JSON.stringify([
    quote(clock,101.1),quote(clock,102,{s:"OTHUSDT",q:"0"}),
  ])});
  assert.equal(m.status().queue,1);
  (m as any).klines.flushControls();
  assert.ok(kline.sent.some(req=>req.method==="SUBSCRIBE" && req.params[0]==="coinusdt@kline_1m"));
  await new Promise(resolve=>setImmediate(resolve));
  const current=makeCandles().at(-1)!;
  const k={t:current.time,s:"COINUSDT",i:"1m",o:String(current.open),
    c:String(current.close),h:String(current.high),l:String(current.low),
    v:String(current.volume),x:false};
  kline.emit("message",{data:JSON.stringify({
    stream:"coinusdt@kline_1m",
    data:{e:"kline",E:clock,s:"COINUSDT",k}
  })});
  assert.equal(candlesCalls,1);
  assert.equal(m.status().found,1);
  assert.equal(m.status().klineStatus.activeStreams,1);
  assert.equal(m.status().klineStatus.warmStreams,1);
  assert.equal(m.isFresh(),true);
  const signals=store.get<any[]>("signals",[]);
  assert.equal(signals.length,1);
  assert.equal(signals[0].symbol,"COINUSDT");
  assert.equal(m.status().tracked,2);
  for(let i=0;i<10;i++){
    clock+=50;
    kline.emit("message",{data:JSON.stringify({
      stream:"coinusdt@kline_1m",
      data:{e:"kline",E:clock,s:"COINUSDT",k}
    })});
  }
  assert.equal(candlesCalls,1,"live updates after bootstrap must NOT call REST again");
  assert.equal(m.status().found,1,"one signal per candle, not repeated on every WS tick");
  m.stop();
  assert.equal(m.status().state,"stopped");
});

test("stale websocket prevents BOTH manual and automatic entries even if previous signal remains",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,mode:"paper",exchange:"binance",
    timeframes:["1m"],formationTypes:["Impulse Breakout"],maxSignalAgeSeconds:45});
  const signal={
    id:"impulse-one",exchange:"binance",symbol:"BTCUSDT",timeframe:"1m",
    formation:"Impulse Breakout",direction:"LONG",entryPrice:100,currentPrice:100,
    stopLoss:99,takeProfit:101,confidence:95,analysisVersion:FORMATION_ANALYSIS_VERSION,
    status:"confirmed",candleAt:Date.now()-1000,detectedAt:Date.now(),
    description:"live test",
  };
  store.set("signals",[signal]);
  const trading=new Trading(store,{} as any,
    new Vault(store,randomBytes(32).toString("base64")),{} as any,false,undefined,true,()=>false);
  assert.equal(trading.snapshot().signals.length,0);
  assert.equal(trading.snapshot().formations[0].canEnter,false);
  await assert.rejects(trading.enter("impulse-one"),/WebSocket недоступний/);
});


test("AUTO paper opens a real-market-priced virtual position WITHOUT Binance account keys",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,mode:"paper",exchange:"binance",
    timeframes:["1m"],formationTypes:["Impulse Breakout"],
    maxSignalAgeSeconds:45,initialBalance:1000,
    orderNotionalUsdt:25,leverage:1,paperFeeMode:"account",
    autoEntries:true,entryIntervalSeconds:5});
  const now=Date.now();
  const signal={
    id:"impulse-public",exchange:"binance",symbol:"BTCUSDT",timeframe:"1m",
    formation:"Impulse Breakout",direction:"LONG",entryPrice:100,currentPrice:100,
    stopLoss:99.75,takeProfit:100.45,confidence:90,
    analysisVersion:FORMATION_ANALYSIS_VERSION,status:"confirmed",
    candleAt:now-1000,detectedAt:now-1000,description:"Live paper only test",
  };
  store.set("signals",[signal]);
  let publicCalls=0, phase:"entry"|"exit"="entry";
  const market:any={
    getPrices:async(exchange:string)=>{
      assert.equal(exchange,"binance");publicCalls++;
      return {at:Date.now(),data:{BTCUSDT:100}};
    },
    getMarkets:async()=>[{symbol:"BTCUSDT",base:"BTC",quantityStep:0.001,
      minQuantity:0.001,minNotional:5,tickSize:0.01,maxQuantity:10000}],
    getContractState:async()=>{publicCalls++;return {
      at:Date.now(),mark:phase==="exit"?98.9:100,last:phase==="exit"?98.9:100,nextFundingAt:Date.now()+3600_000,
    }},
    getExecutionBook:async()=>{publicCalls++;return {
      at:Date.now(),
      bids:phase==="exit"?[[98.89,1000],[98.88,1000]]:[[99.99,1000],[99.98,1000]],
      asks:phase==="exit"?[[98.91,1000],[98.92,1000]]:[[100.01,1000],[100.02,1000]],
    }},
  };
  const trader=new Trading(store,market,
    new Vault(store,randomBytes(32).toString("base64")),{} as any,
    false,undefined,true,()=>true);
  assert.equal(trader.snapshot().publicPaperApproximation,true);
  await trader.enter("impulse-public");
  const state=trader.snapshot();
  assert.equal(state.positions.length,1);
  assert.equal(state.positions[0].symbol,"BTCUSDT");
  assert.equal(trader.settings().reverseEnabled,true);
  assert.equal(state.positions[0].direction,"SHORT");
  assert.equal(store.get<any>("book:paper",{}).positions[0].intent.signal.direction,"LONG");
  assert.ok(state.positions[0].entryPrice<100);
  assert.ok(state.positions[0].takeProfit<state.positions[0].entryPrice);
  assert.ok(state.positions[0].stopLoss>state.positions[0].entryPrice);
  assert.equal(state.positions[0].paper.tiers.length,0);
  assert.equal(state.positions[0].paper.feeSource,"manual");
  assert.ok(state.positions[0].paper.warnings.includes("liquidation-not-modeled"));
  assert.equal(state.stats.balance<1000,true);
  assert.ok(publicCalls>=3);
  assert.equal(trader.liveAllowed,false);

  // A live public price hitting TP must close the virtual trade with a public
  // order-book fill and manual fee, WITHOUT calling signed account endpoints.
  phase="exit";
  const book=store.get<any>("book:paper",{});
  await (trader as any).monitorPaper(book,book.positions[0]);
  // The normal Trading.monitor() loop persists the completed book after processing.
  store.set("book:paper",book);
  const closed=trader.snapshot();
  assert.equal(closed.positions.length,0);
  assert.equal(closed.history.length,1);
  assert.equal(closed.history[0].reason,"TP");
  assert.equal(closed.history[0].direction,"SHORT");
  assert.equal(closed.history[0].signalDirection,"LONG");
  assert.ok(closed.history[0].netPnl>0);
  assert.ok(closed.history[0].fee>0);
});

test("Binance paper without keys does not enable leverage higher than 1x",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,leverage:10,mode:"paper",
    exchange:"binance",timeframes:["1m"],formationTypes:["Impulse Breakout"]});
  const trader=new Trading(store,{} as any,
    new Vault(store,randomBytes(32).toString("base64")),{} as any,false,undefined,true,()=>true);
  assert.equal(trader.settings().leverage,1);
  assert.equal(trader.liveAllowed,false);
});


test("reverse AUTO opens a paper LONG after a bearish impulse, even with legacy reverseEnabled=false",async t=>{
  const dir=mkdtempSync(path.join(process.cwd(),".test-impulse-"));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set("settings",{...DEFAULT_SETTINGS,reverseEnabled:false,mode:"paper",
    exchange:"binance",timeframes:["1m"],formationTypes:["Impulse Breakout"],
    maxSignalAgeSeconds:45,initialBalance:1000,orderNotionalUsdt:25,
    leverage:1,autoEntries:true});
  store.set("signals",[{
    id:"bearish-impulse",exchange:"binance",symbol:"ETHUSDT",timeframe:"1m",
    formation:"Impulse Breakout",direction:"SHORT",entryPrice:100,
    currentPrice:100,stopLoss:100.25,takeProfit:99.55,
    confidence:90,analysisVersion:FORMATION_ANALYSIS_VERSION,
    status:"confirmed",candleAt:Date.now()-1000,detectedAt:Date.now()-1000,
    description:"Live market falling",
  }]);
  const market:any={
    getPrices:async()=>({at:Date.now(),data:{ETHUSDT:100}}),
    getMarkets:async()=>[{symbol:"ETHUSDT",base:"ETH",quantityStep:0.001,
      minQuantity:0.001,minNotional:5,tickSize:0.01,maxQuantity:10000}],
    getContractState:async()=>({
      at:Date.now(),mark:100,last:100,nextFundingAt:Date.now()+3600_000,
    }),
    getExecutionBook:async()=>({at:Date.now(),
      bids:[[99.99,1000],[99.98,1000]],asks:[[100.01,1000],[100.02,1000]],
    }),
  };
  const trader=new Trading(store,market,
    new Vault(store,randomBytes(32).toString("base64")),{} as any,
    false,undefined,true,()=>true);
  assert.equal(store.get<any>("settings",{}).reverseEnabled,false);
  assert.equal(trader.settings().reverseEnabled,true);
  await trader.enter("bearish-impulse");
  const trade=trader.snapshot().positions[0];
  assert.equal(trade.direction,"LONG");
  assert.equal(store.get<any>("book:paper",{}).positions[0].intent.signal.direction,"SHORT");
  assert.ok(trade.takeProfit>trade.entryPrice);
  assert.ok(trade.stopLoss<trade.entryPrice);
  assert.equal(trader.liveAllowed,false);
});
