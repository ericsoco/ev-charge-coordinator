<script lang="ts">
  import {
    NavigationBar,
    NavigationBarItem,
    NavigationRail,
    NavigationRailItem,
  } from 'noph-ui';
  import { TABS, type TabId } from '../lib/tabs';

  interface Props {
    active: TabId;
    onselect: (id: TabId) => void;
  }

  let { active, onselect }: Props = $props();
</script>

<!--
  M3 window-size classes (requirements 1c): bottom navigation bar on
  compact/medium, navigation rail on expanded (≥840px). Both render; CSS
  swaps so the layout needs no JS. Emoji icons are the requirements'
  literal ⚡️/🔄/💬 and cost no font payload.
-->
<div class="bar">
  <NavigationBar aria-label="Main">
    {#each TABS as tab (tab.id)}
      <NavigationBarItem
        label={tab.label}
        selected={active === tab.id}
        onclick={() => onselect(tab.id)}
      >
        {#snippet icon()}<span aria-hidden="true">{tab.icon}</span>{/snippet}
      </NavigationBarItem>
    {/each}
  </NavigationBar>
</div>

<div class="rail">
  <NavigationRail aria-label="Main">
    {#each TABS as tab (tab.id)}
      <NavigationRailItem
        label={tab.label}
        selected={active === tab.id}
        onclick={() => onselect(tab.id)}
      >
        {#snippet icon()}<span aria-hidden="true">{tab.icon}</span>{/snippet}
      </NavigationRailItem>
    {/each}
  </NavigationRail>
</div>

<style>
  .bar {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 10;
    background: var(--np-navigation-bar-container-color, var(--np-color-surface, #fff));
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .rail {
    display: none;
  }

  @media (min-width: 840px) {
    .bar {
      display: none;
    }

    .rail {
      display: block;
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 10;
    }
  }
</style>