<script lang="ts">
  import { onMount } from 'svelte';
  import { Card } from 'noph-ui';
  import { fetchSeries, fetchSessions, type SessionSummary } from '../lib/api';
  import { createApiLoader } from '../lib/apiSession.svelte';
  import {
    buildBsocOption,
    classifyWheel,
    clampWindow,
    EV_COLOR,
    fetchWindowFor,
    HOME_COLOR,
    INITIAL_SPAN_MS,
    MAX_SPAN_MS,
    needsRefetch,
    newestSampleTs,
    panBy,
    panMsFor,
    readoutAt,
    sessionEdgesVisible,
    spanOf,
    zoomAt,
    zoomFactorFor,
    type BsocData,
    type TimeWindow,
  } from './bsocChart';
  import { createChart, type ChartHandle } from './bsocChartView';

  /** Newest-first page size (the server's max) for session markers. */
  const SESSIONS_PAGE = 200;
  /** Safety cap: 10 pages = 2000 sessions, far beyond realistic volume. */
  const MAX_SESSION_PAGES = 10;
  /** Debounce between zoom/pan interaction and a lazy refetch. */
  const REFRESH_DEBOUNCE_MS = 300;

  const now0 = Date.now();
  /**
   * The DOMAIN: now − 1 yr .. now, frozen at page init (a moving "now" would
   * make fetchWindowFor's right clamp outpace the loaded window and loop
   * refetches). Zoom/pan clamp into the domain and the axis spans it; the
   * loaded window only gates lazy refetching.
   */
  const domain: TimeWindow = { from: now0 - MAX_SPAN_MS, to: now0 };
  /** Window the next fetch loads — starts at the last 24 h. */
  let requested: TimeWindow = { from: now0 - INITIAL_SPAN_MS, to: now0 };

  /** Page sessions (newest first) until they cover the window. */
  async function fetchSessionsCovering(win: TimeWindow): Promise<SessionSummary[]> {
    const all: SessionSummary[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const res = await fetchSessions(SESSIONS_PAGE, offset);
      total = res.total;
      all.push(...res.sessions);
      const oldest = res.sessions[res.sessions.length - 1];
      if (res.sessions.length < SESSIONS_PAGE || all.length >= total) break;
      if (oldest !== undefined && oldest.plugTsMs < win.from) break;
      offset += SESSIONS_PAGE;
    }
    return all;
  }

  async function loadBsoc(win: TimeWindow): Promise<BsocData> {
    const [ev, home, sessions] = await Promise.all([
      fetchSeries('ev_soc', win.from, win.to),
      fetchSeries('battery_soc', win.from, win.to),
      fetchSessionsCovering(win),
    ]);
    return { ev, home, sessions, bounds: win };
  }

  // Load/refresh/auth handling is page-agnostic (lib/apiSession.svelte); no
  // poll — history moves slowly and a tab switch remounts this page anyway.
  const loader = createApiLoader(() => loadBsoc(requested));
  const data = $derived(loader.state.data);
  const empty = $derived(
    data !== null &&
      data.ev.points.length === 0 &&
      data.home.points.length === 0 &&
      data.sessions.length === 0
  );

  let chartEl = $state<HTMLDivElement | null>(null);
  let view: ChartHandle | null = null;
  let boundEl: HTMLDivElement | null = null;
  /** The window the user is looking at; preserved across refetches. */
  let lastVisible: TimeWindow | null = null;
  /** Session-edge visibility baked into the last built option (see sessionEdgesVisible). */
  let edgesVisible: boolean | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: ResizeObserver | null = null;

  /** Timestamp under the pointer; null (initial / pointer leave / post-pinch) = newest sample. */
  let hoverTs = $state<number | null>(null);
  const readout = $derived.by(() => {
    const current = data;
    if (current === null) return null;
    return readoutAt(current.ev, current.home, hoverTs ?? newestSampleTs(current.ev, current.home));
  });

  function handlePointerMove(tsMs: number | null): void {
    hoverTs = tsMs;
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      const current = loader.state.data;
      if (current === null || lastVisible === null) return;
      // Session-edge visibility is baked into the option; when the zoom span
      // crosses the week threshold without a refetch, rebuild (debounced, so
      // never mid-gesture) to add/remove the start/end lines.
      const edges = sessionEdgesVisible(lastVisible);
      if (view !== null && edges !== edgesVisible) {
        edgesVisible = edges;
        view.setOption(buildBsocOption(current, lastVisible, domain, Date.now()), domain);
      }
      if (!needsRefetch(lastVisible, current.bounds, domain)) return;
      requested = fetchWindowFor(lastVisible, domain);
      void loader.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  function handleZoomWindow(win: TimeWindow): void {
    lastVisible = win;
    scheduleRefresh();
  }

  function onWheel(event: WheelEvent): void {
    const current = loader.state.data;
    if (view === null || lastVisible === null || current === null) return;
    const gesture = classifyWheel(event.deltaX, event.deltaY);
    if (gesture.kind === 'none') return;
    // Capture phase + stop: ECharts' dataZoom roam controller calls
    // preventDefault/stopPropagation on every wheel over the grid even with
    // wheel zoom disabled (its zrender listener sits on an inner div), so a
    // bubble listener on the chart element never fires. Owning the wheel here
    // keeps classifyWheel/zoomAt/panBy as the single wheel path.
    event.preventDefault();
    event.stopPropagation();
    if (gesture.kind === 'zoom') {
      // Wheel offsetX is relative to the event target (a canvas child of the
      // chart element) — rebase it on the chart box for the pixel lookup.
      const el = event.currentTarget as HTMLElement;
      const px = event.clientX - el.getBoundingClientRect().left;
      const anchor = view.pixelToTs(px) ?? (lastVisible.from + lastVisible.to) / 2;
      view.applyWindow(zoomAt(lastVisible, domain, anchor, zoomFactorFor(event.deltaY)));
    } else {
      // classifyWheel gives direction = sign(deltaX), so deltaX is already
      // the signed scrub distance in pixels.
      const deltaMs = panMsFor(event.deltaX, view.width(), spanOf(lastVisible));
      view.applyWindow(panBy(lastVisible, domain, deltaMs));
    }
  }

  // Chart lifecycle: init once per chart element, then re-apply the option
  // whenever data (re)loads — preserving the user's window, clamped into the
  // domain (never back into the loaded bounds; lazy refetch fills the view).
  $effect(() => {
    const current = loader.state.data;
    const el = chartEl;
    if (el !== boundEl) {
      if (view !== null) {
        view.dispose();
        view = null;
      }
      observer?.disconnect();
      observer = null;
      boundEl?.removeEventListener('wheel', onWheel, { capture: true });
      boundEl = el;
    }
    if (current === null || el === null) return;
    if (view === null) {
      view = createChart(el, handleZoomWindow);
      if (view === null) return;
      el.addEventListener('wheel', onWheel, { passive: false, capture: true });
      observer = new ResizeObserver(() => view?.resize());
      observer.observe(el);
    }
    lastVisible = lastVisible === null ? current.bounds : clampWindow(lastVisible, domain);
    view.onDataZoom(handleZoomWindow);
    view.onPointerMove(handlePointerMove);
    view.setOption(buildBsocOption(current, lastVisible, domain, Date.now()), domain);
    edgesVisible = sessionEdgesVisible(lastVisible);
  });

  onMount(() => {
    const stop = loader.start();
    return () => {
      stop();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      observer?.disconnect();
      boundEl?.removeEventListener('wheel', onWheel, { capture: true });
      view?.dispose();
      view = null;
    };
  });
</script>

<section class="then">
  <h1 class="title">Then</h1>

  {#if !loader.state.loaded}
    <div class="skeleton chart-skeleton" aria-hidden="true"></div>
    <p class="hint" role="status">Loading…</p>
  {:else if loader.state.error !== null && data === null}
    <Card variant="elevated" headline="Can't reach the read API">
      <p class="hint">{loader.state.error}</p>
      <button type="button" onclick={() => void loader.refresh()}>Retry</button>
    </Card>
  {:else if data !== null}
    {#if empty}
      <p class="empty" role="status">
        No samples yet — the daemon records one every 2 minutes once it's running.
      </p>
    {:else}
      <div
        class="chart"
        bind:this={chartEl}
        data-evcc-swipe-ignore
        role="img"
        aria-label="Vehicle and home battery state of charge over time, charging sessions marked"
      ></div>
      {#if readout !== null}
        <div class="readout">
          <span class="readout-ts">{readout.tsLabel}</span>
          <span class="readout-item">
            <span class="swatch" style:background-color={HOME_COLOR}></span>
            <span>🏠: {readout.homeLabel}</span>
          </span>
          <span class="readout-sep" aria-hidden="true">|</span>
          <span class="readout-item">
            <span class="swatch" style:background-color={EV_COLOR}></span>
            <span>🚗: {readout.evLabel}</span>
          </span>
        </div>
      {/if}
    {/if}
    {#if loader.state.error !== null}
      <p class="warn" role="alert">
        Refresh failed: {loader.state.error} — showing the last good data.
      </p>
    {/if}
  {/if}
</section>

<style>
  /* Full-container-width chart (requirements 2b) in a single-column stack. */
  .then {
    display: flex;
    flex-direction: column;
    gap: var(--evcc-space-3, 16px);
    width: 100%;
  }

  .title {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 600;
  }

  .hint {
    margin: 0;
    opacity: 0.75;
    font-size: 0.95rem;
  }

  .empty {
    margin: var(--evcc-space-4, 24px) 0;
    text-align: center;
    opacity: 0.75;
  }

  .warn {
    margin: 0;
    font-size: 0.9rem;
    color: var(--np-color-error, #b3261e);
  }

  button {
    font: inherit;
    padding: var(--evcc-space-1, 4px) var(--evcc-space-3, 16px);
    cursor: pointer;
  }

  /* ECharts needs an explicit box; width is the full container. */
  .chart {
    width: 100%;
    height: clamp(200px, 40vh, 360px);
  }

  /* Static readout row (the chart's legend + tooltip replacement). */
  .readout {
    display: flex;
    align-items: center;
    gap: var(--evcc-space-3, 16px);
    font-size: 0.95rem;
    font-variant-numeric: tabular-nums;
  }

  .readout-ts {
    opacity: 0.75;
  }

  .readout-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .readout-sep {
    opacity: 0.4;
  }

  /* Color key: matches the series colors exported from bsocChart.ts. */
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex: none;
  }

  .skeleton {
    background: color-mix(in srgb, var(--np-color-on-surface, #1a1a1a) 8%, transparent);
    border-radius: 12px;
    animation: pulse 1.2s ease-in-out infinite alternate;
  }

  .chart-skeleton {
    height: clamp(200px, 40vh, 360px);
  }

  @keyframes pulse {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
