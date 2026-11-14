<script lang="ts">
  import { onMount } from 'svelte';
  import Nav from './components/Nav.svelte';
  import TokenPanel from './components/TokenPanel.svelte';
  import Messages from './pages/Messages.svelte';
  import Now from './pages/Now.svelte';
  import Then from './pages/Then.svelte';
  import { session } from './lib/apiSession.svelte';
  import { DEFAULT_TAB, TABS, type TabId } from './lib/tabs';
  import { adjacentTabId, classifySwipe, SWIPE_IGNORE_ATTR } from './lib/swipe';

  let active = $state<TabId>(DEFAULT_TAB);
  const currentLabel = $derived(TABS.find((tab) => tab.id === active)?.label ?? '');

  let shellEl: HTMLDivElement | null = null;
  /** Start of the one-finger gesture in flight; null = none (or opted out). */
  let swipeStart: { x: number; y: number; t: number } | null = null;

  function onTouchStart(event: TouchEvent): void {
    swipeStart = null;
    if (event.touches.length !== 1) return; // multi-touch is a pinch, not a swipe
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Charts own their gestural interface (pan/pinch/readout); the nav is its
    // own control — gestures starting there never switch tabs.
    if (target.closest(`[${SWIPE_IGNORE_ATTR}]`) !== null) return;
    const touch = event.touches[0];
    if (touch === undefined) return;
    swipeStart = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
  }

  function onTouchEnd(event: TouchEvent): void {
    const start = swipeStart;
    swipeStart = null;
    if (start === null) return;
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    const direction = classifySwipe(
      touch.clientX - start.x,
      touch.clientY - start.y,
      event.timeStamp - start.t
    );
    if (direction === null) return;
    active = adjacentTabId(active, direction) ?? active;
  }

  onMount(() => {
    const el = shellEl;
    if (el === null) return;
    // Capture on touchstart so chart libs that stopPropagation cannot hide
    // where the gesture began (the ignore rule is decided at start, and a
    // touch's target is fixed for its whole duration). Passive throughout:
    // never preventDefault, so scrolling and chart gestures stay untouched.
    el.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });
</script>

<div class="shell" bind:this={shellEl}>
  <Nav {active} onselect={(id) => (active = id)} />
  {#if session.needsToken}
    <div class="token-gate">
      <TokenPanel />
    </div>
  {/if}
  <main class="panel" aria-label={currentLabel}>
    {#if active === 'now'}
      <Now />
    {:else if active === 'then'}
      <Then />
    {:else}
      <Messages />
    {/if}
  </main>
</div>

<style>
  .shell {
    min-height: 100vh;
    min-height: 100dvh;
  }

  .panel {
    padding: var(--evcc-space-3, 16px);
    /* Clears the fixed bottom bar + home-indicator inset (thumb zone). */
    padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px) + var(--evcc-space-3, 16px));
  }

  /* Shared auth gate (App-level, any deeplinked page raises it). */
  .token-gate {
    padding: var(--evcc-space-3, 16px);
    padding-bottom: 0;
    max-width: 640px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  /* M3 expanded (≥840px): navigation rail on the left instead. */
  @media (min-width: 840px) {
    .panel {
      margin-left: 96px; /* collapsed M3 rail width */
      padding-bottom: var(--evcc-space-3, 16px);
    }
  }
</style>