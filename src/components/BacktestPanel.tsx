import React, { useMemo, useState } from 'react';
import { BarChart3, Play, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import type { BacktestTrade } from '../../backend/backtest';

type Report = {
  model: 'CANDLE_ONLY_INDICATIVE';
  disclaimer: string;
  input: { symbol:string;exchange:string;timeframe:string;bars:number;startingBalance:number;notional:number;feeBps:number;slippageBps:number };
  candles: number; signals:number; skipped:number;
  period:{from:number;to:number};
  summary:{trades:number;winners:number;losers:number;winRatePercent:number;
    startBalance:number;endBalance:number;netPnl:number;returnPercent:number;maxDrawdownPercent:number;
    grossProfit:number;grossLoss:number};
  equity:{at:number;balance:number}[];
  trades:BacktestTrade[];
};
const money = (n:number) => n.toLocaleString('uk-UA',{minimumFractionDigits:2,maximumFractionDigits:2});
const date = (n:number) => new Intl.DateTimeFormat('uk-UA',{
  timeZone:'Europe/Warsaw',dateStyle:'short',timeStyle:'short',
}).format(new Date(n));

const symbols: Record<string,string[]> = {
  binance:['BTCUSDT','ETHUSDT','SOLUSDT','ZECUSDT','HYPEUSDT','ESPORTSUSDT'],
  bybit:['BTCUSDT','ETHUSDT'],
};

export function BacktestPanel() {
  const [exchange,setExchange] = useState<'binance'|'bybit'>('binance');
  const [symbol,setSymbol] = useState('BTCUSDT');
  const [tf,setTf] = useState<'1m'|'5m'>('5m');
  const [bars,setBars] = useState(500);
  const [feeBps,setFeeBps] = useState(5);
  const [slippageBps,setSlippageBps] = useState(2);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [report,setReport] = useState<Report|null>(null);

  const points = useMemo(() => {
    if (!report?.equity?.length) return '';
    const eq = report.equity;
    const values = eq.map(x=>x.balance);
    const low = Math.min(...values), high = Math.max(...values);
    const range = high-low || 1;
    return eq.map((x,i)=>{
      const a = eq.length === 1 ? 0 : i/(eq.length-1);
      return `${(16+a*768).toFixed(1)},${(160-(x.balance-low)/range*130).toFixed(1)}`;
    }).join(' ');
  },[report]);

  async function run() {
    if (busy) return;
    setBusy(true);setError('');setReport(null);
    try {
      const q = new URLSearchParams({
        exchange,symbol,timeframe:tf,bars:String(bars),
        startingBalance:'1000',notional:'100',
        feeBps:String(feeBps),slippageBps:String(slippageBps),
      });
      const result=await api<Report>(`/api/backtest?${q.toString()}`);
      setReport(result);
    } catch(err:any){setError(err.message||'Бектест недоступний');}
    finally{setBusy(false);}
  }

  return (
    <div className="strategy-builder">
      <section className="panel">
        <div className="section-heading">
          <div>
            <div className="eyebrow">KRYSTIAN · EV-TEST</div>
            <h2><BarChart3 size={18}/> Бектест на історичних свічках</h2>
            <p className="muted">Одна монета, реальні закриті 1m/5m свічки біржі та поточні правила пошуку сетапів Ev-Test.</p>
          </div>
        </div>
        <div className="notice" role="note">
          <AlertTriangle size={18} />
          <span><strong>Індикативна модель, не повний бектест виконання Ev-Test.</strong> Історичних підтверджених стінок h00k.top немає. Модель не може підтвердити тогочасні формації, стакан, фактичні комісії, funding, ліквідацію та ціни виконання. Вона не впливає на Paper-баланс і не відкриває угод.</span>
        </div>
        <div className="backtest-controls">
          <label>Біржа
            <select value={exchange} disabled={busy} onChange={e=>{
              const v=e.target.value as 'binance'|'bybit';
              setExchange(v);if(!symbols[v].includes(symbol))setSymbol('BTCUSDT');
              setReport(null);
            }}><option value="binance">Binance Futures</option><option value="bybit">Bybit Futures</option></select>
          </label>
          <label>Монета
            <select value={symbol} disabled={busy} onChange={e=>{setSymbol(e.target.value);setReport(null);}}>
              {symbols[exchange].map(x=><option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label>Таймфрейм
            <select value={tf} disabled={busy} onChange={e=>{setTf(e.target.value as '1m'|'5m');setReport(null);}}>
              <option value="1m">1 хвилина</option><option value="5m">5 хвилин</option>
            </select>
          </label>
          <label>Історія
            <select value={bars} disabled={busy} onChange={e=>{setBars(Number(e.target.value));setReport(null);}}>
              <option value={500}>500 свічок</option><option value={1000}>1000 свічок</option><option value={1500}>1500 свічок</option>
            </select>
          </label>
          <label>Комісія, bps на сторону
            <input type="number" min={0} max={30} step={1} disabled={busy} value={feeBps} onChange={e=>{setFeeBps(Number(e.target.value));setReport(null);}}/>
          </label>
          <label>Умовне прослизання, bps на сторону
            <input type="number" min={0} max={50} step={1} disabled={busy} value={slippageBps} onChange={e=>{setSlippageBps(Number(e.target.value));setReport(null);}}/>
          </label>
        </div>
        <div className="strategy-builder-actions">
          <button type="button" className="primary" disabled={busy} onClick={()=>void run()}>
            <Play size={16}/>{busy?'Рахуємо на біржових свічках…':'Запустити бектест'}
          </button>
          <span className="muted">Старт: 1 000 USDT · Умовний обсяг: 100 USDT/угода · Без плеча · Без ордерів</span>
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
      </section>
      {report && <section className="panel">
        <div className="section-heading">
          <div><h2>Результат · {report.input.symbol} {report.input.timeframe}</h2>
            <p className="muted">{date(report.period.from)} – {date(report.period.to)} · {report.candles} реальних свічок</p>
          </div>
          <span className="pill">CANDLE-ONLY</span>
        </div>
        <div className="backtest-metrics">
          <div><small>Умовний P&L</small><strong className={report.summary.netPnl>=0?'positive-text':'negative-text'}>
            {report.summary.netPnl>=0?'+':''}{money(report.summary.netPnl)} USDT</strong></div>
          <div><small>Результат</small><strong>{report.summary.returnPercent.toFixed(2)}%</strong></div>
          <div><small>Угод</small><strong>{report.summary.trades}</strong></div>
          <div><small>Win rate</small><strong>{report.summary.winRatePercent.toFixed(1)}%</strong></div>
          <div><small>Макс. просадка*</small><strong>{report.summary.maxDrawdownPercent.toFixed(2)}%</strong></div>
          <div><small>Баланс моделі</small><strong>{money(report.summary.endBalance)} USDT</strong></div>
        </div>
        <p className="muted">Виявлені сетапи: {report.signals} · Пропущені: {report.skipped} · Виграшні: {report.summary.winners} · Збиткові: {report.summary.losers}. *Просадка за закритими угодами, без внутрішньосвічкового плаваючого P&L.</p>
        <div className="backtest-equity">
          <strong>Крива умовного балансу</strong>
          <svg viewBox="0 0 800 182" role="img" aria-label="Крива умовного балансу за завершеними угодами" preserveAspectRatio="none">
            <path d="M16 160 H784" fill="none" stroke="#334155" strokeWidth="1"/>
            <polyline points={points} fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          </svg>
        </div>
        <p className="muted">{report.disclaimer}</p>
        <h3>Умовні угоди ({report.trades.length})</h3>
        <div className="table-wrap backtest-table">
          <table><thead><tr>
            <th>Вхід</th><th>Сетап</th><th>Напрям</th><th>Ціна входу</th><th>SL / TP</th>
            <th>Вихід</th><th>Причина</th><th>Нетто P&L</th>
          </tr></thead>
            <tbody>{report.trades.map((t,i)=><tr key={t.signalId+'-'+i}>
              <td>{date(t.entryAt)}</td>
              <td>{t.formation}</td>
              <td>{t.direction}</td>
              <td>{t.entryPrice.toPrecision(8)}</td>
              <td>{t.stopLoss.toPrecision(8)} / {t.takeProfit.toPrecision(8)}</td>
              <td>{date(t.exitAt)}<small>{t.exitPrice.toPrecision(8)}</small></td>
              <td>{t.reason}</td>
              <td className={t.netPnl>=0?'positive-text':'negative-text'}>{money(t.netPnl)} USDT</td>
            </tr>)}</tbody>
          </table>
          {!report.trades.length && <div className="empty">
            На вибраній історії сетапів для умовного входу немає. Це не означає, що стратегія перевірена або збиткова.
          </div>}
        </div>
      </section>}
    </div>
  );
}
