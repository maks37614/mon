/** Candidate-only Binance 1m kline WebSocket pool.
 *
 * The public ticker monitors all symbols. Only a bounded set of candidate
 * symbols use kline streams. One OPTIONAL, heavily paced public REST call can
 * bootstrap 20m history; after that confirmation only reads actual kline WS
 * events. If the REST IP budget is busy, accumulate real 1m WS candles instead
 * of fabricating 20m history. No user API keys and no requests to h00k.top.
 */
import type { Candle } from "./config";
import type { MarketData } from "./market";

export const KLINE_STREAM_URL = "wss://fstream.binance.com/market/stream";
export const MAX_KLINE_STREAMS = 32;
const HISTORY_MINUTES = 21;
const REST_GAP_MS = 15_000;
const REST_RETRY_MS = 5 * 60_000;
// 31 recent 1m klines cost only ONE IP-weight unit (Binance docs).
// Permit up to four one-shot seeds/minute only with headroom under
// auto-mon local 1200 budget. All other bots on the IP keep priority.
const REST_USED_CEILING = 1_000;
const WATCH_TTL_MS = 25 * 60_000;
const MARKET_CANDLE_MS = 60_000;
const WS_FRESH_MS = 10_000;
const MAX_CONNECTING_MS = 20_000;
const SYMBOL = /^[A-Z0-9]{3,30}USDT$/;

type StreamSocket = Pick<WebSocket, "addEventListener" | "send" | "close" | "readyState">;
export type KlineSocketFactory = (url:string)=>StreamSocket;
type Tracked = {
  symbol: string;
  candles: Candle[];
  interestAt: number;
  eventAt: number;
  lastEventId: number;
  lastBootstrapAttempt: number;
  bootstrapPending: boolean;
  bootstrapped: boolean;
};

export function parseKlinePacket(payload: unknown, now: number):
  {symbol:string; candle:Candle; eventAt:number} | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, any>;
  const data = row.data;
  if (!data || typeof data !== "object" || data.e !== "kline") return null;
  const stream = row.stream;
  const symbol = data.s;
  const k = data.k;
  if (typeof symbol !== "string" || !SYMBOL.test(symbol) ||
    stream !== symbol.toLowerCase() + "@kline_1m" ||
    !k || k.s !== symbol || k.i !== "1m" ||
    !Number.isSafeInteger(data.E) || Math.abs(now - data.E) > 10_000 ||
    !Number.isSafeInteger(k.t) || k.t % MARKET_CANDLE_MS !== 0 ||
    k.t > now + 1_000 || now - k.t > 65_000) return null;
  const candle: Candle = {
    time: k.t,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
  };
  if (!Number.isFinite(candle.open) || candle.open <= 0 ||
    !Number.isFinite(candle.high) || !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) || candle.close <= 0 ||
    !Number.isFinite(candle.volume) || candle.volume < 0 ||
    candle.high < Math.max(candle.open, candle.close) ||
    candle.low > Math.min(candle.open, candle.close) ||
    candle.low < 0) return null;
  return {symbol,candle,eventAt:data.E};
}

function mergeCandles(previous:Candle[], incoming:Candle[]):Candle[] {
  const result = new Map<number,Candle>();
  for (const candle of [...previous,...incoming]) {
    if (!Number.isSafeInteger(candle.time) || candle.time%MARKET_CANDLE_MS!==0 ||
      !Number.isFinite(candle.close) || candle.close<=0 ||
      !Number.isFinite(candle.volume) || candle.volume<0) continue;
    result.set(candle.time,candle);
  }
  return [...result.values()].sort((a,b)=>a.time-b.time).slice(-HISTORY_MINUTES-12);
}

export class SelectiveKlineStreams {
  private running=false;
  private socket:StreamSocket | null=null;
  private state:"stopped"|"connecting"|"live"|"reconnecting"="stopped";
  private tracked = new Map<string,Tracked>();
  private reconnectTimer:ReturnType<typeof setTimeout> | null=null;
  private houseTimer:ReturnType<typeof setInterval> | null=null;
  private bootstrapTimer:ReturnType<typeof setInterval> | null=null;
  private controlTimer:ReturnType<typeof setInterval> | null=null;
  private addStreams=new Set<string>();
  private removeStreams=new Set<string>();
  private connectingSince=0;
  private attempts=0;
  private subscriptionId=1;
  private lastEventAt=0;
  private lastBootstrapAt=0;
  private bootstrapBusy=false;
  private bootstrapCalls=0;
  private bootstrapSuccess=0;
  private bootstrapDeferred=0;
  private wsEvents=0;
  private lastError:string|null=null;

  constructor(
    private market:MarketData,
    private onCandles:(symbol:string,candles:Candle[])=>void,
    private factory:(url:string)=>StreamSocket = url=>new WebSocket(url),
    private now:()=>number = Date.now,
  ) {}

  start() {
    if(this.running)return;
    this.running=true;
    this.connect();
    this.houseTimer=setInterval(()=>this.housekeeping(),5_000);
    this.bootstrapTimer=setInterval(()=>void this.bootstrapNext(),1_000);
    // Batch all subscription changes into <=2 control frames per second.
    // This is well under Binance's per-connection control-message limits.
    this.controlTimer=setInterval(()=>this.flushControls(),800);
    this.houseTimer.unref?.();
    this.bootstrapTimer.unref?.();
    this.controlTimer.unref?.();
  }

  stop(){
    this.running=false;this.state="stopped";
    if(this.houseTimer)clearInterval(this.houseTimer);
    if(this.bootstrapTimer)clearInterval(this.bootstrapTimer);
    if(this.controlTimer)clearInterval(this.controlTimer);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.houseTimer=null;this.bootstrapTimer=null;this.controlTimer=null;this.reconnectTimer=null;
    this.addStreams.clear();this.removeStreams.clear();
    const socket=this.socket;this.socket=null;
    socket?.close();
    this.tracked.clear();
    this.lastEventAt=0;
  }

  isFresh(){
    return this.running && this.state==="live" && this.lastEventAt>0 &&
      this.now()-this.lastEventAt<WS_FRESH_MS;
  }

  status(){
    const active=[...this.tracked.values()];
    return {
      state:this.state,
      activeStreams:active.length,
      warmStreams:active.filter(s=>hasBaseline(s.candles,this.now())).length,
      lastCandleAt:this.lastEventAt||null,
      wsCandleEvents:this.wsEvents,
      bootstrapCalls:this.bootstrapCalls,
      bootstrapSuccess:this.bootstrapSuccess,
      bootstrapDeferred:this.bootstrapDeferred,
      lastError:this.lastError,
    };
  }

  /** Subscribes a candidate or refreshes an already subscribed symbol. */
  watch(symbol:string):boolean {
    if(!this.running || !SYMBOL.test(symbol))return false;
    const existing=this.tracked.get(symbol);
    if(existing){existing.interestAt=this.now();return true;}
    if(this.tracked.size>=MAX_KLINE_STREAMS){
      const oldest=[...this.tracked.values()]
        .sort((a,b)=>a.interestAt-b.interestAt)[0];
      if(!oldest || this.now()-oldest.interestAt<15_000)return false;
      this.unwatch(oldest.symbol);
    }
    const record:Tracked={
      symbol,candles:[],interestAt:this.now(),eventAt:0,lastEventId:0,
      lastBootstrapAttempt:0,bootstrapPending:false,bootstrapped:false,
    };
    this.tracked.set(symbol,record);
    this.removeStreams.delete(symbol);
    this.addStreams.add(symbol);
    void this.bootstrapNext();
    return true;
  }

  /** Data never crosses a reconnect gap; fresh real candles must be received. */
  private connect(){
    if(!this.running)return;
    this.state="connecting";
    this.connectingSince=this.now();
    let socket:StreamSocket;
    try{socket=this.factory(KLINE_STREAM_URL);}
    catch(e:any){this.lastError=String(e.message||e);this.reconnect();return;}
    this.socket=socket;
    socket.addEventListener("open",()=>{
      if(!this.running || this.socket!==socket)return;
      this.state="live";this.attempts=0;this.lastError=null;
      this.removeStreams.clear();
      for(const symbol of this.tracked.keys())this.addStreams.add(symbol);
      this.flushControls();
    });
    socket.addEventListener("message",(event:any)=>{
      if(!this.running || this.socket!==socket)return;
      try{
        const raw=JSON.parse(String(event.data));
        if(raw?.id!=null){
          if(raw.result!==null && raw.result!==undefined)
            this.lastError="Binance kline subscription failed";
          return;
        }
        const frame=parseKlinePacket(raw,this.now());
        if(!frame)return;
        const slot=this.tracked.get(frame.symbol);
        if(!slot || frame.eventAt<=slot.lastEventId)return;
        // If a minute was missed, the resulting candle gap fails
        // confirmImpulse's continuity check. Never interpolate it.
        slot.lastEventId=frame.eventAt;
        slot.eventAt=this.now();
        slot.candles=mergeCandles(slot.candles,[frame.candle]);
        this.wsEvents++;
        this.lastEventAt=this.now();
        this.onCandles(frame.symbol,[...slot.candles]);
      }catch{/* Discard malformed frames; never create a trade from them. */}
    });
    socket.addEventListener("error",()=>{if(this.socket===socket)this.reconnect();});
    socket.addEventListener("close",()=>{if(this.socket===socket)this.reconnect();});
  }

  private reconnect(){
    if(!this.running || this.reconnectTimer)return;
    this.state="reconnecting";this.lastEventAt=0;
    this.addStreams.clear();this.removeStreams.clear();
    const old=this.socket;this.socket=null;
    old?.close();
    // Never use pre-reconnect bars with a silent gap.
    for(const slot of this.tracked.values()){
      slot.candles=[];slot.eventAt=0;slot.lastEventId=0;slot.bootstrapped=false;
      slot.lastBootstrapAttempt=0;
    }
    const delay=Math.min(60_000,1000 * 2**Math.min(this.attempts++,6));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      if(this.running)this.connect();
    },delay);
    this.reconnectTimer.unref?.();
  }

  private flushControls(){
    if(!this.socket || this.socket.readyState!==1 || this.state!=="live")return;
    if(this.removeStreams.size){
      const symbols=[...this.removeStreams];
      this.removeStreams.clear();
      this.sendControl("UNSUBSCRIBE",symbols);
    }else if(this.addStreams.size){
      const symbols=[...this.addStreams];
      this.addStreams.clear();
      this.sendControl("SUBSCRIBE",symbols);
    }
  }
  private sendControl(method:"SUBSCRIBE"|"UNSUBSCRIBE",symbols:string[]){
    const socket=this.socket;
    if(!socket || socket.readyState!==1 || this.state!=="live" || !symbols.length)return;
    try{
      socket.send(JSON.stringify({
        method,params:symbols.map(s=>s.toLowerCase()+"@kline_1m"),
        id:String(this.subscriptionId++),
      }));
    }catch(e:any){this.lastError=String(e.message||e).slice(0,140);this.reconnect();}
  }

  private unwatch(symbol:string){
    if(!this.tracked.delete(symbol))return;
    if(this.addStreams.delete(symbol))return; // Not sent yet.
    this.removeStreams.add(symbol);
  }

  private housekeeping(){
    if(!this.running)return;
    if(this.state==="connecting" && this.now()-this.connectingSince>MAX_CONNECTING_MS){
      this.lastError="Kline WebSocket не підключився";
      this.reconnect();
    }
    if(this.state==="live" && this.tracked.size>0 &&
       this.now()-Math.max(this.lastEventAt,this.connectingSince)>25_000){
      this.lastError="Kline WebSocket перестав надсилати свічки";
      this.reconnect();
    }
    for(const slot of this.tracked.values()){
      if(this.now()-slot.interestAt>WATCH_TTL_MS)this.unwatch(slot.symbol);
    }
  }

  private async bootstrapNext(){
    if(!this.running || this.state!=="live" || this.bootstrapBusy ||
       this.now()-this.lastBootstrapAt<REST_GAP_MS)return;
    const target=[...this.tracked.values()].find(slot=>
      !slot.bootstrapPending && !hasBaseline(slot.candles,this.now()) &&
      (slot.lastBootstrapAttempt===0 ||
       this.now()-slot.lastBootstrapAttempt>REST_RETRY_MS));
    if(!target)return;
    const pauses=this.market.status();
    const weight=this.market.weightStatus();
    const used=weight?.used;
    const ceiling=Number.isFinite(weight?.localBudget)
      ? Math.min(REST_USED_CEILING,weight.localBudget-150)
      : REST_USED_CEILING;
    if((pauses.binance||0)>this.now() ||
       (used != null && weight.observedAt != null &&
        this.now()-weight.observedAt<60_000 && used>=ceiling)){
      // Delayed, not silently dropped: keep collecting real WS candles.
      if(this.now()-this.lastBootstrapAt>=REST_GAP_MS) {
        this.bootstrapDeferred++;
        this.lastBootstrapAt=this.now();
      }
      return;
    }
    this.lastBootstrapAt=this.now();
    target.lastBootstrapAttempt=this.now();
    target.bootstrapPending=true;
    this.bootstrapBusy=true;
    this.bootstrapCalls++;
    try{
      const rest=await this.market.getCandles("binance",target.symbol,"1m",31,false);
      if(!this.running || this.tracked.get(target.symbol)!==target)return;
      // WS data must win over a delayed REST snapshot of the current candle.
      target.candles=mergeCandles(rest,target.candles);
      target.bootstrapped=hasBaseline(target.candles,this.now());
      if(target.bootstrapped)this.bootstrapSuccess++;
      if(target.eventAt>0 && this.now()-target.eventAt<WS_FRESH_MS)
        this.onCandles(target.symbol,[...target.candles]);
      this.lastError=null;
    }catch(e:any){
      this.lastError=String(e.message||e).slice(0,145);
      this.bootstrapDeferred++;
    }finally{
      target.bootstrapPending=false;
      this.bootstrapBusy=false;
    }
  }
}

function hasBaseline(candles:Candle[],now:number):boolean {
  if(candles.length<21)return false;
  const last=candles.at(-1)!;
  if(now-last.time>65_000 || last.time>now+1_000)return false;
  const twenty=candles.slice(-21,-1);
  return twenty.every((c,i)=>i===0 || c.time-twenty[i-1].time===MARKET_CANDLE_MS) &&
    last.time-twenty.at(-1)!.time===MARKET_CANDLE_MS;
}
