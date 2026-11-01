11/1/2026, ~2:15 PM

# Charting Library Evaluation for the ev-charge-coordinator Dashboard

## Context I gathered first

- **App license:** MIT (`/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/LICENSE`) — permissive, so license compatibility is mainly about *attribution/watermark* requirements, not copyleft.
- **Data volume:** the daemon samples the battery every ~2 min (~720 rows/day) and polls EV state every 1–2 min, with raw rows pruned after `retentionDays: 90` (see `/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/src/utils/daemonConfig.ts`, `src/store/*Store.ts` prune). So the dashboard will chart **tens of thousands of points max** (~65k battery + ~130k EV rows at full retention) — small by modern standards, and downsampled/aggregated views will be far smaller. All candidates below handle this easily; the differentiators are bundle size, responsiveness ergonomics, and licensing.
- **Architecture note:** there's no web framework yet; design.md anticipates an HTTP seam for Phase 2. So framework-agnostic libraries are safer bets than React-bound ones.

## Comparison (gzipped sizes from Bundlephobia)

| Library | License | Gzipped | Tree-shakable | Renderer | Notes |
|---|---|---|---|---|---|
| **uPlot** | MIT | **21.3 kB** | n/a (single small module, 0 deps) | Canvas | Built specifically for time series; fastest of the group |
| **lightweight-charts** (TradingView) | Apache-2.0 | 60.1 kB | Partial | Canvas | Excellent time-axis/zoom, but finance-oriented (candles, OHLC) |
| **Chart.js** | MIT | 68 kB | Yes (`some side-effects`) — tree-shakes well in practice | Canvas | Great docs, huge ecosystem; needs date adapter for time scale |
| **amCharts 5** | Free "freeware" license OR paid | 111.7 kB | Claims tree-shakable but 25 deps (tslib, d3-shape…) | Canvas + SVG | Beautiful defaults, heaviest engineering footprint |
| **Recharts** | MIT | 146.4 kB | Yes (side-effect free) | SVG | **React-only** — locks you into React |
| **ApexCharts** | MIT | 266 kB | Poor in practice (monolithic, 910 kB minified) | SVG | Pretties API, worst bundle |
| **ECharts** | Apache-2.0 | 359 kB full; ~½ that via `echarts/core` modular imports | Yes (`echarts/core` + individual chart imports) | Canvas (+ optional SVG) | Most powerful; heavier |

## Evaluation against your four criteria

### 1. Bundle size / tree-shaking
Tree-shaking is real for Chart.js, ECharts (`echarts/core`), and Recharts; amCharts publishes ES modules and claims shakability, but its 25-dependency graph and framework integration packages (`@amcharts/amcharts5-react`) make the floor higher. **uPlot wins outright** at 21 kB — it's one file, no deps, nothing to shake. ApexCharts is the clear loser (~911 kB minified, essentially unshakable). For a locally-served dashboard "size" matters less than for a website, but small keeps it snappy on mobile networks.

### 2. Responsiveness
- **Chart.js, ECharts, amCharts, ApexCharts:** all ship responsive modes — Chart.js via `responsive: true` + `maintainAspectRatio`, ECharts via a `resize` listener or its built-in `resize: true`, amCharts auto-adapts via `layout` templates, ApexCharts has a `responsive` config array for breakpoint-based options. All fine.
- **uPlot:** intentionally minimal — you get a container-size hook and `setSize()`, but layout/legend responsiveness is **you write it** (~10 lines wiring a `ResizeObserver`). Small tax, real work.
- **Recharts** requires React and relies on a container measurement; fine but framework-locking.

### 3. Performance at our data scale
Our worst case is ~200k raw points across 90 days, typically displayed as aggregated/downsampled ranges (day/week views) — every library here handles that. Ranking by headroom:
- **uPlot** is purpose-built for large time series; routinely demos 1M+ points at 60 fps. Most headroom as data grows (you mentioned it will grow).
- **ECharts** handles large series with `large: true` / `sampling: 'lttb'` modes on canvas. Very good.
- **amCharts** is fine at our scale but is SVG-hybrid by default; it recommends its "stock chart" module for serious time-series scrubbing (a separate paid product for watermark-free commercial use).
- **Chart.js / ApexCharts / Recharts** are SVG- or per-point-DOM heavy; fine for hundreds of points, degrade sooner — mitigated by client-side downsampling (LTTB), which you'd want anyway.

### 4. Licensing (MIT app compatibility)
- **uPlot, Chart.js, ApexCharts, Recharts:** MIT — zero friction.
- **ECharts, lightweight-charts:** Apache-2.0 — permissive; only asks for a NOTICE/attributions file. Fine with MIT.
- **amCharts:** the free "freeware" license **does permit commercial use**, but requires (a) the **amCharts logo/watermark remain visible on every chart** and (b) the LICENSE file ship with the code; you can't sell/redistribute the library itself. Removing branding or using it in redistributable apps cleanly requires a paid license (**$80/seat/yr Basic → $1,200/seat/yr OEM** for redistributable desktop/mobile/web apps per their store). Also, it's **not an OSI-approved license**, so it's the only candidate that makes your MIT app's dependency tree non-permissively-licensed. Not a blocker for a personal project — but the persistent logo on your dashboard and per-seat fees are the strings attached.

## Recommendation

**Primary: uPlot.** Your workload is time-series (battery SoC, EV charge %, power draw, session overlays) — exactly uPlot's design target. MIT, 21 kB, zero deps, fastest at your current *and* future scale. Cost: you hand-roll ~a day of UI polish (resize, legends, tooltip formatting). There's a maintained `uplot` React wrapper if you go React later, and it works fine vanilla with the HTTP-seam architecture in design.md.

**Runner-up: Chart.js** if you want batteries-included polish (legends, tooltips, annotation plugin for charge-session bands, easy bar/pie for session summaries) with a friendly API and MIT license at 68 kB. Slightly less headroom for 100k+ point views, mitigated by downsampling.

**If you ever need rich interactivity** (linked charts, brushing, drill-down, geographic weather overlays): **ECharts** with modular `echarts/core` imports — Apache-2.0, halves the bundle, and its `large`/`sampling` modes cover growth.

**On amCharts specifically:** the free license is workable for a personal/MIT project *if* you accept the logo watermark and ship their LICENSE file; it is **not** compatible with a clean MIT dependency tree or with removing branding without paying ($80–$1,200+/seat/yr). Given a 21 kB MIT alternative exists that's faster for time-series data, amCharts' main advantage (polished default styling) doesn't justify the watermark and cost.

Want me to draft a plan for a spike: uPlot dashboard page served from the daemon's HTTP seam, with day/week/90-day views over the existing SQLite store? (I'm in Plan mode — toggle to Act mode if you'd like me to build it.)