<script lang="ts">
  import { Card } from 'noph-ui';
  import { saveToken } from '../lib/apiSession.svelte';

  let draft = $state('');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (draft.trim() === '') return;
    saveToken(draft);
    draft = '';
  }
</script>

<!--
  Shared auth gate (rendered by App whenever session.needsToken): every page
  load that hits a 401 lands here, whichever page was deeplinked first.
-->
<Card variant="elevated" headline="API token required">
  <form
    aria-label="API token"
    class="token-form"
    onsubmit={submit}
  >
    <label for="api-token">
      Paste the read API token — run <code>ev-charge-coordinator api-token</code> on the
      host to print it. Stored on this device only.
    </label>
    <div class="token-row">
      <input id="api-token" type="password" autocomplete="off" bind:value={draft} />
      <button type="submit">Save</button>
    </div>
  </form>
</Card>

<style>
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
</style>
