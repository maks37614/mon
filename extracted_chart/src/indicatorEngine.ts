export type IndicatorId='oi'|'netVolume'|'delta'|'rsi'|'atr'|'macd'|'stoch'|'obv'|'cmf'|'vr'|'momentum';
export type IndicatorCandle={t:number;o:number;h:number;l:number;c:number;v:number;n:number;tb?:number};
export type OIPoint={t:number;v:number};
export type SeriesPoint={t:number;v:number};
export type MultiSeries={series:{name:string;values:SeriesPoint[];kind?:'line'|'bar'}[];guides?:number[];format?:'price'|'percent'|'compact'|'ratio'|'usd'};

const safe=(n:number)=>Number.isFinite(n)?n:0;
const ema=(a:number[],p:number)=>{const out=new Array(a.length).fill(NaN);if(!a.length)return out;const k=2/(Math.max(1,p)+1);let e=a[0];out[0]=e;for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);out[i]=e}return out};
const sma=(a:number[],p:number,i:number)=>{const s=Math.max(0,i-p+1),r=a.slice(s,i+1).filter(Number.isFinite);return r.length?r.reduce((x,y)=>x+y,0)/r.length:NaN};
export const trueRanges=(c:IndicatorCandle[])=>c.map((z,i)=>i?Math.max(z.h-z.l,Math.abs(z.h-c[i-1].c),Math.abs(z.l-c[i-1].c)):z.h-z.l);
export const atrSeries=(c:IndicatorCandle[],period=14)=>{const tr=trueRanges(c),out:number[]=new Array(c.length).fill(NaN);let a=0;for(let i=0;i<c.length;i++){if(i<period){a+=tr[i];if(i===period-1){a/=period;out[i]=a}}else{a=(a*(period-1)+tr[i])/period;out[i]=a}}return out};
export const rsiSeries=(c:IndicatorCandle[],period=14)=>{const out=new Array(c.length).fill(NaN);if(c.length<2)return out;let gain=0,loss=0;for(let i=1;i<c.length;i++){const d=c[i].c-c[i-1].c,g=Math.max(0,d),l=Math.max(0,-d);if(i<=period){gain+=g;loss+=l;if(i===period){gain/=period;loss/=period;out[i]=loss===0?100:100-100/(1+gain/l)}}else{gain=(gain*(period-1)+g)/period;loss=(loss*(period-1)+l)/period;out[i]=loss===0?100:100-100/(1+gain/l)}}return out};
export const macdSeries=(c:IndicatorCandle[],fast=12,slow=26,signal=9)=>{const close=c.map(x=>x.c),ef=ema(close,fast),es=ema(close,slow),m=close.map((_,i)=>ef[i]-es[i]),sig=ema(m,signal),hist=m.map((x,i)=>x-sig[i]);return{m,sig,hist}};
export const stochasticSeries=(c:IndicatorCandle[],period=14,smooth=3)=>{const k=new Array(c.length).fill(NaN);for(let i=0;i<c.length;i++){const s=Math.max(0,i-period+1),rows=c.slice(s,i+1),hi=Math.max(...rows.map(x=>x.h)),lo=Math.min(...rows.map(x=>x.l));k[i]=hi===lo?50:(c[i].c-lo)/(hi-lo)*100}const d=k.map((_,i)=>sma(k,smooth,i));return{k,d}};
export const obvSeries=(c:IndicatorCandle[])=>{let x=0;return c.map((z,i)=>{if(i){if(z.c>c[i-1].c)x+=z.v;else if(z.c<c[i-1].c)x-=z.v}return x})};
export const cmfSeries=(c:IndicatorCandle[],period=20)=>{const mfv=c.map(z=>{const r=z.h-z.l;return r?(((z.c-z.l)-(z.h-z.c))/r)*z.v:0});return c.map((_,i)=>{const s=Math.max(0,i-period+1),vol=c.slice(s,i+1).reduce((a,x)=>a+x.v,0),flow=mfv.slice(s,i+1).reduce((a,x)=>a+x,0);return vol?flow/vol:0})};
export const vrSeries=(c:IndicatorCandle[],period=20)=>c.map((z,i)=>{const s=Math.max(0,i-period),base=c.slice(s,i).map(x=>x.v),avg=base.length?base.reduce((a,x)=>a+x,0)/base.length:0;return avg?z.v/avg:1});
export const momentumSeries=(c:IndicatorCandle[],period=10)=>c.map((z,i)=>i>=period?(z.c/c[i-period].c-1)*100:NaN);
// Net Volume is a candle-direction signed volume measure. Delta uses aggressive taker volume when available.
export const netVolumeSeries=(c:IndicatorCandle[])=>c.map(z=>z.v*(z.c>z.o?1:z.c<z.o?-1:0));
export const deltaSeries=(c:IndicatorCandle[])=>c.map(z=>{if(Number.isFinite(z.tb))return 2*(z.tb||0)-z.v;const range=Math.max(1e-12,z.h-z.l),body=Math.max(-1,Math.min(1,(z.c-z.o)/range));return z.v*body});
const points=(c:IndicatorCandle[],a:number[])=>c.map((z,i)=>({t:z.t,v:a[i]})).filter(x=>Number.isFinite(x.v));
const cleanOi=(a:OIPoint[])=>a.filter(x=>Number.isFinite(x.t)&&Number.isFinite(x.v)&&x.v>0).sort((x,y)=>x.t-y.t);
const totalOi=(a:OIPoint[],b:OIPoint[])=>{const aa=cleanOi(a),bb=cleanOi(b),times=Array.from(new Set([...aa.map(x=>x.t),...bb.map(x=>x.t)])).sort((x,y)=>x-y);let ia=0,ib=0,lastA=NaN,lastB=NaN;const out:OIPoint[]=[];for(const t of times){while(ia<aa.length&&aa[ia].t<=t){lastA=aa[ia].v;ia++}while(ib<bb.length&&bb[ib].t<=t){lastB=bb[ib].v;ib++}if(Number.isFinite(lastA)&&Number.isFinite(lastB))out.push({t,v:lastA+lastB})}return out};
export function indicatorData(id:IndicatorId,c:IndicatorCandle[],oi:{binance:OIPoint[];bybit:OIPoint[]}):MultiSeries{
 if(id==='oi'){const binance=cleanOi(oi.binance),bybit=cleanOi(oi.bybit),total=totalOi(binance,bybit);return{series:[{name:'Σ',values:total},{name:'BIN',values:binance},{name:'BYB',values:bybit}].filter(x=>x.values.length),format:'usd'}};
 if(id==='netVolume')return{series:[{name:'Net',values:points(c,netVolumeSeries(c)),kind:'bar'}],guides:[0],format:'compact'};
 if(id==='delta')return{series:[{name:'Delta',values:points(c,deltaSeries(c)),kind:'bar'}],guides:[0],format:'compact'};
 if(id==='rsi')return{series:[{name:'RSI',values:points(c,rsiSeries(c))}],guides:[30,50,70],format:'ratio'};
 if(id==='atr')return{series:[{name:'ATR',values:points(c,atrSeries(c))}],format:'price'};
 if(id==='macd'){const z=macdSeries(c);return{series:[{name:'MACD',values:points(c,z.m)},{name:'Signal',values:points(c,z.sig)},{name:'Hist',values:points(c,z.hist),kind:'bar'}],guides:[0],format:'price'}}
 if(id==='stoch'){const z=stochasticSeries(c);return{series:[{name:'%K',values:points(c,z.k)},{name:'%D',values:points(c,z.d)}],guides:[20,80],format:'ratio'}}
 if(id==='obv')return{series:[{name:'OBV',values:points(c,obvSeries(c))}],format:'compact'};
 if(id==='cmf')return{series:[{name:'CMF',values:points(c,cmfSeries(c))}],guides:[0],format:'ratio'};
 if(id==='vr')return{series:[{name:'VR',values:points(c,vrSeries(c)),kind:'bar'}],guides:[1],format:'ratio'};
 return{series:[{name:'MOM',values:points(c,momentumSeries(c))}],guides:[0],format:'percent'};
}
export const INDICATOR_META:{id:IndicatorId;name:string;short:string;description:string}[]=[
 {id:'oi',name:'Open Interest',short:'OI',description:'LIVE OI Binance + Bybit · реальні суми USD, автооновлення'},
 {id:'netVolume',name:'Чистый объём',short:'NV',description:'Направленный объём свечей'},
 {id:'delta',name:'Delta',short:'Δ',description:'Агрессивные покупки минус продажи'},
 {id:'rsi',name:'RSI',short:'RSI',description:'Relative Strength Index · 14'},
 {id:'atr',name:'ATR',short:'ATR',description:'Average True Range · 14'},
 {id:'macd',name:'MACD',short:'MACD',description:'12 / 26 / 9'},
 {id:'stoch',name:'Stochastic',short:'STO',description:'%K / %D · 14 / 3'},
 {id:'obv',name:'OBV',short:'OBV',description:'On Balance Volume'},
 {id:'cmf',name:'CMF',short:'CMF',description:'Chaikin Money Flow · 20'},
 {id:'vr',name:'Volume Ratio',short:'VR',description:'Объём к среднему · 20'},
 {id:'momentum',name:'Momentum',short:'MOM',description:'Изменение цены · 10 свечей'}
];
