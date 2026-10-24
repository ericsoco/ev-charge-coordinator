/**
 * App-credential selection for `authenticate`.
 *
 * The rules this encodes all address one trap: the stored client ID/secret
 * belong to a Tesla application that may have been recreated or had its secret
 * rotated, and re-running OAuth with the dead pair produces an authorize URL
 * that can only fail in the browser:
 *
 *  - explicit flags always win and are never silently paired with a stored
 *    counterpart (a new client ID with the old stored secret is broken);
 *  - stored credentials are reused only after the operator says so;
 *  - a dead pair is detected up front (token-endpoint probe) instead of at the
 *    browser, and 'unknown' probe results never block the flow.
 *
 * Everything injectable (ask / askSecret / probe) so the matrix is unit
 * testable; index.ts wires the real prompt and probe implementations.
 */

export interface AppCredentialSource {
  clientId?: string;
  clientSecret?: string;
}

export interface CredentialIO {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
}

/** Token-endpoint probe verdict; 'unknown' means "do not block". */
export type ClientCredentialProbe = 'ok' | 'invalid' | 'unknown';

export interface SelectAppCredentialsDeps {
  existing: AppCredentialSource | undefined;
  flags: AppCredentialSource;
  io: CredentialIO;
  /**
   * Best-effort liveness check for a client ID. Called only when no flags were
   * given and stored credentials exist. Implementations must never receive —
   * and must not be able to receive — a real refresh token: Tesla refresh
   * tokens are single-use, and burning one forces a full re-pair.
   */
  probe: (clientId: string) => Promise<ClientCredentialProbe>;
  /** User-facing informational line (status, not errors). */
  note: (message: string) => void;
}

export type SelectedAppCredentials = { clientId: string; clientSecret: string } | { rejected: true };

export function reuseQuestion(clientId: string): string {
  return `Re-use the stored app credentials (client ID ${clientId})? (y/n): `;
}

async function promptForNewCredentials(io: CredentialIO): Promise<AppCredentialSource & { clientId: string; clientSecret: string }> {
  return {
    clientId: (await io.ask('Client ID: ')).trim(),
    clientSecret: (await io.askSecret('Client Secret: ')).trim(),
  };
}

export async function selectAppCredentials(
  deps: SelectAppCredentialsDeps
): Promise<SelectedAppCredentials> {
  const { existing, flags, io } = deps;

  // Flags are explicit intent: use them, prompt only for what is missing, and
  // never fall back to the stored counterpart of a supplied flag.
  if (flags.clientId !== undefined || flags.clientSecret !== undefined) {
    return {
      clientId: flags.clientId ?? (await io.ask('Client ID: ')).trim(),
      clientSecret: flags.clientSecret ?? (await io.askSecret('Client Secret: ')).trim(),
    };
  }

  if (existing?.clientId && existing.clientSecret) {
    // Auto-detection: a stored pair Tesla no longer recognizes is a dead end
    // at the browser; say so here and take new values instead of asking.
    if ((await deps.probe(existing.clientId)) === 'invalid') {
      deps.note(
        'Tesla does not recognize the stored client ID/secret (app recreated or rotated?).'
      );
      const entered = await promptForNewCredentials(io);
      if ((await deps.probe(entered.clientId)) === 'invalid') {
        return { rejected: true };
      }
      return entered;
    }
    // 'ok' and 'unknown' both land here: the reuse question is the safe
    // default and the probe never blocks an uncertain network.
    const answer = (await io.ask(reuseQuestion(existing.clientId))).trim().toLowerCase();
    if (answer === 'y') {
      return { clientId: existing.clientId, clientSecret: existing.clientSecret };
    }
    return promptForNewCredentials(io);
  }

  return promptForNewCredentials(io);
}
