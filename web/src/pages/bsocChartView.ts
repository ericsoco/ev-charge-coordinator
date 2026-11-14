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
import { percentToWindow, touchReadout, windowToPercent, type TimeWindow, type TouchPhase } from './bsocChart';

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
  // Touch is read directly here: zrender drops touch moves on the pointer-
  // events path and its synthesized ones carry no offsetX, so without this
  // the static row could only ever show the newest sample on touch devices.
  // Single finger pins (tap/drag → tooltip-like values); a second finger
  // freezes mid-pinch and resets to the newest sample on full lift (the
  // pre-pinch position is stale once the scale has moved). Capture phase:
  // zrender's own touch listeners run first on their inner element during
  // the bubble phase.
  // Down-only cursor rule: a 1 px vertical line at the pointer x — the
  // readout's anchor — visible only while a button/finger is down.
  const rule = document.createElement('div');
  rule.setAttribute('aria-hidden', 'true');
  Object.assign(rule.style, {
    position: 'absolute',
    top: '0',
    bottom: '0',
    width: '1px',
    background: 'currentColor',
    opacity: '0.5',
    pointerEvents: 'none',
    display: 'none',
  });
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.appendChild(rule);
  const setRule = (px: number | null): void => {
    if (px === null || !Number.isFinite(px)) {
      rule.style.display = 'none';
      return;
    }
    rule.style.left = `${px}px`;
    rule.style.display = 'block';
  };
  let lastTouchAt = 0;
  /** Compat mouse events trail a tap by ~300 ms — touch owns state that long. */
  const recentTouch = (): boolean => Date.now() - lastTouchAt < 500;

  const zr = chart.getZr();
  let touchPhase: TouchPhase = { fingers: 0, multi: false };
  const touchHandler =
    (kind: 'start' | 'move' | 'end') =>
    (event: TouchEvent): void => {
      lastTouchAt = Date.now();
      const next = touchReadout(touchPhase, kind, event.touches.length);
      touchPhase = next.phase;
      if (next.action === 'freeze') return; // still down: rule stays put, readout frozen
      if (next.action !== 'pin') setRule(null); // lifted: the rule is down-only
      if (next.action === 'keep') return; // single-finger lift: readout persists
      if (next.action === 'reset') {
        pointerSink(null);
        return;
      }
      const finger = event.touches[0] ?? event.changedTouches[0];
      if (finger === undefined) return;
      const px = finger.clientX - el.getBoundingClientRect().left;
      setRule(px);
      const ts = tsAtX(px);
      if (ts !== null) pointerSink(ts);
    };
  const onTouchStart = touchHandler('start');
  const onTouchMove = touchHandler('move');
  const onTouchEnd = touchHandler('end');
  el.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  el.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
  const pointerListener = (event: { offsetX?: number; clientX?: number; buttons?: number }): void => {
    if (touchPhase.fingers > 0 || recentTouch()) return;
    const rect = el.getBoundingClientRect();
    const px =
      typeof event.offsetX === 'number' && Number.isFinite(event.offsetX)
        ? event.offsetX
        : typeof event.clientX === 'number'
          ? event.clientX - rect.left
          : Number.NaN;
    // Rule is down-only: shown while a button is held, hidden on hover.
    const down = typeof event.buttons === 'number' && event.buttons > 0;
    setRule(down && Number.isFinite(px) ? px : null);
    const ts = Number.isFinite(px) ? tsAtX(px) : null;
    pointerSink(ts);
  };
  const pointerLeaveListener = (): void => {
    setRule(null);
    pointerSink(null);
  };
  zr.on('mousemove', pointerListener);
  zr.on('globalout', pointerLeaveListener);
  // Press anchors the rule at the exact press point (covering click-without-
  // move) and pins the readout there; release anywhere clears the rule.
  const onMouseDown = (event: MouseEvent): void => {
    if (recentTouch()) return;
    const px = event.clientX - el.getBoundingClientRect().left;
    setRule(px);
    pointerSink(tsAtX(px));
  };
  const onMouseUp = (): void => setRule(null);
  el.addEventListener('mousedown', onMouseDown);
  const win = el.ownerDocument.defaultView;
  win?.addEventListener('mouseup', onMouseUp);

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
      setRule(null); // px anchors break across a resize; the readout re-syncs on move
      chart.resize();
    },
    dispose() {
      chart.off('datazoom', listener);
      zr.off('mousemove', pointerListener);
      zr.off('globalout', pointerLeaveListener);
      el.removeEventListener('mousedown', onMouseDown);
      win?.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      rule.remove();
      chart.dispose();
    },
  };
}