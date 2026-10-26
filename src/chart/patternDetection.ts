import type { CandleLike, StrategyDirection, StrategyEvent, StrategyLine, StrategyPreset } from "./strategyEngine";

export type PatternScore = { structure: number; breakout: number; volume: number };
type Pivot = { i: number; p: number; kind: "H" | "L" };
type PatternEvent = Omit<StrategyEvent, "id" | "priority">;
const unit = (v: number) => Math.max(0, Math.min(1, v));
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function atr(candles: CandleLike[], at: number) {
  const values: number[] = [];
  for (let i = Math.max(1, at - 13); i <= at; i++) {
    const c = candles[i], previous = candles[i - 1].c;
    values.push(Math.max(c.h - c.l, Math.abs(c.h - previous), Math.abs(c.l - previous)));
  }
  return average(values);
}
function pivots(a: CandleLike[]): Pivot[] {
  const result: Pivot[] = [];
  for (let i = Math.max(3, a.length - 220); i < a.length - 3; i++) {
    const around = a.slice(i - 3, i + 4).filter((_, offset) => offset !== 3);
    if (around.every(c => c.h < a[i].h)) result.push({ i, p: a[i].h, kind: "H" });
    if (around.every(c => c.l > a[i].l)) result.push({ i, p: a[i].l, kind: "L" });
  }
  return result;
}
function regression(points: Pivot[]) {
  const x = average(points.map(p => p.i)), y = average(points.map(p => p.p));
  const denominator = points.reduce((sum, p) => sum + (p.i - x) ** 2, 0);
  const m = denominator ? points.reduce((sum, p) => sum + (p.i - x) * (p.p - y), 0) / denominator : 0;
  return { m, at: (i: number) => y + m * (i - x) };
}

/** A bounded quality score, not an estimated win probability. */
function quality(a: CandleLike[], structure: number, breakoutIndex: number | undefined,
  boundary: (i: number) => number, direction: StrategyDirection): PatternScore {
  const shape = Math.round(60 * unit(structure));
  if (breakoutIndex === undefined) return { structure: shape, breakout: 0, volume: 0 };
  const c = a[breakoutIndex], sign = direction === "bullish" ? 1 : -1;
  const volatility = Math.max(atr(a, breakoutIndex - 1), c.c * 1e-12);
  const penetration = unit(sign * (c.c - boundary(breakoutIndex)) / volatility);
  const closeLocation = unit(direction === "bullish" ? (c.c - c.l) / Math.max(c.h - c.l, volatility * .01)
    : (c.h - c.c) / Math.max(c.h - c.l, volatility * .01));
  const baseline = average(a.slice(Math.max(0, breakoutIndex - 20), breakoutIndex).map(c => c.v));
  // 1x ordinary volume earns 5/15, 2x earns 15/15; absent volume earns nothing.
  const volumeRatio = baseline > 0 ? c.v / baseline : 0;
  return { structure: shape, breakout: Math.round(15 + 5 * penetration + 5 * closeLocation),
    volume: Math.round(15 * unit((volumeRatio - .5) / 1.5)) };
}

export function detectPatternEvents(preset: StrategyPreset, series: Record<string, CandleLike[]>): PatternEvent[] {
  const config = preset.config, events: PatternEvent[] = [];
  const min = config.patternMinScore ?? 60, maxAge = config.patternMaxAge ?? 20;
  const maxDistance = config.patternMaxDistance ?? 10;
  for (const timeframe of config.patternTfs || ["1h", "4h", "1d"]) {
    const a = series[timeframe] || [], last = a.at(-1);
    if (a.length < 40 || !last) continue;
    // Invalid or unsorted candles must never create a NaN score or a false breakout.
    if (a.some((c, i) => ![c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) || c.c <= 0 ||
      c.o <= 0 || c.v < 0 || c.l <= 0 || c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c) ||
      (i > 0 && c.t <= a[i - 1].t))) continue;
    const p = pivots(a), highs = p.filter(p => p.kind === "H"), lows = p.filter(p => p.kind === "L");

    const emit = (name: string, expectedDirection: StrategyDirection, structure: number, lastPivot: number,
      boundary: (i: number) => number, key: string, invalid: (i: number) => boolean,
      lines?: StrategyLine[], reasons: string[] = [], knownBreakout?: number) => {
      if (!config.allPatterns && !config.patternTypes?.includes(name)) return;
      if (a.length - 1 - lastPivot > maxAge || invalid(a.length - 1)) return;
      let direction = expectedDirection, breakoutIndex = knownBreakout;
      if (breakoutIndex === undefined && direction !== "neutral") {
        const sign = direction === "bullish" ? 1 : -1;
        // Preserve the first closing breakout. Staying beyond it is not a new event.
        for (let i = lastPivot + 1; i < a.length; i++) {
          if (sign * (a[i].c - boundary(i)) > 0 && sign * (a[i - 1].c - boundary(i - 1)) <= 0) {
            breakoutIndex = i; break;
          }
        }
      }
      if (breakoutIndex !== undefined) {
        if (a.length - 1 - breakoutIndex > maxAge) return;
        const sign = direction === "bullish" ? 1 : -1;
        // A failed breakout cannot be relabelled as a fresh developing formation.
        for (let i = breakoutIndex + 1; i < a.length; i++) if (sign * (a[i].c - boundary(i)) <= 0) return;
      }
      const confirmed = breakoutIndex !== undefined;
      if (config.onlyConfirmed && !confirmed) return;
      const trigger = boundary(breakoutIndex ?? a.length - 1);
      if (!Number.isFinite(trigger) || trigger <= 0 || Math.abs(last.c - trigger) / last.c * 100 > maxDistance) return;
      const scoreParts = quality(a, structure, breakoutIndex, boundary, direction);
      const score = scoreParts.structure + scoreParts.breakout + scoreParts.volume;
      if (score < min) return;
      events.push({ type: "PATTERN", subtype: name, label: name, direction,
        state: confirmed ? "confirmed" : "watching", score, confidence: score,
        risk: Math.round(100 - score * .6), t: a[breakoutIndex ?? a.length - 1].t, p: trigger,
        patternId: `${name}:${key}`, scoreParts, lines,
        reasons: [`${timeframe} · ${confirmed ? "пробій закритою свічкою" : "ще без підтвердженого пробою"}`,
          `Структура ${scoreParts.structure}/60; пробій ${scoreParts.breakout}/25; обсяг ${scoreParts.volume}/15`, ...reasons] });
    };

    for (const kind of ["H", "L"] as const) {
      const same = kind === "H" ? highs : lows, opposite = kind === "H" ? lows : highs;
      if (same.length < 2) continue;
      const [left, right] = same.slice(-2), top = kind === "H";
      const volatility = Math.max(atr(a, right.i), a[right.i].c * 1e-12);
      const middle = opposite.filter(p => p.i > left.i && p.i < right.i)
        .sort((x, y) => top ? x.p - y.p : y.p - x.p)[0];
      if (!middle) continue;
      const depth = top ? Math.min(left.p, right.p) - middle.p : middle.p - Math.max(left.p, right.p);
      const mismatch = Math.abs(left.p - right.p) / Math.max(depth, volatility * .01);
      const legBalance = Math.min(middle.i - left.i, right.i - middle.i) / Math.max(middle.i - left.i, right.i - middle.i);
      if (depth < volatility * 1.5 || mismatch > .35 || legBalance < .35 || right.i - left.i > 100) continue;
      const structure = .55 * unit(1 - mismatch / .35) + .25 * unit(depth / (volatility * 4)) + .2 * legBalance;
      emit(top ? "Double Top" : "Double Bottom", top ? "bearish" : "bullish", structure, right.i,
        () => middle.p, `${a[left.i].t}:${a[right.i].t}`, i => top
          ? a[i].c > Math.max(left.p, right.p) + volatility * .2
          : a[i].c < Math.min(left.p, right.p) - volatility * .2,
        undefined, [`Відхилення вершин / глибина ${(mismatch * 100).toFixed(1)}%`]);
    }

    for (const kind of ["H", "L"] as const) {
      const same = kind === "H" ? highs : lows, opposite = kind === "H" ? lows : highs, top = kind === "H";
      if (same.length < 3) continue;
      const [left, head, right] = same.slice(-3);
      const volatility = Math.max(atr(a, right.i), a[right.i].c * 1e-12);
      const firstNeck = opposite.filter(p => p.i > left.i && p.i < head.i)
        .sort((a, b) => top ? a.p - b.p : b.p - a.p)[0];
      const secondNeck = opposite.filter(p => p.i > head.i && p.i < right.i)
        .sort((a, b) => top ? a.p - b.p : b.p - a.p)[0];
      if (!firstNeck || !secondNeck || right.i - left.i > 150) continue;
      const neckline = regression([firstNeck, secondNeck]);
      const prominence = top ? head.p - Math.max(left.p, right.p) : Math.min(left.p, right.p) - head.p;
      const depth = Math.abs(head.p - neckline.at(head.i));
      const mismatch = Math.abs(left.p - right.p) / Math.max(depth, volatility * .01);
      const balance = Math.min(head.i - left.i, right.i - head.i) / Math.max(head.i - left.i, right.i - head.i);
      if (prominence < volatility * .5 || depth < volatility * 2 || mismatch > .4 || balance < .35) continue;
      const structure = .4 * unit(1 - mismatch / .4) + .3 * balance + .3 * unit(prominence / (volatility * 2));
      emit(top ? "H&S" : "Inverse H&S", top ? "bearish" : "bullish", structure, right.i,
        neckline.at, `${a[left.i].t}:${a[head.i].t}:${a[right.i].t}`, i => top ? a[i].c > head.p : a[i].c < head.p);
    }

    if (highs.length >= 3 && lows.length >= 3) {
      const hs = highs.slice(-4), ls = lows.slice(-4), upper = regression(hs), lower = regression(ls);
      const start = Math.min(hs[0].i, ls[0].i), lastPivot = Math.max(hs.at(-1)!.i, ls.at(-1)!.i);
      const volatility = Math.max(atr(a, lastPivot), a[lastPivot].c * 1e-12);
      const width0 = upper.at(start) - lower.at(start), widthNow = upper.at(a.length - 1) - lower.at(a.length - 1);
      const widthAtPivot = upper.at(lastPivot) - lower.at(lastPivot), convergence = 1 - widthAtPivot / width0;
      const residual = Math.max(...hs.map(p => Math.abs(p.p - upper.at(p.i))), ...ls.map(p => Math.abs(p.p - lower.at(p.i))));
      // Past the apex, crossed trendlines no longer describe an active triangle or wedge.
      if (width0 > volatility * 2 && widthNow > 0 && widthAtPivot > 0 && convergence > .12 && convergence < .9 &&
        residual / width0 <= .2 && lastPivot - start <= 160) {
        let name = "", direction: StrategyDirection = "neutral";
        if (Math.abs(upper.m) < Math.abs(lower.m) * .35 && lower.m > 0) { name = "Ascending Triangle"; direction = "bullish"; }
        else if (Math.abs(lower.m) < Math.abs(upper.m) * .35 && upper.m < 0) { name = "Descending Triangle"; direction = "bearish"; }
        else if (upper.m < 0 && lower.m > 0) name = "Symmetric Triangle";
        else if (upper.m > 0 && lower.m > upper.m) { name = "Rising Wedge"; direction = "bearish"; }
        else if (upper.m < lower.m && lower.m < 0) { name = "Falling Wedge"; direction = "bullish"; }
        let symmetricBreakout: number | undefined;
        if (name === "Symmetric Triangle") {
          for (let i = lastPivot + 1; i < a.length; i++) {
            if (a[i].c > upper.at(i) && a[i - 1].c <= upper.at(i - 1)) { direction = "bullish"; symmetricBreakout = i; break; }
            if (a[i].c < lower.at(i) && a[i - 1].c >= lower.at(i - 1)) { direction = "bearish"; symmetricBreakout = i; break; }
          }
        }
        if (name) {
          const structure = .55 * unit(1 - residual / width0 / .2) + .25 * unit(convergence / .6) + .2 * unit((hs.length + ls.length) / 8);
          const lines = [{ t0: a[start].t, p0: upper.at(start), t1: last.t, p1: upper.at(a.length - 1), label: "upper" },
            { t0: a[start].t, p0: lower.at(start), t1: last.t, p1: lower.at(a.length - 1), label: "lower" }];
          emit(name, direction, structure, lastPivot, direction === "bearish" ? lower.at : upper.at,
            [...hs, ...ls].map(p => a[p.i].t).join(":"), i => direction === "bullish" ? a[i].c < lower.at(i)
              : direction === "bearish" ? a[i].c > upper.at(i) : false, lines,
            [`Звуження ${(convergence * 100).toFixed(1)}%; похибка ліній ${(residual / width0 * 100).toFixed(1)}%`], symmetricBreakout);
        }
      }
    }

    // Evaluate actual closing breakouts; later candles retain the same flag identity and time.
    for (let i = Math.max(29, a.length - 1 - maxAge); i < a.length; i++) {
      const impulse = a.slice(i - 29, i - 14), flag = a.slice(i - 14, i);
      const move = impulse.at(-1)!.c - impulse[0].o, magnitude = Math.abs(move);
      if (magnitude / impulse[0].o < .015) continue;
      const high = Math.max(...flag.map(c => c.h)), low = Math.min(...flag.map(c => c.l));
      const widthRatio = (high - low) / magnitude, bullish = move > 0, boundary = bullish ? high : low;
      const pullback = bullish ? (impulse.at(-1)!.c - low) / magnitude : (high - impulse.at(-1)!.c) / magnitude;
      if (widthRatio >= .6 || pullback < -.1 || pullback > .6 || (bullish ? a[i].c <= high : a[i].c >= low)) continue;
      const efficiency = magnitude / Math.max(magnitude, impulse.reduce((sum, c, n) => sum + Math.abs(c.c - (impulse[n - 1]?.c ?? c.o)), 0));
      const structure = .45 * unit(1 - widthRatio / .6) + .3 * unit(efficiency) + .25 * unit(1 - Math.abs(pullback - .25) / .6);
      emit(bullish ? "Bull Flag" : "Bear Flag", bullish ? "bullish" : "bearish", structure, i - 1,
        () => boundary, `${a[i - 29].t}:${a[i - 1].t}`, at => bullish ? a[at].c <= low : a[at].c >= high,
        undefined, [`Імпульс ${(magnitude / impulse[0].o * 100).toFixed(2)}%; ширина прапора ${(widthRatio * 100).toFixed(1)}% імпульсу`], i);
      if (events.some(e => e.subtype === (bullish ? "Bull Flag" : "Bear Flag"))) break;
    }
  }
  return events;
}
