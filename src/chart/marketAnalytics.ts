export type Candle={t:number,o:number,h:number,l:number,c:number,v:number,n:number};
export type LevelTf='15m'|'1h'|'4h'|'1d';
export type AutoLevel={
  id:string;p:number;tf:LevelTf;kind:'SUPPORT'|'RESIST';score:number;
  firstTime:number;confirmedAt:number;lastTouch:number;visits:number;
  zoneLow:number;zoneHigh:number;broken:boolean;brokenAt:number|null;strength:number
};
export type LevelSettings={count:number;allowedDiffPct:number;historyDepth:number;breakPct:number;minSeparationBars:number;pivotBars:number;allowWickPenetration:boolean};
export type MarketPrint={id:string,side:'BUY'|'SELL',t:number,p:number,usd:number,count:number,touches:number,lastTouch:number,score:number};

export const median=(a:number[])=>{if(!a.length)return 0;const x=[...a].sort((m,n)=>m-n),i=Math.floor(x.length/2);return x.length%2?x[i]:(x[i-1]+x[i])/2};
export const quantile=(a:number[],q:number)=>{if(!a.length)return 0;const x=[...a].sort((m,n)=>m-n),pos=(x.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(pos-lo)};
export const robustThreshold=(values:number[],q=.965,madMult=5)=>{const v=values.filter(x=>Number.isFinite(x)&&x>0);if(v.length<12)return v.length?Math.max(quantile(v,.9),median(v)*3):0;const logs=v.map(x=>Math.log1p(x)),m=median(logs),mad=median(logs.map(x=>Math.abs(x-m)))||.01;const robust=Math.expm1(m+madMult*1.4826*mad);return Math.max(quantile(v,q),robust)};
export const atr=(c:Candle[],n=40)=>{const x=c.slice(-Math.max(2,n));if(x.length<2)return 0;let s=0,k=0;for(let i=1;i<x.length;i++){const p=x[i-1].c,z=x[i];s+=Math.max(z.h-z.l,Math.abs(z.h-p),Math.abs(z.l-p));k++}return k?s/k:0};
export const formatUsd=(n:number)=>{const a=Math.abs(n);if(a>=1e9)return `${(n/1e9).toFixed(a>=1e10?1:2)}B`;if(a>=1e6)return `${(n/1e6).toFixed(a>=1e7?1:2)}M`;if(a>=1e3)return `${(n/1e3).toFixed(a>=1e4?0:1)}K`;return n.toFixed(0)};

// Exact structural extrema. The ray price is NEVER averaged: p is the actual wick high/low.
type Candidate={p:number;t:number;i:number;kind:'SUPPORT'|'RESIST';prominence:number};
function structuralCandidates(c:Candle[],tf:LevelTf,pivotBars=15):Candidate[]{
  const out:Candidate[]=[];
  const span=Math.max(2,Math.min(6,Math.round(pivotBars/6)));
  const A=Math.max(atr(c,60),1e-12);
  for(let i=span;i<c.length-span;i++){
    const z=c[i],left=c.slice(i-span,i),right=c.slice(i+1,i+span+1);
    const leftHigh=Math.max(...left.map(x=>x.h)),rightHigh=Math.max(...right.map(x=>x.h));
    const leftLow=Math.min(...left.map(x=>x.l)),rightLow=Math.min(...right.map(x=>x.l));
    if(z.h>leftHigh&&z.h>=rightHigh){
      const base=Math.max(leftHigh,rightHigh),prom=Math.max(0,(z.h-base)/A);
      out.push({p:z.h,t:z.t,i,kind:'RESIST',prominence:prom});
    }
    if(z.l<leftLow&&z.l<=rightLow){
      const base=Math.min(leftLow,rightLow),prom=Math.max(0,(base-z.l)/A);
      out.push({p:z.l,t:z.t,i,kind:'SUPPORT',prominence:prom});
    }
  }
  return out;
}

function independentVisits(c:Candle[],candidate:Candidate,allowedDiffPct:number,minSeparationBars:number){
  const half=Math.max(candidate.p*allowedDiffPct/100,1e-12),zoneLow=candidate.p-half,zoneHigh=candidate.p+half;
  const visits:{i:number;t:number}[]=[];
  let inZone=false,outsideRun=minSeparationBars;
  for(let i=candidate.i;i<c.length;i++){
    const z=c[i],hit=candidate.kind==='RESIST'?z.h>=zoneLow&&z.l<=zoneHigh:z.l<=zoneHigh&&z.h>=zoneLow;
    if(hit){if(!inZone&&outsideRun>=minSeparationBars)visits.push({i,t:z.t});inZone=true;outsideRun=0}
    else{if(inZone)inZone=false;outsideRun++}
  }
  return{visits,zoneLow,zoneHigh};
}

export function deriveAutoLevels(c:Candle[],tf:LevelTf,settings?:Partial<LevelSettings>):AutoLevel[]{
  const cfg:LevelSettings={count:3,allowedDiffPct:.18,historyDepth:500,breakPct:.35,minSeparationBars:2,pivotBars:15,allowWickPenetration:true,...settings};
  const h=c.slice(-Math.max(80,Math.min(1500,cfg.historyDepth)));if(h.length<40)return[];
  const candidates=structuralCandidates(h,tf,cfg.pivotBars),last=h.at(-1)!.c,tfWeight=tf==='1d'?3:tf==='4h'?2:tf==='1h'?1:.7,out:AutoLevel[]=[];
  const barMs=tf==='1d'?86400000:tf==='4h'?14400000:tf==='1h'?3600000:900000;
  for(const candidate of candidates){
    const v=independentVisits(h,candidate,cfg.allowedDiffPct,cfg.minSeparationBars);if(v.visits.length<cfg.count)continue;
    const confirmed=v.visits[cfg.count-1],lastVisit=v.visits.at(-1)!;
    const breakFrac=Math.max(0,cfg.breakPct)/100;let broken=false,brokenAt:number|null=null,run=0;
    for(let i=confirmed.i+1;i<h.length;i++){
      const z=h[i],close=z.c;
      const beyond=cfg.allowWickPenetration?(candidate.kind==='SUPPORT'?close<candidate.p*(1-breakFrac):close>candidate.p*(1+breakFrac)):(candidate.kind==='SUPPORT'?z.l<candidate.p*(1-breakFrac):z.h>candidate.p*(1+breakFrac));
      run=beyond?run+1:0;if(run>=2){broken=true;brokenAt=h[i].t;break}
    }
    // Keep recently broken levels, like Watchlist's grey rays, but do not flood the chart with ancient breaks.
    if(broken&&brokenAt!==null){const recent=(h.at(-1)!.t-brokenAt)<=barMs*140,near=Math.abs(last-candidate.p)/Math.max(last,1e-12)<=.055;if(!recent&&!near)continue}
    const recency=Math.max(0,1-(h.at(-1)!.t-lastVisit.t)/(barMs*(tf==='1d'?180:tf==='4h'?150:120)));
    const lifeBars=Math.max(1,(lastVisit.t-candidate.t)/barMs);
    const testQuality=Math.min(1,Math.max(0,(v.visits.length-cfg.count+1)/4));
    const prominenceQuality=Math.min(1,candidate.prominence/2.2);
    const longevityQuality=Math.min(1,Math.log1p(lifeBars)/Math.log(tf==='1d'?140:tf==='4h'?180:220));
    const strength=Math.max(0,Math.min(100,Math.round(100*(
      .38*testQuality+.24*prominenceQuality+.20*recency+.18*longevityQuality
    )*(broken?.72:1))));
    const score=tfWeight*1.8+strength/18+(broken?-.8:.7);
    out.push({id:`${tf}:${candidate.kind}:${candidate.t}:${candidate.p}`,p:candidate.p,tf,kind:candidate.kind,score,firstTime:candidate.t,confirmedAt:confirmed.t,lastTouch:lastVisit.t,visits:v.visits.length,zoneLow:v.zoneLow,zoneHigh:v.zoneHigh,broken,brokenAt,strength});
  }
  // De-duplicate only genuinely overlapping candidates on the SAME TF/kind. Exact wick price of the winner is preserved.
  const picked:AutoLevel[]=[];
  for(const l of out.sort((a,b)=>(Number(a.broken)-Number(b.broken))||b.score-a.score)){
    const overlap=picked.some(x=>x.tf===l.tf&&x.kind===l.kind&&Math.abs(x.p-l.p)/Math.max(1e-12,l.p)*100<=cfg.allowedDiffPct*.72);
    if(!overlap)picked.push(l);
  }
  const active=picked.filter(x=>!x.broken).sort((a,b)=>b.score-a.score),broken=picked.filter(x=>x.broken).sort((a,b)=>(b.brokenAt||0)-(a.brokenAt||0));
  const cap=tf==='1d'?10:tf==='4h'?12:tf==='1h'?14:16;
  return [...active,...broken.slice(0,6)].slice(0,cap);
}
