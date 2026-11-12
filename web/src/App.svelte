<script lang="ts">
  import Nav from './components/Nav.svelte';
  import TokenPanel from './components/TokenPanel.svelte';
  import Messages from './pages/Messages.svelte';
  import Now from './pages/Now.svelte';
  import Then from './pages/Then.svelte';
  import { session } from './lib/apiSession.svelte';
  import { DEFAULT_TAB, TABS, type TabId } from './lib/tabs';

  let active = $state<TabId>(DEFAULT_TAB);
  const currentLabel = $derived(TABS.find((tab) => tab.id === active)?.label ?? '');
</script>

<div class="shell">
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