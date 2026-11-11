/**
 * `api-token`: print the read API's shared bearer token.
 *
 * The token is minted on first use and printed alone on stdout so it can be
 * piped/copied; `--help` carries the usage context. The daemon's boot log
 * line prints the same token (see docs/api.md).
 */
import { Command } from 'commander';
import { credentialStore } from '../utils/credentials.js';

export interface ApiTokenDeps {
  /** Defaults to the credential store's mint-on-first-use token. */
  getToken?: () => Promise<string>;
}

export function createApiTokenCommand(deps: ApiTokenDeps = {}): Command {
  const getToken = deps.getToken ?? (() => credentialStore.ensureApiToken());
  return new Command('api-token')
    .allowExcessArguments(false)
    .description("Show the read API's shared bearer token (mints it on first use)")
    .action(async () => {
      console.log(await getToken());
    });
}
