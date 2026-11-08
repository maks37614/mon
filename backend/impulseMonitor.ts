/** Low-load real-time impulse discovery across ALL active Binance USDT perpetual markets.
 * The all-market ticker websocket is a *candidate filter*. A bounded set of
 * Binance 1m kline WebSocket subscriptions confirms volume and breakouts; a
 * heavily rate-limited REST history seed is optional and used once per symbol.
 * Never sends orders or touches h00k.top.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { MarketData } from "./market";
import { SelectiveKlineStreams, type KlineSocketFactory } from "./impulseKlines";
import { FORMATION_ANALYSIS_VERSION, type Candle, type Signal } from "./config";

export const IMPULSE_STREAM_URL = "wss://fstream.binance.com/market/ws/!ticker@arr";
const SYMBOL = /^[A-Z0-9]{3,30}USDT$/;
const LOOKBACK_MS = 30_000;
const TICKER_MOVE_PCT = 0.55;
const CANDLE_MOVE_PCT = 0.8;
const MIN_QUOTE_24H = 0;
const MAX_QUEUE = 30;
const MAX_CANDIDATE_AGE = 15_000;
const MAX_HISTORY = 42;
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
  if (candles.length < 21 || now-candidate.at>15_000) return null;
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

/** Best-effort diagnostics, never used to admit a trading signal. */
export function explainImpulseRejection(candidate:ImpulseCandidate,candles:Candle[],now:number):string {
  if(candles.length<21) return "Недостатньо 1m свічок Binance";
  if(now-candidate.at>15_000)return "Кандидат застарів до підтвердження";
  const current=candles.at(-1)!;
  if(!Number.isFinite(current.time) || now-current.time<10_000 || now-current.time>65_000)
    return "Поточна 1m свічка надто рання або застаріла";
  const previous=candles.slice(-21,-1);
  if(previous.length!==20)return "Недостатньо історії 20m";
  const changePct=(current.close/current.open-1)*100;
  if(!Number.isFinite(changePct) || Math.abs(changePct)<CANDLE_MOVE_PCT ||
      (changePct>0?"LONG":"SHORT")!==candidate.direction)
    return "Рух поточної 1m свічки <0,8% або інший напрямок";
  const volume=previous.reduce((sum,c)=>sum+c.volume,0)/20;
  const fraction=Math.max(0.25,Math.min(1,(now-current.time)/60_000));
  if(!(volume>0) || current.volume/(volume*fraction)<2.5)
    return "Обсяг не перевищив нормальний темп у 2,5 раза";
  const high=Math.max(...previous.map(c=>c.high));
  const low=Math.min(...previous.map(c=>c.low));
  if(candidate.direction==="LONG"?current.close<=high:current.close>=low)
    return "Немає пробою діапазону попередніх 20 хвилин";
  return "Не пройдено одну з перевірок валідності ринкових даних";
}

type Socket = Pick<WebSocket,"addEventListener"|"close"|"readyState">;
export class ImpulseMonitor {
  private socket:Socket|null=null;
  private klines:SelectiveKlineStreams;
  private keepRunning=false;
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  private watchdog:ReturnType<typeof setInterval>|null=null;
  private marketRefresh:ReturnType<typeof setInterval>|null=null;
  private markets=new Set<string>();
  private priceHistory=new Map<string,TickerPoint[]>();
  private lastTicker=new Map<string,number>();
  private pending=new Map<string,ImpulseCandidate>();
  private checked=new Map<string,number>();
  private lastRejectedAt=new Map<string,number>();
  private lastMessage=0;
  private connectedAt=0;
  private reconnectAttempts=0;
  private state:"stopped"|"connecting"|"live"|"reconnecting"="stopped";
  private lastError:string|null=null;
  private found=0;
  private candidates=0;
  private checkedCandles=0;
  private rejected=0;
  private lastRejection:string|null=null;
  private logAt=0;

  constructor(
    private store:Store,
    private market:MarketData,
    private socketFactory:(url:string)=>Socket = url=>new WebSocket(url),
    private now:()=>number = Date.now,
    klineFactory?:KlineSocketFactory,
  ){
    this.klines=new SelectiveKlineStreams(
      market,(symbol,candles)=>this.onCandles(symbol,candles),
      klineFactory,now,
    );
  }

  /** Both the all-market ticker and the kline stream must be fresh. */
  isFresh():boolean {
    return this.keepRunning && this.isTickerFresh() && this.klines.isFresh();
  }
  private isTickerFresh():boolean {
    return this.state==="live" && this.lastMessage>0 &&
      this.now()-this.lastMessage<10_000;
  }
  status(){
    const k=this.klines.status();
    return {
      state:this.state,source:"Binance USDT perpetual live",
      transport:"WebSocket !ticker@arr + candidate-only @kline_1m; optional paced REST history seed",
      markets:this.markets.size,tracked:this.priceHistory.size,
      queue:this.pending.size,found:this.found,lastMessage:this.lastMessage||null,
      candidates:this.candidates,checkedCandles:this.checkedCandles,
      rejected:this.rejected,ratePaused:k.bootstrapDeferred,
      lastRejection:this.lastRejection,
      klineStatus:k,
      binanceWeight:this.market.weightStatus?.()||null,
      error:this.lastError||k.lastError,
    };
  }
  async start(){
    if(this.keepRunning)return;
    this.keepRunning=true;
    this.state="connecting";
    this.store.set("signals",[]);
    try{await this.refreshMarkets();}
    catch(e:any){
      this.lastError=String(e.message||e);
      this.log("Не вдалося отримати Binance Futures markets: "+this.lastError);
    }
    if(!this.keepRunning)return;
    this.klines.start();
    this.connect();
    this.watchdog=setInterval(()=>{
      const t=this.now();
      if((this.state==="live" && t-this.lastMessage>MONITOR_TIMEOUT_MS) ||
         (this.state==="connecting" && t-this.connectedAt>MONITOR_TIMEOUT_MS)){
        this.log("Binance ticker WebSocket замовк, перепідключення");
        this.reconnect();
      }
      this.prune(t);
    },5_000);
    this.marketRefresh=setInterval(()=>void this.refreshMarkets().catch(e=>{
      this.lastError=String(e.message||e);
    }),60*60_000);
    this.watchdog.unref?.();this.marketRefresh.unref?.();
  }
  stop(){
    this.keepRunning=false;this.state="stopped";
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    if(this.watchdog)clearInterval(this.watchdog);
    if(this.marketRefresh)clearInterval(this.marketRefresh);
    const socket=this.socket;this.socket=null;
    socket?.close();
    this.klines.stop();
    this.pending.clear();this.priceHistory.clear();this.lastTicker.clear();
  }
  private log(message:string){
    if(this.now()-this.logAt<60_000)return;
    this.logAt=this.now();
    this.store.log("WARN",message.slice(0,180));
  }
  private prune(time:number){
    for(const [sym,c] of this.pending)
      if(time-c.at>MAX_CANDIDATE_AGE)this.pending.delete(sym);
    for(const [key,at] of this.checked)
      if(time-at>120_000)this.checked.delete(key);
    for(const [key,at] of this.lastRejectedAt)
      if(time-at>120_000)this.lastRejectedAt.delete(key);
  }
  private async refreshMarkets(){
    const markets=await this.market.getMarkets("binance");
    const next=new Set(markets.map(m=>m.symbol).filter(s=>SYMBOL.test(s)));
    if(!next.size)throw new Error("Binance Futures: no active USDT perpetual contracts");
    this.markets=next;
    for(const symbol of this.priceHistory.keys())
      if(!next.has(symbol))this.priceHistory.delete(symbol);
    for(const symbol of this.pending.keys())
      if(!next.has(symbol))this.pending.delete(symbol);
  }
  private reconnect(){
    if(!this.keepRunning || this.reconnectTimer)return;
    this.state="reconnecting";
    this.pending.clear();this.priceHistory.clear();this.lastTicker.clear();
    this.lastMessage=0;
    const previous=this.socket;this.socket=null;
    previous?.close();
    const delay=Math.min(60_000,1000*2**Math.min(this.reconnectAttempts++,6));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      if(this.keepRunning)this.connect();
    },delay);
    this.reconnectTimer.unref?.();
  }
  private connect(){
    if(!this.keepRunning)return;
    this.state="connecting";this.connectedAt=this.now();
    let socket:Socket;
    try{socket=this.socketFactory(IMPULSE_STREAM_URL);}
    catch(e:any){this.lastError=String(e.message||e);this.reconnect();return;}
    this.socket=socket;
    socket.addEventListener("open",()=>{
      if(this.socket===socket){this.state="connecting";this.lastError=null;}
    });
    socket.addEventListener("message",(event:any)=>{
      if(!this.keepRunning || this.socket!==socket)return;
      try{
        const rows=JSON.parse(String(event.data));
        const payload=Array.isArray(rows)?rows:rows?.data;
        if(!Array.isArray(payload))return;
        const time=this.now();
        let seen=false;
        for(const ticker of payload){
          const symbol=ticker?.s;
          if(!this.markets.has(symbol) || ticker?.st===2 ||
            (ticker?.st!=null && ticker.st!==1) ||
            !Number.isFinite(ticker?.E) || Math.abs(time-ticker.E)>10_000)continue;
          const price=Number(ticker.c);
          if(!Number.isFinite(price)||price<=0)continue;
          if((this.lastTicker.get(symbol)||0)>=ticker.E)continue;
          this.lastTicker.set(symbol,ticker.E);
          const history=this.priceHistory.get(symbol)||[];
          while(history.length && history[0].at<ticker.E-LOOKBACK_MS)
            history.shift();
          const candidate=impulseTickerCandidate(ticker,history,true,time);
          history.push({at:ticker.E,price});
          while(history.length>MAX_HISTORY)history.shift();
          this.priceHistory.set(symbol,history);
          if(candidate){
            const key=symbol+":"+Math.floor(candidate.at/60_000)+":"+candidate.direction;
            if(!this.checked.has(key)){
              const existing=this.pending.get(symbol);
              if(existing){
                // Preserve the strongest candidate but keep event time fresh.
                this.pending.set(symbol,{
                  ...candidate,
                  changePct:Math.abs(candidate.changePct)>Math.abs(existing.changePct)?
                    candidate.changePct:existing.changePct,
                });
              }else if(this.pending.size<MAX_QUEUE && this.klines.watch(symbol)){
                this.pending.set(symbol,candidate);
                this.candidates++;
              }
            }
          }
          seen=true;
        }
        if(seen){
          this.lastMessage=time;
          this.reconnectAttempts=0;
          this.state="live";
          this.lastError=null;
          this.prune(time);
        }
      }catch{/* Bad ticker payloads are never signal events. */}
    });
    socket.addEventListener("error",()=>{if(this.socket===socket)this.reconnect();});
    socket.addEventListener("close",()=>{if(this.socket===socket)this.reconnect();});
  }

  /** Only a *real* kline frame (or recent WS bar + historical seed) can confirm. */
  private onCandles(symbol:string,candles:Candle[]){
    if(!this.keepRunning || !this.isTickerFresh())return;
    const candidate=this.pending.get(symbol);
    if(!candidate)return;
    const time=this.now();
    if(time-candidate.at>MAX_CANDIDATE_AGE){
      this.pending.delete(symbol);return;
    }
    if(!this.klines.isFresh())return;
    if(time%60_000<10_000 || candles.length<21)return;
    const key=symbol+":"+Math.floor(candidate.at/60_000)+":"+candidate.direction;
    if(this.checked.has(key))return;
    this.checkedCandles++;
    const signal=confirmImpulse(candidate,candles,time);
    if(!signal){
      // Do not count the same 250ms candle 4 times per second as 4 rejects.
      const last=this.lastRejectedAt.get(key)||0;
      if(time-last>=5_000){
        this.lastRejectedAt.set(key,time);
        this.rejected++;
        this.lastRejection=explainImpulseRejection(candidate,candles,time);
      }
      return;
    }
    this.checked.set(key,time);
    this.pending.delete(symbol);
    const settings=this.store.get<any>("settings",{});
    signal.stopLoss=signal.entryPrice*(1-
      (signal.direction==="LONG"?1:-1)*(settings.stopLossPercent||0.25)/100);
    signal.takeProfit=signal.entryPrice*(1+
      (signal.direction==="LONG"?1:-1)*(settings.takeProfitPercent||0.45)/100);
    const old=this.store.get<Signal[]>("signals",[]);
    this.store.set("signals",[
      signal,...old.filter(item=>item.id!==signal.id &&
        time-item.candleAt<=180_000 && item.formation==="Impulse Breakout"),
    ].slice(0,100));
    this.found++;
    this.store.log("INFO",symbol+" "+signal.direction+" імпульс (1m WS): "+signal.description);
  }
}
