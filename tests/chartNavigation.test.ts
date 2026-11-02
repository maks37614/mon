import test from 'node:test';
import assert from 'node:assert/strict';
import { panChartX, transformChartX, MIN_BAR_WIDTH, MAX_BAR_WIDTH } from '../src/chart/chartNavigation';

const base = { barWidth: 9, fitAll: false, rightOffset: 17, autoY: true };
const atPixel = (offset: number, step: number, pixel: number, width: number, padding: number) =>
  -offset + (pixel + padding - width) / step;

test('finger and mouse pan keep zoom and preserve fractional candle offset', () => {
  const next = panChartX(base, 9, 108);
  assert.equal(next.rightOffset, base.rightOffset + 12);
  assert.equal(next.barWidth, 9);
  assert.equal(next.fitAll, false);
  assert.equal(next.autoY, true);
  assert.equal(panChartX(base, 9, -45).rightOffset, 12);
});

test('first drag from fit-all history does not jump back to 9px candle widths', () => {
  const fitted = { ...base, rightOffset: 0, fitAll: true };
  const next = panChartX(fitted, 0.9, 54);
  assert.equal(next.fitAll, false);
  assert.equal(next.barWidth, 0.9);
  assert.equal(next.rightOffset, 60);
});

test('pinch scales around the moving midpoint, preserving the same candle under the finger', () => {
  const startX = 160, currentX = 188, plotWidth = 320, padding = 60, zoom = 1.8;
  const next = transformChartX(base, 9, zoom, startX, currentX, plotWidth, padding);
  const was = atPixel(base.rightOffset, 9, startX, plotWidth, padding);
  const now = atPixel(next.rightOffset, next.barWidth, currentX, plotWidth, padding);
  assert.ok(Math.abs(was - now) < 1e-8, `Candle jumped from ${was} to ${now}`);
  assert.equal(next.autoY, true);
});

test('extreme multi-touch zoom clamps within usable widths', () => {
  const lo = transformChartX(base, 9, 1e-6, 100, 100, 300, 60);
  const hi = transformChartX(base, 9, 1e6, 100, 100, 300, 60);
  assert.equal(lo.barWidth, MIN_BAR_WIDTH);
  assert.equal(hi.barWidth, MAX_BAR_WIDTH);
});
