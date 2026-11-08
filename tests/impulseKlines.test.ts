import test from "node:test";
import assert from "node:assert/strict";
import { SelectiveKlineStreams, MAX_KLINE_STREAMS, KLINE_STREAM_URL, parseKlinePacket } from "../backend/impulseKlines";
import type { Candle } from "../backend/config";

const BASE=1_800_000_000_000;
class FakeSocket {
  readyState=1;
  sent:unknown[]=[];
  private listeners=new Map<string,Array<(arg:any)=>void>>();
  addEventListener(name:string,fn:(arg:any)=>void){
    const functions=this.listeners.get(name)||[];
    functions.push(fn);this.listeners.set(name,functions);
  }
  send(payload:string){this.sent.push(JSON.parse(payload));}
  emit(name:string,arg?:any){for(const fn of this.listeners.get(name)||[])fn(arg);}
  close(){this.readyState=3;this.emit("close");}
}
function bar(symbol:string,at:number,price=100,volume=100){
  const t=Math.floor(at/60_000)*60_000;
  return {stream:symbol.toLowerCase()+"@kline_1m",
    data:{e:"kline",E:at,s:symbol,k:{
      t,s:symbol,i:"1m",o:"100",h:String(Math.max(100,price)),
      l:String(Math.min(100,price)),c:String(price),v:String(volume),x:false,
    }}};
}
function fixture(market:any,now:()=>number,onBar:(s:string,bars:Candle[])=>void=()=>{}){
  let ws!:FakeSocket;
  const stream=new SelectiveKlineStreams(market,onBar,(url:string)=>{
    assert.equal(url,KLINE_STREAM_URL);ws=new FakeSocket();return ws as any;
  },now);
  stream.start();ws.emit("open");
  return {stream,socket:ws};
}
test("Binance candidate kline frames require valid live symbol, time and OHLCV",()=>{
  assert.equal(parseKlinePacket(bar("BTCUSDT",BASE+30_000,101),BASE+30_000)?.candle.close,101);
  assert.equal(parseKlinePacket(bar("BTCUSDT",BASE+30_000,101),BASE+50_000),null);
  assert.equal(parseKlinePacket({...bar("BTCUSDT",BASE+30_000,101),stream:"ethusdt@kline_1m"},BASE+30_000),null);
  const invalid=bar("BTCUSDT",BASE+30_000);
  invalid.data.k.v="-50";
  assert.equal(parseKlinePacket(invalid,BASE+30_000),null);
  assert.equal(parseKlinePacket({id:"abc",result:null},BASE+30_000),null);
});

test("one socket and one batched SUBSCRIBE request for up to 32 volatile candidates",t=>{
  let clock=BASE+30_000;
  const market:any={status:()=>({binance:clock+60000}),
    weightStatus:()=>({used:1600,observedAt:clock})};
  const {stream,socket}=fixture(market,()=>clock);
  t.after(()=>stream.stop());
  const symbols=Array.from({length:MAX_KLINE_STREAMS},(_,i)=>"COIN"+i+"USDT");
  for(const symbol of symbols)assert.equal(stream.watch(symbol),true);
  assert.equal(stream.watch("EXTRAUSDT"),false,"a full, fresh pool must not churn");
  (stream as any).flushControls();
  const commands=socket.sent as any[];
  assert.equal(commands.length,1);
  assert.equal(commands[0].method,"SUBSCRIBE");
  assert.equal(commands[0].params.length,MAX_KLINE_STREAMS);
  assert.equal(typeof commands[0].id,"string");
  assert.equal(stream.status().activeStreams,MAX_KLINE_STREAMS);
  assert.equal(stream.status().bootstrapCalls,0,"no REST when the shared IP is above its budget");
  clock+=16_000;
  assert.equal(stream.watch("EXTRAUSDT"),true,"stale candidate streams can rotate");
  (stream as any).flushControls();
  (stream as any).flushControls();
  assert.deepEqual((socket.sent as any[]).slice(-2).map(x=>x.method),["UNSUBSCRIBE","SUBSCRIBE"]);
  assert.equal(stream.status().activeStreams,MAX_KLINE_STREAMS);
});

test("market-weight pause permits collecting 21 actual 1m candles over WS without a REST call",t=>{
  let clock=BASE+30_000,received=0;
  const market:any={
    status:()=>({binance:clock+60_000}),
    weightStatus:()=>({used:1500,observedAt:clock}),
    getCandles:async()=>{throw new Error("REST must not be used");},
  };
  const {stream,socket}=fixture(market,()=>clock,()=>received++);
  t.after(()=>stream.stop());
  assert.equal(stream.watch("BTCUSDT"),true);
  for(let i=0;i<21;i++){
    clock=BASE+30_000+i*60_000;
    socket.emit("message",{data:JSON.stringify(bar("BTCUSDT",clock))});
  }
  assert.equal(stream.status().warmStreams,1);
  assert.equal(stream.status().bootstrapCalls,0);
  assert.equal(received,21);
  assert.equal(stream.isFresh(),true);
  stream.stop();
  assert.equal(stream.isFresh(),false);
});

test("a single optional REST seed warms the candidate; every later confirmation uses fresher WS bars",async t=>{
  let clock=BASE+30_000,calls=0,last:Candle[]=[];
  let resume!: (bars:Candle[])=>void;
  const market:any={
    status:()=>({}),
    weightStatus:()=>({used:100,observedAt:clock}),
    getCandles:async(_exchange:string,symbol:string,tf:string,limit:number)=>{
      calls++;
      assert.equal(symbol,"BTCUSDT");assert.equal(tf,"1m");assert.equal(limit,31);
      return new Promise<Candle[]>(resolve=>{resume=resolve;});
    },
  };
  const {stream,socket}=fixture(market,()=>clock,(_symbol,bars)=>{last=bars;});
  t.after(()=>stream.stop());
  assert.equal(stream.watch("BTCUSDT"),true);
  assert.equal(calls,1);
  socket.emit("message",{data:JSON.stringify(bar("BTCUSDT",clock,101.1,500))});
  const history=Array.from({length:31},(_,i)=>({
    time:BASE-(30-i)*60_000,open:100,high:100.1,
    low:99.9,close:100,volume:100,
  }));
  resume(history);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stream.status().warmStreams,1);
  assert.equal(stream.status().bootstrapSuccess,1);
  assert.equal(last.at(-1)?.close,101.1,"WS must win over stale REST current candle");
  for(let i=0;i<10;i++){
    clock+=1000;
    socket.emit("message",{data:JSON.stringify(bar("BTCUSDT",clock,101.2,500))});
  }
  assert.equal(calls,1,"repeat updates must never trigger more per-candle REST");
  assert.ok(stream.status().wsCandleEvents>=11);
});

test("disconnect clears kline baseline and fails closed, never retains stale candles",t=>{
  let clock=BASE+30_000;
  const market:any={
    status:()=>({binance:clock+60_000}),
    weightStatus:()=>({used:1500,observedAt:clock}),
  };
  const {stream,socket}=fixture(market,()=>clock);
  t.after(()=>stream.stop());
  stream.watch("ETHUSDT");
  socket.emit("message",{data:JSON.stringify(bar("ETHUSDT",clock,101))});
  assert.equal(stream.isFresh(),true);
  socket.close();
  assert.equal(stream.isFresh(),false);
  assert.equal(stream.status().warmStreams,0);
});
