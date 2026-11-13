/**
 * Thin ECharts binding for the BSoC chart — the only module that imports
 * ECharts runtime code (modular `echarts/core` registration per the P2
 * decision block). Kept separate from bsocChart.ts (pure) so unit tests can
 * exercise option/zoom math without a canvas; `createChart` returns null
 * when the environment has no 2D canvas (jsdom), which the page tolerates.
 */
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { percentToWindow, windowToPercent, type TimeWindow } from './bsocChart';

echarts.use([
  LineChart,
  GridComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

/** datazoom event payload — programmatic actions report via `batch`. */
interface DataZoomEventLike {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: Array<{
    start?: number;
    end?: number;
    startValue?: number;
    endValue?: number;
  }>;
}

export interface ChartHandle {
  /** Apply the full option; `domain` seeds the window conversions below. */
  setOption(option: EChartsCoreOption, domain: TimeWindow): void;
  /** Dispatch a programmatic zoom to `win` (fires the datazoom handler). */
  applyWindow(win: TimeWindow): void;
  /** Replace the window-change sink (the page rebinds across effect runs). */
  onDataZoom(handler: (win: TimeWindow) => void): void;
  /**
   * Replace the pointer sink: the x-axis timestamp under the cursor, or null
   * when the cursor leaves the chart (page shows the newest sample then).
   */
  onPointerMove(handler: (tsMs: number | null) => void): void;
  /** Chart x pixel → axis timestamp (for cursor-anchored wheel zoom). */
  pixelToTs(px: number): number | null;
  width(): number;
  resize(): void;
  dispose(): void;
}

function hasCanvas(el: HTMLElement): boolean {
  try {
    return el.ownerDocument.createElement('canvas').getContext('2d') !== null;
  } catch {
    return false;
  }
}

/** Init a chart on `el`, or null when the environment cannot render canvas. */
export function createChart(
  el: HTMLElement,
  onDataZoom: (win: TimeWindow) => void
): ChartHandle | null {
  if (!hasCanvas(el)) return null;
  const chart: EChartsType = echarts.init(el, undefined, { renderer: 'canvas' });
  /** The DOMAIN (window percent base) — the loaded bounds are irrelevant here. */
  let domain: TimeWindow | null = null;
  let sink = onDataZoom;
  let pointerSink: (tsMs: number | null) => void = () => {};

  const tsAtX = (px: number): number | null => {
    // One named axis + scalar px maps px → timestamp (the tuple form of the
    // value silently returns NaN with an axis finder).
    const value = chart.convertFromPixel({ xAxisIndex: 0 }, px);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  // zrender-level listeners fire over the whole canvas regardless of which
  // mark the cursor hits, and only x is read — so the readout depends on the
  // x-axis location alone (session markLine/markArea cannot capture it).
  // Freeze the readout while touches are down: zrender synthesizes 'mousemove'
  // from touch events and would otherwise drag the readout along mid-gesture —
  // most jarring during a pinch (the values churn while the scale moves). The
  // whole touch interaction freezes, not just two-finger moves: fingers land
  // one event at a time and the first touchstart would already leak. When the
  // last finger lifts the sink resets to the newest-sample default (resume).
  const zr = chart.getZr();
  let touchCount = 0;
  const trackTouches = (event: TouchEvent): void => {
    touchCount = event.touches.length;
    if (touchCount === 0) pointerSink(null);
  };
  // Capture phase: zrender's own touch listeners run first on their inner
  // element during the bubble phase, so bubble tracking would freeze one
  // synthesized mousemove too late.
  el.addEventListener('touchstart', trackTouches, { passive: true, capture: true });
  el.addEventListener('touchmove', trackTouches, { passive: true, capture: true });
  el.addEventListener('touchend', trackTouches, { passive: true, capture: true });
  el.addEventListener('touchcancel', trackTouches, { passive: true, capture: true });
  const pointerListener = (event: { offsetX: number }): void => {
    if (touchCount > 0) return;
    pointerSink(tsAtX(event.offsetX));
  };
  const pointerLeaveListener = (): void => pointerSink(null);
  zr.on('mousemove', pointerListener);
  zr.on('globalout', pointerLeaveListener);

  const listener = (payload: unknown): void => {
    if (domain === null) return;
    const event = payload as DataZoomEventLike;
    const part = event.batch?.[0] ?? event;
    const { startValue, endValue } = part;
    if (typeof startValue === 'number' && typeof endValue === 'number') {
      sink({ from: startValue, to: endValue });
    } else if (typeof part.start === 'number' && typeof part.end === 'number') {
      sink(percentToWindow(part.start, part.end, domain));
    }
  };
  chart.on('datazoom', listener);

  return {
    setOption(option, nextDomain) {
      domain = nextDomain;
      chart.setOption(option, { notMerge: true });
    },
    applyWindow(win) {
      if (domain === null) return;
      const pct = windowToPercent(win, domain);
      chart.dispatchAction({
        type: 'dataZoom',
        dataZoomIndex: 0,
        start: pct.start,
        end: pct.end,
      });
    },
    onDataZoom(handler) {
      sink = handler;
    },
    onPointerMove(handler) {
      pointerSink = handler;
    },
    pixelToTs(px) {
      return tsAtX(px);
    },
    width() {
      return chart.getWidth();
    },
    resize() {
      chart.resize();
    },
    dispose() {
      chart.off('datazoom', listener);
      zr.off('mousemove', pointerListener);
      zr.off('globalout', pointerLeaveListener);
      el.removeEventListener('touchstart', trackTouches, { capture: true });
      el.removeEventListener('touchmove', trackTouches, { capture: true });
      el.removeEventListener('touchend', trackTouches, { capture: true });
      el.removeEventListener('touchcancel', trackTouches, { capture: true });
      chart.dispose();
    },
  };
}