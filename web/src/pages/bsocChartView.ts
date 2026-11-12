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
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { percentToWindow, windowToPercent, type TimeWindow } from './bsocChart';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
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
  /** Apply the full option; bounds seed the window conversions below. */
  setOption(option: EChartsCoreOption, bounds: TimeWindow): void;
  /** Dispatch a programmatic zoom to `win` (fires the datazoom handler). */
  applyWindow(win: TimeWindow): void;
  /** Replace the window-change sink (the page rebinds across effect runs). */
  onDataZoom(handler: (win: TimeWindow) => void): void;
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
  let bounds: TimeWindow | null = null;
  let sink = onDataZoom;

  const listener = (payload: unknown): void => {
    if (bounds === null) return;
    const event = payload as DataZoomEventLike;
    const part = event.batch?.[0] ?? event;
    const { startValue, endValue } = part;
    if (typeof startValue === 'number' && typeof endValue === 'number') {
      sink({ from: startValue, to: endValue });
    } else if (typeof part.start === 'number' && typeof part.end === 'number') {
      sink(percentToWindow(part.start, part.end, bounds));
    }
  };
  chart.on('datazoom', listener);

  return {
    setOption(option, nextBounds) {
      bounds = nextBounds;
      chart.setOption(option, { notMerge: true });
    },
    applyWindow(win) {
      if (bounds === null) return;
      const pct = windowToPercent(win, bounds);
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
    pixelToTs(px) {
      const value = chart.convertFromPixel({ xAxisIndex: 0 }, [px, 0]);
      if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
      return null;
    },
    width() {
      return chart.getWidth();
    },
    resize() {
      chart.resize();
    },
    dispose() {
      chart.off('datazoom', listener);
      chart.dispose();
    },
  };
}