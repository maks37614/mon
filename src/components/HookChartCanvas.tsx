import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import {
  CalendarDays,
  Crosshair as CrosshairIcon,
  Minus,
  MoveUpRight,
  Ruler,
  Trash2,
  Type,
  Layers,
} from 'lucide-react';
import {
  deriveAutoLevels,
  formatUsd,
  atr,
  type AutoLevel,
  type MarketPrint,
} from '../chart/marketAnalytics';
import { type StrategyResult } from '../chart/strategyEngine';

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  tb?: number;
};

export type Density = {
  id: string;
  side: 'ASK' | 'BID';
  p: number;
  q: number;
  usd: number;
  peakUsd: number;
  first: number;
  last: number;
  active: boolean;
  reacted?: boolean;
  reaction?: number;
  touches: number;
  lastTouch: number;
  replenishments: number;
  updates: number;
  score: number;
  mmScore: number;
};

export type Liquidation = {
  id: string;
  side: 'LONG' | 'SHORT';
  t: number;
  p: number;
  q: number;
  usd: number;
};

export type CascadeRisk = {
  score: number;
  level: 'LOW' | 'MED' | 'HIGH' | 'CRIT';
  total5: number;
  count5: number;
  longUsd: number;
  shortUsd: number;
};

export type Drawing = {
  id: string;
  type: string;
  pts: { t: number; p: number }[];
  text?: string;
};

export type Alert = {
  id: string;
  p: number;
  kind: 'level' | 'ray';
  created: number;
  fired?: boolean;
};

export type Viewport = {
  barWidth: number;
  rightOffset: number;
  autoY: boolean;
  manualCenter: number | null;
  manualRange: number | null;
  fitAll?: boolean;
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
const FIB_COLORS = [
  '#9ca8b8',
  '#63a7e6',
  '#58be9c',
  '#d5ad58',
  '#e68d58',
  '#cc6f91',
  '#9ca8b8',
] as const;

const CHART_THEME = {
  bg: '#131722',
  grid: 'rgba(42,46,57,.74)',
  gridSoft: 'rgba(42,46,57,.42)',
  axis: '#B2B5BE',
  axisMuted: '#787B86',
  crosshair: '#758696',
  divider: '#2A2E39',
} as const;

const TF_MS: Record<string, number> = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
};

const zoneParts = (ts: number, tz: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ts);
  const o: Record<string, string> = {};
  for (const x of parts) {
    if (x.type !== 'literal') o[x.type] = x.value;
  }
  return {
    y: +(o.year || 2026),
    m: +(o.month || 1),
    d: +(o.day || 1),
    h: +(o.hour || 0),
    mi: +(o.minute || 0),
    s: +(o.second || 0),
  };
};

const zoneDateKey = (ts: number, tz: string) => {
  const z = zoneParts(ts, tz);
  return `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
};

const zoneDateOffset = (daysAgo: number, tz: string) => {
  const z = zoneParts(Date.now(), tz);
  const u = new Date(Date.UTC(z.y, z.m - 1, z.d) - daysAgo * 86400000);
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
};

const zonedLocalTs = (date: string, time: string, tz: string) => {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = time.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return NaN;
  const want = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2], 0];
  const wantUtc = Date.UTC(want[0], want[1] - 1, want[2], want[3], want[4], 0);
  let guess = wantUtc;
  for (let i = 0; i < 6; i++) {
    const z = zoneParts(guess, tz);
    const seen = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s);
    const diff = wantUtc - seen;
    if (Math.abs(diff) < 1000) break;
    guess += diff;
  }
  const final = zoneParts(guess, tz);
  return final.y === want[0] &&
    final.m === want[1] &&
    final.d === want[2] &&
    final.h === want[3] &&
    final.mi === want[4]
    ? guess
    : NaN;
};

const fmt = (n: number, d = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      })
    : '—';

const nicePriceStep = (range: number, plotH: number) => {
  const safe = Math.max(Math.abs(range), 1e-12);
  const target = Math.max(
    3,
    Math.min(14, Math.round(Math.max(120, plotH) / 56))
  );
  const raw = safe / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const nice =
    norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * pow;
};

const priceTickDecimals = (step: number) => {
  if (!(step > 0)) return 2;
  if (step >= 1) return Math.abs(step - Math.round(step)) < 1e-10 ? 0 : 2;
  return Math.max(2, Math.min(8, Math.ceil(-Math.log10(step)) + 1));
};

const levelPrice = (n: number) => {
  const d = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return Number(n.toFixed(d)).toString();
};

const uid = () => Math.random().toString(36).slice(2);

// Time Axis Component from h00k.top
export const ChartTimeAxis: React.FC<{
  candles: Candle[];
  tf: string;
  timezone: string;
  viewport: Viewport;
  rightPadding: number;
}> = ({ candles, tf, timezone, viewport, rightPadding }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setWidth(Math.max(320, el.getBoundingClientRect().width || 1000));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!candles.length) return <div className="chartTimeAxis" ref={ref} />;

  const AX = 82;
  const plotW = Math.max(120, width - AX);
  const fitPlotW = Math.max(40, plotW - Math.max(0, rightPadding));
  const step = viewport.fitAll
    ? Math.max(0.001, fitPlotW / Math.max(1, candles.length))
    : Math.max(3, viewport.barWidth);
  const slots = plotW / step;
  const virtualEnd =
    candles.length - viewport.rightOffset + Math.max(0, rightPadding) / step;
  const virtualStart = virtualEnd - slots;
  const startI = Math.max(0, Math.floor(virtualStart) - 3);
  const endI = Math.min(candles.length, Math.ceil(virtualEnd) + 3);
  const barMs = TF_MS[tf] || 300000;

  const timeFmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
  });
  const monthFmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone,
    month: 'short',
  });
  const yearFmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: timezone,
    year: 'numeric',
  });

  const targetPx = step >= 18 ? 86 : step >= 10 ? 76 : 68;
  const desiredMs = Math.max(barMs, barMs * Math.max(1, targetPx / step));
  const niceIntervals = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 60 * 60_000,
    4 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
    2 * 24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
    14 * 24 * 60 * 60_000,
    30 * 24 * 60 * 60_000,
    90 * 24 * 60 * 60_000,
    180 * 24 * 60 * 60_000,
    365 * 24 * 60 * 60_000,
  ];
  const regularMs =
    niceIntervals.find((v) => v >= desiredMs) ?? niceIntervals.at(-1)!;

  const wallMs = (t: number) => {
    const z = zoneParts(t, timezone);
    return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, 0);
  };
  const labelWidth = (label: string, major: boolean) =>
    Math.max(major ? 40 : 34, label.length * (major ? 6.5 : 6.1) + 8);

  type Tick = {
    x: number;
    label: string;
    major: boolean;
    priority: number;
    align: 'left' | 'center' | 'right';
    l: number;
    r: number;
  };
  const candidates: Tick[] = [];

  const scanStride = viewport.fitAll
    ? Math.max(
        1,
        Math.floor(Math.max(1, endI - startI) / Math.max(240, plotW * 2))
      )
    : 1;

  for (let gi = startI; gi < endI; gi += scanStride) {
    const k = candles[gi];
    const x = (gi - virtualStart + 0.5) * step;
    if (x < 1 || x > plotW - 1) continue;
    const prevI = Math.max(0, gi - scanStride);
    const z = zoneParts(k.t, timezone);
    const prev = gi > 0 ? zoneParts(candles[prevI].t, timezone) : null;
    let priority = 0;
    let label = '';
    let major = false;

    if (prev && z.y !== prev.y) {
      priority = 4;
      label = yearFmt.format(k.t);
      major = true;
    } else if (prev && z.m !== prev.m) {
      priority = 3;
      label = monthFmt.format(k.t);
      major = true;
    } else if (
      barMs < 86400000 &&
      prev &&
      (z.d !== prev.d || z.m !== prev.m || z.y !== prev.y)
    ) {
      priority = 2;
      label = dateFmt.format(k.t);
      major = true;
    } else {
      const prevWall =
        gi > 0 ? wallMs(candles[prevI].t) : wallMs(k.t) - barMs;
      const curBucket = Math.floor(wallMs(k.t) / regularMs);
      const prevBucket = Math.floor(prevWall / regularMs);
      if (curBucket !== prevBucket) {
        priority = 1;
        label = barMs >= 86400000 ? dateFmt.format(k.t) : timeFmt.format(k.t);
      }
    }
    if (!priority) continue;
    const w = labelWidth(label, major);
    const edge = 5;
    let align: 'left' | 'center' | 'right' = 'center';
    let l = x - w / 2;
    let r = x + w / 2;
    if (l < edge) {
      align = 'left';
      l = x + 4;
      r = l + w;
    } else if (r > plotW - edge) {
      align = 'right';
      r = x - 4;
      l = r - w;
    }
    if (l < edge || r > plotW - edge) continue;
    candidates.push({ x, label, major, priority, align, l, r });
  }

  const accepted: Tick[] = [];
  for (const priority of [4, 3, 2, 1]) {
    for (const c of candidates
      .filter((x) => x.priority === priority)
      .sort((a, b) => a.x - b.x)) {
      if (accepted.some((a) => c.l < a.r + 10 && c.r > a.l - 10)) continue;
      accepted.push(c);
    }
  }
  accepted.sort((a, b) => a.x - b.x);

  return (
    <div className="chartTimeAxis" ref={ref}>
      <div className="chartTimePlot" style={{ width: plotW }}>
        {accepted.map((t, i) => (
          <div
            key={`${t.x}-${i}`}
            className={`chartTimeTick ${t.major ? 'major ' : ''}align-${t.align}`}
            style={{ left: t.x }}
          >
            <i />
            <span>{t.label}</span>
          </div>
        ))}
      </div>
      <div className="chartTimeScaleSpacer" style={{ width: AX }}>
        <span>{timezone.split('/').at(-1)?.replace('_', ' ')}</span>
      </div>
    </div>
  );
};

export interface HookChartCanvasProps {
  candles: Candle[];
  symbol: string;
  tf: string;
  entryPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  direction?: 'LONG' | 'SHORT';
  formationName?: string;
  tool?: string;
  timezone?: string;
  rightPadding?: number;
  showVolumes?: boolean;
  autoLevels?: AutoLevel[];
  densities?: Density[];
  marketPrints?: MarketPrint[];
  liquidations?: Liquidation[];
  candleLongColor?: string;
  candleShortColor?: string;
  gridHorizontal?: boolean;
  gridVertical?: boolean;
  onViewportChange?: (v: Viewport) => void;
}

export const HookChartCanvas: React.FC<HookChartCanvasProps> = ({
  candles,
  symbol,
  tf,
  entryPrice,
  takeProfit,
  stopLoss,
  direction = 'LONG',
  formationName,
  tool = 'cursor',
  timezone = 'Europe/Warsaw',
  rightPadding = 60,
  showVolumes = true,
  autoLevels: propAutoLevels,
  densities = [],
  marketPrints = [],
  liquidations = [],
  candleLongColor = '#0ECB81',
  candleShortColor = '#F6465D',
  gridHorizontal = true,
  gridVertical = false,
  onViewportChange,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const [vp, setVp] = useState<Viewport>({
    barWidth: 9,
    rightOffset: 0,
    autoY: true,
    manualCenter: null,
    manualRange: null,
    fitAll: false,
  });

  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [draft, setDraft] = useState<{ t: number; p: number } | null>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [zoomPanelOpen, setZoomPanelOpen] = useState<boolean>(true);
  const [clockNow, setClockNow] = useState<number>(() => Date.now());
  const [jumpOpen, setJumpOpen] = useState<boolean>(false);
  const [jumpDate, setJumpDate] = useState<string>(() =>
    zoneDateKey(Date.now(), timezone)
  );

  const drag = useRef<any>(null);
  const geom = useRef<any>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef<number>(0);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    onViewportChange?.(vp);
  }, [vp, onViewportChange]);

  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const intervalMs = TF_MS[tf] || 300000;
  const lastBarStart =
    candles.at(-1)?.t || Math.floor(clockNow / intervalMs) * intervalMs;
  const barStart =
    lastBarStart <= clockNow && clockNow - lastBarStart < intervalMs * 2
      ? lastBarStart
      : Math.floor(clockNow / intervalMs) * intervalMs;
  const barLeftMs = Math.max(0, barStart + intervalMs - clockNow);

  const formatBarLeft = (ms: number) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  // Auto-calculated support/resistance levels
  const autoLevels = useMemo(() => {
    if (propAutoLevels && propAutoLevels.length) return propAutoLevels;
    if (candles.length < 20) return [];
    try {
      const levelTf =
        tf === '1d' || tf === '4h' || tf === '1h' || tf === '15m'
          ? (tf as '1d' | '4h' | '1h' | '15m')
          : '15m';
      return deriveAutoLevels(candles, levelTf, {
        count: 2,
        allowedDiffPct: 0.35,
        historyDepth: 300,
        breakPct: 0.25,
        minSeparationBars: 6,
        pivotBars: 12,
        allowWickPenetration: true,
      });
    } catch {
      return [];
    }
  }, [candles, tf, propAutoLevels]);

  const AX = 82;
  const TX = 0;

  const geometry = useCallback(() => {
    const c = ref.current;
    if (!c || !candles.length) return null;
    const r = c.getBoundingClientRect();
    const plotW = Math.max(120, r.width - AX);
    const plotH = Math.max(100, r.height - TX);

    const fitPlotW = Math.max(40, plotW - Math.max(0, rightPadding));
    const step = vp.fitAll
      ? Math.max(0.001, fitPlotW / Math.max(1, candles.length))
      : Math.max(3, vp.barWidth);
    const slots = plotW / step;
    const virtualEnd =
      candles.length - vp.rightOffset + Math.max(0, rightPadding) / step;
    const virtualStart = virtualEnd - slots;
    const dataStart = Math.max(0, Math.floor(virtualStart) - 2);
    const dataEnd = Math.min(candles.length, Math.ceil(virtualEnd) + 2);
    const data = dataEnd > dataStart ? candles.slice(dataStart, dataEnd) : [];
    const scaleData = data.length
      ? data
      : candles.slice(-Math.min(80, candles.length));

    let lo = Infinity;
    let hi = -Infinity;
    for (const z of scaleData) {
      if (z.l < lo) lo = z.l;
      if (z.h > hi) hi = z.h;
    }

    // Include trade levels in scale view if present
    if (entryPrice && entryPrice > 0) {
      lo = Math.min(lo, entryPrice);
      hi = Math.max(hi, entryPrice);
    }
    if (takeProfit && takeProfit > 0) {
      lo = Math.min(lo, takeProfit);
      hi = Math.max(hi, takeProfit);
    }
    if (stopLoss && stopLoss > 0) {
      lo = Math.min(lo, stopLoss);
      hi = Math.max(hi, stopLoss);
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.08;
    lo -= pad;
    hi += pad;

    if (!vp.autoY && vp.manualCenter != null && vp.manualRange != null) {
      lo = vp.manualCenter - vp.manualRange / 2;
      hi = vp.manualCenter + vp.manualRange / 2;
    }

    const y = (p: number) => plotH - ((p - lo) / (hi - lo)) * plotH;
    const p = (yy: number) => lo + ((plotH - yy) / plotH) * (hi - lo);

    const nearestIndex = (t: number) => {
      let loI = 0;
      let hiI = candles.length - 1;
      while (loI < hiI) {
        const m = Math.floor((loI + hiI) / 2);
        if (candles[m].t < t) loI = m + 1;
        else hiI = m;
      }
      const a = Math.max(0, loI - 1);
      const b = Math.min(candles.length - 1, loI);
      return Math.abs(candles[a].t - t) <= Math.abs(candles[b].t - t) ? a : b;
    };

    const indexAtTime = (t: number) => {
      if (candles.length < 2) return 0;
      if (t <= candles[0].t) {
        const dt = candles[1].t - candles[0].t || 1;
        return (t - candles[0].t) / dt;
      }
      const n = candles.length - 1;
      if (t >= candles[n].t) {
        const dt = candles[n].t - candles[n - 1].t || 1;
        return n + (t - candles[n].t) / dt;
      }
      let loI = 0;
      let hiI = n;
      while (loI + 1 < hiI) {
        const m = (loI + hiI) >> 1;
        if (candles[m].t <= t) loI = m;
        else hiI = m;
      }
      const dt = candles[hiI].t - candles[loI].t || 1;
      return loI + (t - candles[loI].t) / dt;
    };

    const x = (t: number) => (indexAtTime(t) - virtualStart + 0.5) * step;
    const candleX = (localIndex: number) =>
      (dataStart + localIndex - virtualStart + 0.5) * step;

    return {
      r,
      plotW,
      plotH,
      data,
      dataStart,
      dataEnd,
      virtualStart,
      virtualEnd,
      lo,
      hi,
      step,
      x,
      candleX,
      y,
      p,
      nearestIndex,
      indexAtTime,
    };
  }, [candles, vp, rightPadding, entryPrice, takeProfit, stopLoss]);

  const zone = (x: number, y: number, g: any) =>
    x >= g.plotW ? 'price' : y >= g.plotH ? 'time' : 'plot';

  const snap = (x: number, y: number, g: any) => {
    const vi = Math.round(g.virtualStart + x / g.step - 0.5);
    const n = candles.length;
    const last = n - 1;
    const inside = vi >= 0 && vi < n;
    const k = inside ? candles[vi] : null;
    let t: number;
    if (inside) t = k!.t;
    else if (vi > last) t = candles[last].t + (vi - last) * intervalMs;
    else t = candles[0].t + vi * intervalMs;

    let p = g.p(Math.min(Math.max(0, y), g.plotH));
    if (k) {
      const vals = [k.o, k.h, k.l, k.c];
      const q = vals.reduce((a, b) =>
        Math.abs(g.y(b) - y) < Math.abs(g.y(a) - y) ? b : a
      );
      if (Math.abs(g.y(q) - y) < 12) p = q;
    }
    return { t, p };
  };

  const zoomX = (factor: number, anchorX: number, g: any) =>
    setVp((v) => {
      const old = v.fitAll
        ? Math.max(0.001, g.step)
        : Math.max(3, v.barWidth);
      const nw = Math.max(0.12, Math.min(34, old * factor));
      const anchorFromRight = (g.plotW - anchorX) / old + v.rightOffset;
      const nr = anchorFromRight - (g.plotW - anchorX) / nw;
      return { ...v, barWidth: nw, rightOffset: nr, fitAll: false };
    });

  const zoomY = (factor: number, anchorY: number, g: any) =>
    setVp((v) => {
      const range = v.autoY
        ? g.hi - g.lo
        : v.manualRange || g.hi - g.lo;
      const anchor = g.p(anchorY);
      const nr = Math.max(1e-9, range / factor);
      const ratio = anchorY / g.plotH - 0.5;
      const nc = anchor + ratio * nr;
      return { ...v, autoY: false, manualRange: nr, manualCenter: nc };
    });

  const panXWheel = (pixels: number) =>
    setVp((v) => ({
      ...v,
      rightOffset:
        v.rightOffset +
        pixels /
          (v.fitAll
            ? Math.max(0.001, geom.current?.step || 1)
            : Math.max(3, v.barWidth)),
      fitAll: false,
    }));

  const scheduleDraw = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawRef.current();
    });
  };

  const reset = () =>
    setVp({
      barWidth: 9,
      rightOffset: 0,
      autoY: true,
      manualCenter: null,
      manualRange: null,
      fitAll: false,
    });

  const fitAllHistory = () =>
    setVp((v) => ({
      ...v,
      rightOffset: 0,
      autoY: true,
      manualCenter: null,
      manualRange: null,
      fitAll: true,
    }));

  const zoomButton = (factor: number) => {
    const g = geometry();
    setVp((v) => {
      const base = v.fitAll
        ? Math.max(0.001, g?.step || 3)
        : Math.max(3, v.barWidth);
      return {
        ...v,
        fitAll: false,
        barWidth: Math.max(0.12, Math.min(34, base * factor)),
      };
    });
  };

  // Main canvas render loop
  const draw = () => {
    const c = ref.current;
    const g = geometry();
    if (!c || !g) return;
    geom.current = g;

    const mouse = mouseRef.current;
    const rawDpr = Math.max(1, window.devicePixelRatio || 1);
    const dpr = Math.min(4, rawDpr);
    const w = Math.max(1, g.r.width);
    const h = Math.max(1, g.r.height);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));

    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }

    const q = c.getContext('2d', { alpha: false });
    if (!q) return;

    const scaleX = pw / w;
    const scaleY = ph / h;
    q.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    q.imageSmoothingEnabled = false;
    q.globalCompositeOperation = 'source-over';
    q.lineCap = 'butt';
    q.lineJoin = 'miter';

    const strokeX = (v: number) => (Math.round(v * scaleX) + 0.5) / scaleX;
    const strokeY = (v: number) => (Math.round(v * scaleY) + 0.5) / scaleY;
    const hair = 1 / Math.max(scaleX, scaleY);

    q.clearRect(0, 0, w, h);
    q.fillStyle = CHART_THEME.bg;
    q.fillRect(0, 0, w, h);

    // Adaptive price scale
    const priceStep = nicePriceStep(g.hi - g.lo, g.plotH);
    const priceDecimals = priceTickDecimals(priceStep);
    const firstPriceTick = Math.ceil((g.lo - 1e-12) / priceStep) * priceStep;

    q.lineWidth = hair;
    q.font = '500 11px Inter, monospace, system-ui, sans-serif';
    let priceTickCount = 0;

    for (
      let p = firstPriceTick;
      p <= g.hi + priceStep * 0.25 && priceTickCount < 64;
      p = firstPriceTick + ++priceTickCount * priceStep
    ) {
      const value = Math.abs(p) < priceStep * 1e-9 ? 0 : p;
      const yy = g.y(value);
      if (yy < -2 || yy > g.plotH + 2) continue;

      if (gridHorizontal) {
        q.strokeStyle = CHART_THEME.grid;
        q.beginPath();
        q.moveTo(0, strokeY(yy));
        q.lineTo(g.plotW, strokeY(yy));
        q.stroke();
      }
      q.fillStyle = CHART_THEME.axis;
      q.fillText(
        fmt(value, priceDecimals),
        g.plotW + 7,
        Math.max(11, Math.min(g.plotH - 3, yy + 4))
      );
    }

    if (gridVertical) {
      const gridEvery = Math.max(1, Math.ceil(92 / Math.max(3, g.step)));
      let lastGridX = -1e9;
      for (let i = 0; i < g.data.length; i++) {
        const globalI = g.dataStart + i;
        if (globalI % gridEvery !== 0) continue;
        const xx = g.candleX(i);
        if (xx < 0 || xx > g.plotW || xx - lastGridX < 58) continue;
        q.strokeStyle = CHART_THEME.gridSoft;
        q.lineWidth = hair;
        q.beginPath();
        q.moveTo(strokeX(xx), 0);
        q.lineTo(strokeX(xx), g.plotH);
        q.stroke();
        lastGridX = xx;
      }
    }

    // Candles rasterized in physical pixels
    const denseBars = g.step * scaleX < 1.15;
    const candleRows: { k: Candle; rawX: number }[] = [];
    if (!denseBars) {
      for (let i = 0; i < g.data.length; i++) {
        candleRows.push({ k: g.data[i], rawX: g.candleX(i) });
      }
    } else {
      let bucketPx = Number.NaN;
      let agg: Candle | null = null;
      let aggX = 0;
      const flush = () => {
        if (agg) candleRows.push({ k: agg, rawX: aggX });
      };
      for (let i = 0; i < g.data.length; i++) {
        const k = g.data[i];
        const rawX = g.candleX(i);
        if (rawX < -1 || rawX > g.plotW + 1) continue;
        const px = Math.round(rawX * scaleX);
        if (px !== bucketPx) {
          flush();
          bucketPx = px;
          agg = { ...k };
          aggX = px / scaleX;
        } else if (agg) {
          const prevAgg: Candle = agg;
          agg = {
            ...prevAgg,
            h: Math.max(prevAgg.h, k.h),
            l: Math.min(prevAgg.l, k.l),
            c: k.c,
            v: prevAgg.v + k.v,
            n: (prevAgg.n || 0) + (k.n || 0),
            t: k.t,
          };
        }
      }
      flush();
    }

    q.save();
    q.setTransform(1, 0, 0, 1, 0, 0);

    for (let i = 0; i < candleRows.length; i++) {
      const row = candleRows[i];
      const k = row.k;
      const rawX = row.rawX;
      const up = k.c >= k.o;
      const col = up ? candleLongColor : candleShortColor;
      const centerPx = Math.round(rawX * scaleX);
      const stepPx = denseBars ? 1 : Math.max(2, Math.round(g.step * scaleX));
      const oneCssPx = Math.max(1, Math.round(scaleX));
      const gapPx = denseBars ? 0 : Math.max(1, oneCssPx);
      const desiredBodyPx = denseBars
        ? 1
        : Math.max(1, Math.round(g.step * 0.78 * scaleX));
      const bodyPx = denseBars
        ? 1
        : Math.max(1, Math.min(stepPx - gapPx, desiredBodyPx));
      const bodyLeftPx = Math.round(centerPx - bodyPx / 2);
      const wickPx = denseBars ? 1 : Math.max(1, Math.round(scaleX * 0.85));
      const wickLeftPx = Math.round(centerPx - wickPx / 2);

      const yHighPx = Math.round(g.y(k.h) * scaleY);
      const yLowPx = Math.round(g.y(k.l) * scaleY);
      const yOpenPx = Math.round(g.y(k.o) * scaleY);
      const yClosePx = Math.round(g.y(k.c) * scaleY);

      const wickTopPx = Math.min(yHighPx, yLowPx);
      const wickBottomPx = Math.max(yHighPx, yLowPx);
      const bodyTopPx = Math.min(yOpenPx, yClosePx);
      const bodyBottomPx = Math.max(yOpenPx, yClosePx);
      const bodyHPx = Math.max(
        denseBars ? 1 : Math.max(1, Math.round(scaleY * 0.75)),
        bodyBottomPx - bodyTopPx
      );
      const wickHPx = Math.max(1, wickBottomPx - wickTopPx);

      q.fillStyle = col;
      q.fillRect(wickLeftPx, wickTopPx, wickPx, wickHPx);
      q.fillRect(bodyLeftPx, bodyTopPx, bodyPx, bodyHPx);
    }
    q.restore();

    // Volume histogram at bottom
    if (showVolumes) {
      const volumeBandH = Math.max(48, Math.min(96, g.plotH * 0.14));
      const volumeBaseY = g.plotH - 3;
      const volumeTopY = volumeBaseY - volumeBandH;
      let maxV = 1;
      for (const z of g.data) if (z.v > maxV) maxV = z.v;

      q.save();
      q.beginPath();
      q.rect(0, volumeTopY, g.plotW, volumeBandH + 2);
      q.clip();

      q.strokeStyle = 'rgba(135,147,164,.12)';
      q.lineWidth = hair;
      q.beginPath();
      q.moveTo(0, strokeY(volumeTopY));
      q.lineTo(g.plotW, strokeY(volumeTopY));
      q.stroke();

      q.save();
      q.setTransform(1, 0, 0, 1, 0, 0);
      q.globalAlpha = 0.82;
      for (let i = 0; i < g.data.length; i++) {
        const k = g.data[i];
        const rawX = g.candleX(i);
        const centerPx = Math.round(rawX * scaleX);
        const stepPx = Math.max(2, Math.round(g.step * scaleX));
        const barPx = Math.max(
          1,
          Math.min(stepPx - 1, Math.round(g.step * 0.72 * scaleX))
        );
        const hhPx = Math.max(
          2,
          Math.round(((k.v / maxV) * (volumeBandH - 5)) * scaleY)
        );
        const leftPx = Math.round(centerPx - barPx / 2);
        const basePx = Math.round(volumeBaseY * scaleY);
        q.fillStyle = k.c >= k.o ? candleLongColor : candleShortColor;
        q.fillRect(leftPx, basePx - hhPx, barPx, hhPx);
      }
      q.restore();
      q.restore();
    }

    // Auto support & resistance levels
    for (const l of autoLevels.slice(0, 8)) {
      const yy = g.y(l.p);
      if (yy < 0 || yy > g.plotH) continue;
      const origin = g.x(l.firstTime);
      const x0 = origin > g.plotW ? 0 : Math.max(0, origin);
      const col = l.broken ? '#64748b' : l.kind === 'RESIST' ? '#38bdf8' : '#818cf8';
      q.save();
      q.strokeStyle = col;
      q.globalAlpha = l.broken ? 0.45 : 0.85;
      q.lineWidth = 1;
      q.setLineDash([4, 4]);
      q.beginPath();
      q.moveTo(x0, yy);
      q.lineTo(g.plotW, yy);
      q.stroke();
      q.setLineDash([]);
      q.globalAlpha = 1;

      q.font = '600 10px system-ui';
      const txt = `${levelPrice(l.p)} ${l.tf}`;
      q.fillStyle = col;
      q.fillText(txt, Math.max(6, x0 + 4), Math.max(10, yy - 3));
      q.restore();
    }

    // Trade Levels: ВХІД (Entry), TP (Take Profit), SL (Stop Loss)
    const renderTradeLine = (
      price: number,
      title: string,
      color: string,
      bg: string
    ) => {
      const yy = g.y(price);
      if (yy < 0 || yy > g.plotH) return;

      q.save();
      q.strokeStyle = color;
      q.lineWidth = 1.5;
      q.setLineDash([6, 4]);
      q.beginPath();
      q.moveTo(0, yy);
      q.lineTo(g.plotW, yy);
      q.stroke();
      q.setLineDash([]);

      // Label on the left of chart
      q.font = 'bold 10px Inter, monospace, system-ui';
      q.fillStyle = color;
      q.fillText(title, 8, Math.max(12, yy - 4));

      // Price Tag on Right Price Scale
      const text = `${fmt(price, price < 10 ? 4 : 2)}`;
      q.font = 'bold 11px system-ui';
      const tw = Math.min(AX - 8, q.measureText(text).width + 10);
      q.fillStyle = bg;
      q.fillRect(g.plotW + 2, Math.max(0, Math.min(g.plotH - 18, yy - 9)), tw, 18);
      q.fillStyle = '#ffffff';
      q.fillText(text, g.plotW + 6, Math.max(12, Math.min(g.plotH - 5, yy + 4)));
      q.restore();
    };

    if (entryPrice && entryPrice > 0) {
      renderTradeLine(entryPrice, 'ВХІД', '#06b6d4', '#0891b2');
    }
    if (takeProfit && takeProfit > 0) {
      renderTradeLine(takeProfit, 'TP (ЦІЛЬ)', '#10b981', '#059669');
    }
    if (stopLoss && stopLoss > 0) {
      renderTradeLine(stopLoss, 'SL (СТОП)', '#ef4444', '#dc2626');
    }

    // Live Current Price Line & Badge
    const last = candles.at(-1);
    if (last) {
      const py = g.y(last.c);
      const lastX = g.x(last.t);
      const priceCol =
        last.c >= last.o ? candleLongColor : candleShortColor;
      if (py >= 0 && py <= g.plotH) {
        q.save();
        q.strokeStyle = priceCol;
        q.globalAlpha = 0.92;
        q.lineWidth = 1;
        q.setLineDash([2, 3]);
        if (lastX <= g.plotW) {
          q.beginPath();
          q.moveTo(Math.max(0, lastX + Math.max(2, g.step * 0.32)), py + 0.5);
          q.lineTo(g.plotW, py + 0.5);
          q.stroke();
        }
        q.setLineDash([]);
        q.globalAlpha = 1;
        q.font = '600 12px Inter, monospace, system-ui';
        q.textBaseline = 'middle';
        const label = fmt(last.c, last.c < 1 ? 6 : last.c < 10 ? 4 : 2);
        const padX = 6;
        const labelW = Math.max(
          58,
          Math.min(AX - 4, q.measureText(label).width + padX * 2)
        );
        const labelH = 20;
        const labelX = g.plotW + 2;
        const labelY = Math.max(
          1,
          Math.min(g.plotH - labelH - 1, py - labelH / 2)
        );
        q.fillStyle = priceCol;
        q.fillRect(labelX, labelY, labelW, labelH);
        q.strokeStyle = 'rgba(255,255,255,.2)';
        q.lineWidth = 0.7;
        q.strokeRect(labelX + 0.5, labelY + 0.5, labelW - 1, labelH - 1);
        q.fillStyle = '#ffffff';
        q.fillText(label, labelX + padX, labelY + labelH / 2 + 0.5);
        q.restore();
      }
    }

    // User drawings
    for (const d of drawings) {
      if (!d.pts.length) continue;
      const a = d.pts[0];
      const x1 = g.x(a.t);
      const y1 = g.y(a.p);
      q.save();
      q.strokeStyle = '#38bdf8';
      q.fillStyle = '#38bdf8';
      q.lineWidth = 1.25;

      if (d.type === 'level') {
        q.beginPath();
        q.moveTo(0, y1);
        q.lineTo(g.plotW, y1);
        q.stroke();
      } else if (d.type === 'text') {
        q.font = '11px system-ui';
        q.fillText(d.text || 'Note', x1, y1);
      } else if (d.pts[1]) {
        const b = d.pts[1];
        const x2 = g.x(b.t);
        const y2 = g.y(b.p);
        q.beginPath();
        q.moveTo(x1, y1);
        q.lineTo(x2, y2);
        q.stroke();
      }
      q.restore();
    }

    // Crosshair with price indicator
    if (mouse && mouse.x < g.plotW && mouse.y < g.plotH) {
      q.save();
      q.strokeStyle = CHART_THEME.crosshair;
      q.lineWidth = 1;
      q.setLineDash([3, 3]);
      q.beginPath();
      q.moveTo(mouse.x, 0);
      q.lineTo(mouse.x, g.plotH);
      q.moveTo(0, mouse.y);
      q.lineTo(g.plotW, mouse.y);
      q.stroke();
      q.restore();

      q.fillStyle = CHART_THEME.axis;
      q.font = '500 11px Inter, system-ui, sans-serif';
      q.fillText(fmt(g.p(mouse.y), 4), g.plotW + 7, mouse.y + 4);
    }
  };

  drawRef.current = draw;

  useLayoutEffect(() => {
    if (document.visibilityState === 'hidden') {
      scheduleDraw();
      return;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    drawRef.current();
  }, [
    candles,
    vp,
    drawings,
    autoLevels,
    entryPrice,
    takeProfit,
    stopLoss,
    symbol,
    draft,
    selectedDrawingId,
    tool,
    rightPadding,
    showVolumes,
    candleLongColor,
    candleShortColor,
    gridHorizontal,
    gridVertical,
    timezone,
  ]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(c);
    const onResize = () => scheduleDraw();
    window.addEventListener('resize', onResize, { passive: true });
    scheduleDraw();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geometry();
    if (!g) return null;
    return { g, x: e.clientX - g.r.left, y: e.clientY - g.r.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const z = point(e);
    if (!z) return;
    pointers.current.set(e.pointerId, { x: z.x, y: z.y });

    if (pointers.current.size === 2) {
      const a = [...pointers.current.values()];
      const midY = (a[0].y + a[1].y) / 2;
      drag.current = {
        kind: 'pinch',
        dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y),
        bar: vp.fitAll ? Math.max(0.001, z.g.step) : vp.barWidth,
        baseRange: vp.autoY
          ? z.g.hi - z.g.lo
          : vp.manualRange || z.g.hi - z.g.lo,
        anchorY: midY,
        anchorPrice: z.g.p(Math.max(0, Math.min(z.g.plotH, midY))),
      };
      return;
    }
    const zn = zone(z.x, z.y, z.g);
    drag.current = {
      kind: zn,
      x: z.x,
      y: z.y,
      vp: { ...vp },
      g: z.g,
      baseCenter: (z.g.hi + z.g.lo) / 2,
      baseRange: z.g.hi - z.g.lo,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const z = point(e);
    if (!z) return;
    mouseRef.current = { x: z.x, y: z.y };
    scheduleDraw();
    if (pointers.current.has(e.pointerId))
      pointers.current.set(e.pointerId, { x: z.x, y: z.y });
    const d = drag.current;
    if (!d) return;

    if (tool !== 'cursor') return;

    if (d.kind === 'pinch' && pointers.current.size >= 2) {
      const a = [...pointers.current.values()];
      const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      const ratio = Math.max(0.35, Math.min(3.2, dist / (d.dist || 1)));
      const anchorY = Math.max(0, Math.min(z.g.plotH, d.anchorY ?? z.g.plotH / 2));
      const nr = Math.max(1e-9, (d.baseRange || z.g.hi - z.g.lo) / ratio);
      const anchorPrice = d.anchorPrice ?? z.g.p(anchorY);
      const anchorRatio = anchorY / Math.max(1, z.g.plotH) - 0.5;
      const nc = anchorPrice + anchorRatio * nr;
      setVp((v) => ({
        ...v,
        fitAll: false,
        barWidth: Math.max(0.12, Math.min(34, d.bar * ratio)),
        autoY: false,
        manualRange: nr,
        manualCenter: nc,
      }));
      return;
    }

    if (d.kind === 'plot') {
      const dx = z.x - d.x;
      const dy = z.y - d.y;
      const nextOffset =
        d.vp.rightOffset +
        dx / Math.max(0.001, d.vp.fitAll ? d.g.step : d.vp.barWidth);
      const movedY = Math.abs(dy) > 1.5 || !d.vp.autoY;
      if (movedY) {
        const center = d.baseCenter + (dy / Math.max(1, d.g.plotH)) * d.baseRange;
        setVp((v) => ({
          ...v,
          rightOffset: nextOffset,
          autoY: false,
          manualCenter: center,
          manualRange: d.vp.manualRange || d.baseRange,
          fitAll: false,
        }));
      } else {
        setVp((v) => ({ ...v, rightOffset: nextOffset, fitAll: false }));
      }
    } else if (d.kind === 'time') {
      const dx = z.x - d.x;
      const baseBar = d.vp.fitAll ? Math.max(0.001, d.g.step) : d.vp.barWidth;
      setVp((v) => ({
        ...v,
        fitAll: false,
        barWidth: Math.max(0.12, Math.min(34, baseBar * Math.exp(dx / 180))),
      }));
    } else if (d.kind === 'price') {
      const dy = z.y - d.y;
      const base = d.vp.autoY
        ? d.g.hi - d.g.lo
        : d.vp.manualRange || d.g.hi - d.g.lo;
      const nr = Math.max(1e-9, base * Math.exp(dy / 180));
      const anchorY = Math.max(0, Math.min(d.g.plotH, d.y));
      const anchorPrice = d.g.p(anchorY);
      const anchorRatio = anchorY / Math.max(1, d.g.plotH) - 0.5;
      const center = anchorPrice + anchorRatio * nr;
      setVp((v) => ({ ...v, autoY: false, manualCenter: center, manualRange: nr }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) drag.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const g = geometry();
    if (!g) return;
    const x = e.clientX - g.r.left;
    const y = e.clientY - g.r.top;
    const z = zone(x, y, g);
    const ax = Math.min(g.plotW, Math.max(0, x));
    const ay = Math.min(g.plotH, Math.max(0, y));

    const dy = Math.max(-240, Math.min(240, e.deltaY || 0));
    const dx = Math.max(-240, Math.min(240, e.deltaX || 0));
    const factor = Math.max(0.72, Math.min(1.38, Math.exp(-dy * 0.0018)));

    if (z === 'price') {
      zoomY(factor, ay, g);
      return;
    }
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const scroll = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
      panXWheel(scroll * 0.55);
      return;
    }
    if (z === 'plot' && e.altKey) {
      zoomY(factor, ay, g);
      return;
    }
    if (z === 'time') {
      zoomX(factor, ax, g);
      return;
    }
    const anchor = e.ctrlKey || e.metaKey ? ax : g.plotW;
    zoomX(factor, anchor, g);
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const g = geometry();
    if (!g) return;
    const x = e.clientX - g.r.left;
    const y = e.clientY - g.r.top;
    if (zone(x, y, g) !== 'plot') return;

    if (tool === 'erase') {
      setDrawings((a) => a.slice(0, -1));
      return;
    }
    if (tool === 'cursor') return;

    const p = snap(x, y, g);
    if (tool === 'level' || tool === 'text') {
      setDrawings((a) => [
        ...a,
        {
          id: symbol + ':' + uid(),
          type: tool,
          pts: [p],
          text: tool === 'text' ? 'Note' : '',
        },
      ]);
      return;
    }
    if (!draft) {
      setDraft(p);
    } else {
      const id = symbol + ':' + uid();
      setDrawings((a) => [...a, { id, type: tool, pts: [draft, p] }]);
      setDraft(null);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const g = geometry();
    if (!g) return;
    const x = e.clientX - g.r.left;
    const y = e.clientY - g.r.top;
    if (zone(x, y, g) === 'price') {
      setVp((v) => ({ ...v, autoY: true, manualCenter: null, manualRange: null }));
    } else {
      reset();
    }
  };

  return (
    <div className="flex flex-col w-full h-full bg-[#131722] select-none">
      {/* Canvas Chart Area */}
      <div className="chartStage" ref={box}>
        <div className="chartWrap">
          {/* Zoom & Candle Countdown Dock */}
          <div
            className={`chartScaleDock ${
              zoomPanelOpen ? 'expanded' : 'collapsed'
            }`}
          >
            <div className="barCountdown" title={`До закриття свічки ${tf}`}>
              <b>{formatBarLeft(barLeftMs)}</b>
            </div>
            {zoomPanelOpen && (
              <div className="scaleTools">
                <button
                  title="Збільшити масштаб"
                  onClick={() => zoomButton(1.2)}
                >
                  +
                </button>
                <button
                  title="Зменшити масштаб"
                  onClick={() => zoomButton(1 / 1.2)}
                >
                  −
                </button>
                <button className="scaleReset" onClick={reset}>
                  Reset
                </button>
                <button
                  className={
                    vp.fitAll ? 'scaleHistory active' : 'scaleHistory'
                  }
                  title={
                    vp.fitAll
                      ? 'Вся історія: увімкнено'
                      : 'Вся завантажена історія поточного таймфрейму'
                  }
                  aria-label="Показати всю історію"
                  onClick={fitAllHistory}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.45"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 3v12M15.5 3v12M5 9h8" />
                    <path d="M7 7 5 9l2 2M11 7l2 2-2 2" />
                  </svg>
                </button>
              </div>
            )}
            <button
              className="scaleDockToggle"
              title={
                zoomPanelOpen
                  ? 'Згорнути масштабування'
                  : 'Розгорнути масштабування'
              }
              onClick={() => setZoomPanelOpen((v) => !v)}
            >
              {zoomPanelOpen ? '›' : '‹'}
            </button>
          </div>

          {/* HTML5 Canvas Surface */}
          <canvas
            ref={ref}
            onClick={handleClick}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => {
              mouseRef.current = null;
              scheduleDraw();
            }}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(e) => {
              e.preventDefault();
              setDraft(null);
            }}
          />
        </div>
      </div>

      {/* Synchronized Bottom Time Axis */}
      <ChartTimeAxis
        candles={candles}
        tf={tf}
        timezone={timezone}
        viewport={vp}
        rightPadding={rightPadding}
      />
    </div>
  );
};
