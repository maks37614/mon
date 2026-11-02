/** Device-independent navigation math for the native HookChart candle viewport.
 * Positive rightOffset moves backwards in candle history.
 * All pixel anchors are relative to the plot (excluding the price axis).
 */
export type ChartPanViewport = {
  barWidth: number;
  rightOffset: number;
  fitAll?: boolean;
};

export const MIN_BAR_WIDTH = 0.5;
export const MAX_BAR_WIDTH = 40;

/** Pans and/or zooms without moving the candle that was under the gesture. */
export function transformChartX<T extends ChartPanViewport>(
  start: T,
  fittedStep: number,
  zoomRatio: number,
  startX: number,
  currentX: number,
  plotWidth: number,
  rightPadding: number,
): T {
  const oldStep = start.fitAll ? fittedStep : Math.max(MIN_BAR_WIDTH, start.barWidth);
  if (!(Number.isFinite(oldStep) && oldStep > 0)) return start;
  const newStep = Math.min(MAX_BAR_WIDTH,
    Math.max(MIN_BAR_WIDTH, oldStep * zoomRatio));
  const anchorBefore = (startX + rightPadding - plotWidth) / oldStep;
  const anchorAfter = (currentX + rightPadding - plotWidth) / newStep;
  return {
    ...start,
    fitAll: false,
    barWidth: newStep,
    rightOffset: start.rightOffset + anchorAfter - anchorBefore,
  };
}

/** A mouse drag, touch swipe, or wheel scroll with no zoom. */
export function panChartX<T extends ChartPanViewport>(
  start: T,
  fittedStep: number,
  deltaPx: number,
): T {
  return transformChartX(start, fittedStep, 1, 0, deltaPx, 1, 0);
}
