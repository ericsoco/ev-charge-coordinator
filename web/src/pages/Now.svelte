<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Card } from 'noph-ui';
  import { AuthError, fetchNow, setApiToken, type NowResponse } from '../lib/api';
  import { batteryCaption, formatAge, sessionLine, vehicleCaption } from '../lib/nowText';

  /** Poll cadence (P2 decisions: polling, no SSE). Tests pass a short one. */
  let { pollMs = 10_000 }: { pollMs?: number } = $props();

  /**
   * Staleness keys off the BATTERY sample: it is the daemon's regular
   * heartbeat (every 2 min by default), while the vehicle sample legitimately
   * ages while the car sleeps. 5 min ≈ 2+ missed sampler ticks.
   */
  const STALE_MS = 5 * 60_000;

  let data = $state<NowResponse | null>(null);
  let error = $state<string | null>(null);
  let needsToken = $state(false);
  let tokenDraft = $state('');
  /** First fetch settled — distinguishes the skeleton from every real state. */
  let loaded = $state(false);

  const stale = $derived(
    data !== null && data.battery !== null && data.battery.ageMs > STALE_MS
  );
  const empty = $derived(
    data !== null && data.vehicle === null && data.battery === null
  );
  const line = $derived(sessionLine(data));
  // Single expression per caption: whitespace around the conditional separator
  // is then exact (Svelte trims block-boundary whitespace otherwise).
  const vehicleText = $derived(
    vehicleCaption(data?.vehicle ?? null) +
      (data?.vehicle ? ` · updated ${formatAge(data.vehicle.ageMs)}` : '')
  );
  const batteryText = $derived(
    batteryCaption(data?.battery ?? null) +
      (data?.battery ? ` · updated ${formatAge(data.battery.ageMs)}` : '')
  );

  async function refresh(): Promise<void> {
    try {
      data = await fetchNow();
      error = null;
      needsToken = false;
    } catch (cause) {
      if (cause instanceof AuthError) {
        needsToken = true;
        error = null;
      } else {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      loaded = true;
    }
  }

  function saveToken(): void {
    const token = tokenDraft.trim();
    if (token === '') return;
    setApiToken(token);
    tokenDraft = '';
    needsToken = false;
    void refresh();
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<section class="now">
  <h1 class="title">Now</h1>

  {#if needsToken}
    <Card variant="elevated" headline="API token required">
      <form
        aria-label="API token"
        class="token-form"
        onsubmit={(event) => {
          event.preventDefault();
          saveToken();
        }}
      >
        <label for="api-token">
          Paste the read API token — run <code>ev-charge-coordinator api-token</code> on the
          host to print it. Stored on this device only.
        </label>
        <div class="token-row">
          <input id="api-token" type="password" autocomplete="off" bind:value={tokenDraft} />
          <button type="submit">Save</button>
        </div>
      </form>
    </Card>
  {:else if !loaded}
    <div class="skeleton card-skeleton" aria-hidden="true"></div>
    <div class="skeleton card-skeleton" aria-hidden="true"></div>
    <div class="skeleton line-skeleton" aria-hidden="true"></div>
    <p class="hint" role="status">Loading…</p>
  {:else if error !== null && data === null}
    <Card variant="elevated" headline="Can't reach the read API">
      <p class="hint">{error}</p>
      <button type="button" onclick={() => void refresh()}>Retry</button>
    </Card>
  {:else if empty}
    <p class="empty" role="status">
      No samples yet — the daemon records one every 2 minutes once it's running.
    </p>

  {:else if data !== null}
    {#if stale}
      <Badge label="Sampling delayed — is the daemon running?" />
    {/if}
    <Card variant="elevated" headline="Vehicle">
      <p class="big">{data.vehicle?.socPercent ?? '—'}<span class="unit">%</span></p>
      <p class="caption">{vehicleText}</p>
    </Card>
    <Card variant="elevated" headline="Home battery">
      <p class="big">{data.battery?.socPercent ?? '—'}<span class="unit">%</span></p>
      <p class="caption">{batteryText}</p>
    </Card>
    <p class="session" role="status">{line}</p>
    {#if error !== null}
      <p class="warn" role="alert">Refresh failed: {error} — showing the last good sample.</p>
    {/if}
  {/if}
</section>

<style>
  /* Single-column, mobile-first stack (step-3 layout brief): vehicle card,
     battery card, session line. Centered on wide viewports. */
  .now {
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

  .big {
    margin: var(--evcc-space-2, 8px) 0 var(--evcc-space-1, 4px);
    font-size: clamp(4rem, 24vw, 6.5rem);
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .unit {
    font-size: 0.4em;
    font-weight: 600;
    margin-left: 0.05em;
  }

  .caption,
  .hint {
    margin: 0;
    opacity: 0.75;
    font-size: 0.95rem;
  }

  .session {
    margin: 0;
    font-size: 1.1rem;
    text-align: center;
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

  .token-form {
    display: flex;
    flex-direction: column;
    gap: var(--evcc-space-2, 8px);
  }

  .token-row {
    display: flex;
    gap: var(--evcc-space-2, 8px);
  }

  .token-row input {
    flex: 1;
    min-width: 0;
    padding: var(--evcc-space-1, 4px) var(--evcc-space-2, 8px);
    font: inherit;
  }

  button {
    font: inherit;
    padding: var(--evcc-space-1, 4px) var(--evcc-space-3, 16px);
    cursor: pointer;
  }

  /* First-paint skeletons — subtle pulse, motion off for reduced preference. */
  .skeleton {
    background: color-mix(in srgb, var(--np-color-on-surface, #1a1a1a) 8%, transparent);
    border-radius: 12px;
    animation: pulse 1.2s ease-in-out infinite alternate;
  }

  .card-skeleton {
    height: 168px;
  }

  .line-skeleton {
    height: 24px;
    width: 70%;
    align-self: center;
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
