<script lang="ts">
  import { onMount } from 'svelte';
  import { Card } from 'noph-ui';
  import { fetchMessages } from '../lib/api';
  import { createApiLoader } from '../lib/apiSession.svelte';
  import { MESSAGES_EMPTY, formatMessageTime } from './messagesText';

  /** Poll cadence — events are rare; focus refresh covers tab switches. */
  let { pollMs = 30_000 }: { pollMs?: number } = $props();

  // Page-agnostic load/auth handling (lib/apiSession.svelte): a 401 raises
  // the app-wide token gate in App instead of page-local UI.
  const loader = createApiLoader(() => fetchMessages(), {
    get pollMs() {
      return pollMs;
    },
  });

  const messages = $derived(loader.state.data?.messages ?? null);

  onMount(() => loader.start());
</script>

<section class="messages">
  <h1 class="title">Messages</h1>

  {#if !loader.state.loaded}
    <div class="skeleton row-skeleton" aria-hidden="true"></div>
    <div class="skeleton row-skeleton" aria-hidden="true"></div>
    <div class="skeleton row-skeleton" aria-hidden="true"></div>
    <p class="hint" role="status">Loading…</p>
  {:else if loader.state.error !== null && messages === null}
    <Card variant="elevated" headline="Can't reach the read API">
      <p class="hint">{loader.state.error}</p>
      <button type="button" onclick={() => void loader.refresh()}>Retry</button>
    </Card>
  {:else if messages !== null && messages.length === 0}
    <p class="empty" role="status">{MESSAGES_EMPTY}</p>
  {:else if messages !== null}
    <ul class="list">
      {#each messages as message (message.id)}
        <li class="row">
          <time class="time" datetime={new Date(message.tsMs).toISOString()}>
            {formatMessageTime(message.tsMs)}
          </time>
          <div class="text">
            <p class="row-title">{message.title}</p>
            <p class="row-body">{message.body}</p>
          </div>
        </li>
      {/each}
    </ul>
    {#if loader.state.error !== null}
      <p class="warn" role="alert">
        Refresh failed: {loader.state.error} — showing the last list.
      </p>
    {/if}
  {/if}
</section>

<style>
  /* Single-column stack (Now's layout brief): title, then newest-first rows. */
  .messages {
    display: flex;
    flex-direction: column;
    gap: var(--evcc-space-3, 16px);
    max-width: 640px;
    margin: 0 auto;
    width: 100%;
  }

  .title {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 600;
  }

  .hint,
  .empty {
    margin: 0;
    opacity: 0.75;
    font-size: 0.95rem;
  }

  .empty {
    margin: var(--evcc-space-4, 24px) 0;
    text-align: center;
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

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--evcc-space-2, 8px);
  }

  .row {
    display: flex;
    gap: var(--evcc-space-3, 16px);
    align-items: baseline;
    padding: var(--evcc-space-2, 8px) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--np-color-on-surface, #1a1a1a) 12%, transparent);
  }

  .row:last-child {
    border-bottom: none;
  }

  .time {
    flex: 0 0 auto;
    font-size: 0.85rem;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .text {
    min-width: 0;
  }

  .row-title {
    margin: 0;
    font-weight: 600;
    font-size: 1rem;
  }

  .row-body {
    margin: 2px 0 0;
    font-size: 0.95rem;
    opacity: 0.85;
    overflow-wrap: anywhere;
  }

  /* First-paint skeletons — subtle pulse, motion off for reduced preference. */
  .skeleton {
    background: color-mix(in srgb, var(--np-color-on-surface, #1a1a1a) 8%, transparent);
    border-radius: 12px;
    animation: pulse 1.2s ease-in-out infinite alternate;
  }

  .row-skeleton {
    height: 56px;
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