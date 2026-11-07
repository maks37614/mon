/** Low-load real-time impulse discovery across ALL active Binance USDT perpetual markets.
 * The all-market ticker websocket is a *candidate filter*; real Binance 1m candles
 * are checked for breakout and live volume BEFORE a signal is published.
 * Never sends orders or touches h00k.top.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { MarketData } from "./market";
import { FORMATION_ANALYSIS_VERSION, type Candle, type Signal } from "./config";

export const IMPULSE_STREAM_URL = "wss://fstream.binance.com/market/ws/!ticker@arr";
const SYMBOL = /^[A-Z0-9]{3,30}USDT$/;
const LOOKBACK_MS = 30_000;
const TICKER_MOVE_PCT = 0.55;
const CANDLE_MOVE_PCT = 0.8;
const MIN_QUOTE_24H = 0;
const MAX_QUEUE = 30;
const MAX_HISTORY = 42;
const VERIFY_INTERVAL_MS = 1_800;
const MONITOR_TIMEOUT_MS = 20_000;

export type ImpulseCandidate = {symbol:string; direction:"LONG"|"SHORT"; changePct:number; price:number; at:number};
export type TickerPoint = {at:number; price:number};
export type BinanceTicker = {s?:string; c?:string; q?:string; st?:number; E?:number; e?:string};

export function impulseTickerCandidate(
  ticker: BinanceTicker, history: TickerPoint[], allowed: boolean, now:number
): ImpulseCandidate | null {
  if (!allowed || ticker.st === 2 || (ticker.st != null && ticker.st !== 1) ||
    typeof ticker.s !== "string" || !SYMBOL.test(ticker.s) ||
    !Number.isFinite(ticker.E) || Math.abs(now - ticker.E!) > 10_000) return null;
  const price=Number(ticker.c), quote=Number(ticker.q);
  if (!Number.isFinite(price) || price<=0 || !Number.isFinite(quote) || quote <= MIN_QUOTE_24H) return null;
  const first=history.find(p=>p.at <= ticker.E! - 15_000);
  if (!first || first.price<=0) return null;
  const changePct=(price/first.price-1)*100;
  if(Math.abs(changePct)<TICKER_MOVE_PCT) return null;
  return {symbol:ticker.s,direction:changePct>0?"LONG":"SHORT",changePct,price,at:ticker.E!};
}

export function confirmImpulse(
  candidate: ImpulseCandidate, candles:Candle[], now:number
): Signal | null {
  if (candles.length < 31 || now-candidate.at>15_000) return null;
  const current=candles.at(-1)!;
  const previous=candles.slice(-21,-1);
  if(previous.length!==20 || previous.some((c,i)=>c.volume<0 ||
      !Number.isFinite(c.volume) || (i>0 && c.time-previous[i-1].time!==60_000))) return null;
  if(!Number.isFinite(current.time) || now-current.time<10_000 || now-current.time>65_000 ||
     current.open<=0 || current.close<=0 || current.high<current.low || current.volume<=0) return null;
  if(Math.abs(candidate.price/current.close-1)>0.006) return null;
  const move=(current.close/current.open-1)*100;
  const direction=move>0?"LONG":"SHORT";
  if(direction!==candidate.direction || Math.abs(move)<CANDLE_MOVE_PCT) return null;
  const avgVolume=previous.reduce((sum,c)=>sum+c.volume,0)/previous.length;
  if(avgVolume<=0) return null;
  const fraction=Math.max(0.25,Math.min(1,(now-current.time)/60_000));
  const ratio=current.volume/(avgVolume*fraction);
  if(ratio<2.5) return null;
  const high=Math.max(...previous.map(c=>c.high));
  const low=Math.min(...previous.map(c=>c.low));
  const breakout=direction==="LONG" ? current.close>high : current.close<low;
  if(!breakout) return null;
  const confidence=Math.min(100,Math.round(75+
    Math.min(12,(Math.abs(move)-CANDLE_MOVE_PCT)*8)+
    Math.min(13,(ratio-2.5)*5)));
  const scoreParts={structure:Math.min(60,Math.round(48+Math.min(12,(Math.abs(move)-CANDLE_MOVE_PCT)*8))),
    breakout:25,volume:Math.min(15,Math.round(9+Math.min(6,(ratio-2.5)*3)))};
  const sign=direction==="LONG"?1:-1;
  const id=createHash("sha256").update("impulse:binance:"+candidate.symbol+":"+current.time+":"+direction)
    .digest("hex").slice(0,24);
  const settingsTime=now;
  return {
    id,exchange:"binance",symbol:candidate.symbol,timeframe:"1m",
    formation:"Impulse Breakout",direction,entryPrice:current.close,currentPrice:current.close,
    stopLoss:current.close*(1-sign*0.25/100),
    takeProfit:current.close*(1+sign*0.45/100),
    confidence,scoreParts,analysisVersion:FORMATION_ANALYSIS_VERSION,
    status:"confirmed",candleAt:settingsTime,detectedAt:now,
    description:"Імпульс поточної 1m свічки: "+move.toFixed(2)+"%; обсяг "+ratio.toFixed(1)+
      "× від середнього темпу за 20 попередніх хвилин; пробій 20m діапазону. Угода симулюється.",
  };
}

type Socket = Pick<WebSocket,"addEventListener"|"close"|"readyState">;
export class ImpulseMonitor {
  private socket:Socket | null=null;
  private keepRunning=false;
  private reconnectTimer:ReturnType<typeof setTimeout> | null=null;
  private watchdog:ReturnType<typeof setInterval> | null=null;
  private verifyTimer:ReturnType<typeof setInterval> | null=null;
  private marketRefresh:ReturnType<typeof setInterval> | null=null;
  private markets=new Set<string>();
  private priceHistory=new Map<string,TickerPoint[]>();
  private checked=new Map<string,number>();
  private lastTicker=new Map<string,number>();
  private queue:ImpulseCandidate[]=[];
  private queued=new Set<string>();
  private verifying=false;
  private lastVerify=0;
  private lastMessage=0;
  private reconnectAttempts=0;
  private state:"stopped"|"connecting"|"live"|"reconnecting"="stopped";
  private lastError:string | null=null;
  private found=0;
  private logAt=0;
  constructor(
    private store:Store,
    private market:MarketData,
    private socketFactory:(url:string)=>Socket = url=>new WebSocket(url),
    private now:()=>number = Date.now,
  ) {}
  isFresh():boolean {
    return this.keepRunning && this.state==="live" && this.lastMessage>0 &&
      this.now()-this.lastMessage<10_000;
  }
  status() {
    return {state:this.state,source:"Binance USDT perpetual live",
      transport:"WebSocket !ticker@arr + Binance 1m REST confirmation",
      markets:this.markets.size,tracked:this.priceHistory.size,
      queue:this.queue.length,found:this.found,lastMessage:this.lastMessage||null,
      error:this.lastError};
  }
  async start() {
    if(this.keepRunning)return;
    this.keepRunning=true;
    this.state="connecting";
    this.store.set("signals",[]);
    try {await this.refreshMarkets();}
    catch(e:any){this.lastError=String(e.message||e);this.log("Не вдалося отримати Binance Futures markets: "+this.lastError);}
    if(!this.keepRunning)return;
    this.connect();
    this.watchdog=setInterval(()=>{
      if(this.state==="live" && this.now()-this.lastMessage>MONITOR_TIMEOUT_MS) {
        this.log("Binance WebSocket не отримує оновлень; перепідключення");
        this.socket?.close();
        this.reconnect();
      }
    },5_000);
    this.verifyTimer=setInterval(()=>void this.verifyNext(),500);
    this.marketRefresh=setInterval(()=>void this.refreshMarkets().catch(e=>{
      this.lastError=String(e.message||e);
    }),60*60_000);
    this.watchdog.unref?.(); this.verifyTimer.unref?.(); this.marketRefresh.unref?.();
  }
  stop() {
    this.keepRunning=false;this.state="stopped";
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    if(this.watchdog)clearInterval(this.watchdog);
    if(this.verifyTimer)clearInterval(this.verifyTimer);
    if(this.marketRefresh)clearInterval(this.marketRefresh);
    this.socket?.close();this.socket=null;
    this.queue=[];this.queued.clear();this.priceHistory.clear();
  }
  private log(message:string){
    if(this.now()-this.logAt<60_000)return;
    this.logAt=this.now();
    this.store.log("WARN",message.slice(0,160));
  }
  private async refreshMarkets() {
    const markets=await this.market.getMarkets("binance");
    const next=new Set(markets.map(m=>m.symbol).filter(s=>SYMBOL.test(s)));
    if(next.size===0)throw new Error("Binance Futures: no active USDT perpetual contracts");
    this.markets=next;
    for(const symbol of this.priceHistory.keys())if(!next.has(symbol))this.priceHistory.delete(symbol);
  }
  private reconnect(){
    if(!this.keepRunning || this.reconnectTimer)return;
    this.state="reconnecting";
    this.queue=[];this.queued.clear();this.priceHistory.clear();
    this.socket?.close();this.socket=null;
    const delay=Math.min(60_000,1_000*2**Math.min(this.reconnectAttempts++,6));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      if(this.keepRunning)this.connect();
    },delay);
    this.reconnectTimer.unref?.();
  }
  private connect(){
    if(!this.keepRunning)return;
    this.state="connecting";
    let sock:Socket;
    try{sock=this.socketFactory(IMPULSE_STREAM_URL);}
    catch(e:any){this.lastError=String(e.message||e);this.reconnect();return;}
    this.socket=sock;
    sock.addEventListener("open",()=>{
      if(this.socket===sock){this.state="connecting";this.lastError=null;}
    });
    sock.addEventListener("message",(event:any)=>{
      if(!this.keepRunning || this.socket!==sock)return;
      try{
        const rows=JSON.parse(String(event.data));
        const payload=Array.isArray(rows)?rows:rows?.data;
        if(!Array.isArray(payload))return;
        const now=this.now();
        let seen=false;
        for(const ticker of payload) {
          const symbol=ticker?.s;
          if(!this.markets.has(symbol) || ticker?.st===2 ||
            (ticker?.st!=null && ticker.st!==1) ||
            !Number.isFinite(ticker?.E) || Math.abs(now-ticker.E)>10_000) continue;
          const price=Number(ticker.c);
          if(!Number.isFinite(price) || price<=0)continue;
          if((this.lastTicker.get(symbol)||0)>=ticker.E)continue;
          this.lastTicker.set(symbol,ticker.E);
          const h=this.priceHistory.get(symbol)||[];
          while(h.length && h[0].at<ticker.E-LOOKBACK_MS)h.shift();
          const trigger=impulseTickerCandidate(ticker,h,true,now);
          h.push({at:ticker.E,price});
          while(h.length>MAX_HISTORY)h.shift();
          this.priceHistory.set(symbol,h);
          if(trigger && !this.queued.has(symbol) &&
             !this.checked.has(symbol+":"+Math.floor(ticker.E/60_000)) &&
             this.queue.length<MAX_QUEUE) {
            this.queue.push(trigger);this.queued.add(symbol);
          }
          seen=true;
        }
        if(seen){
          this.lastMessage=now;
          this.reconnectAttempts=0;
          this.state="live";
          this.lastError=null;
        }
      }catch{/* Invalid frames are not trade signals. */}
    });
    sock.addEventListener("error",()=>{if(this.socket===sock)this.reconnect();});
    sock.addEventListener("close",()=>{if(this.socket===sock)this.reconnect();});
  }
  private async verifyNext(){
    if(!this.keepRunning || this.state!=="live" || !this.markets.size ||
       this.verifying || this.now()-this.lastVerify<VERIFY_INTERVAL_MS ||
       !this.queue.length)return;
    const candidate=this.queue.shift()!;
    this.queued.delete(candidate.symbol);
    if(this.now()-candidate.at>12_000)return;
    const bucket=candidate.symbol+":"+Math.floor(candidate.at/60_000);
    if(this.checked.has(bucket))return;
    this.checked.set(bucket,this.now());
    if(this.checked.size>2_000)
      for(const [key,at] of this.checked)if(this.now()-at>120_000)this.checked.delete(key);
    this.lastVerify=this.now();
    this.verifying=true;
    try{
      const candles=await this.market.getCandles("binance",candidate.symbol,"1m",50,false);
      const signal=confirmImpulse(candidate,candles,this.now());
      if(!signal)return;
      const s=this.store.get<any>("settings",{});
      signal.stopLoss=signal.entryPrice*(1-(signal.direction==="LONG"?1:-1)*(s.stopLossPercent||0.25)/100);
      signal.takeProfit=signal.entryPrice*(1+(signal.direction==="LONG"?1:-1)*(s.takeProfitPercent||0.45)/100);
      const existing=this.store.get<Signal[]>("signals",[]);
      const next=[signal,...existing.filter(item=>item.id!==signal.id &&
        this.now()-item.candleAt<=180_000 && item.formation==="Impulse Breakout")].slice(0,100);
      this.store.set("signals",next);
      this.found++;
      this.store.log("INFO",candidate.symbol+" "+signal.direction+" імпульс: "+signal.description);
    }catch(e:any){
      this.lastError=String(e.message||e).slice(0,150);
      this.log("Помилка підтвердження імпульсу "+candidate.symbol+": "+this.lastError);
    }finally{this.verifying=false;}
  }
}
