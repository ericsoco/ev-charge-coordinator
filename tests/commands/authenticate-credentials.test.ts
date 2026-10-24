/**
 * authenticate credential selection: reuse-vs-replace, flag precedence, and
 * dead-app auto-detection via the injected client-credential probe.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reuseQuestion,
  selectAppCredentials,
  type ClientCredentialProbe,
  type CredentialIO,
} from '../../src/commands/authenticate.js';

const STORED = { clientId: 'OLD_ID', clientSecret: 'OLD_SECRET' };

function fakeIO(answers: Record<string, string>): { io: CredentialIO; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    io: {
      ask: async (question) => {
        asked.push(question);
        return answers[question] ?? '';
      },
      askSecret: async (question) => {
        asked.push(question);
        return answers[question] ?? '';
      },
    },
  };
}

async function neverProbe(): Promise<ClientCredentialProbe> {
  throw new Error('probe must not be called');
}

describe('selectAppCredentials', () => {
  it('reuses stored credentials on yes (probe ok)', async () => {
    const probed: string[] = [];
    const { io, asked } = fakeIO({ [reuseQuestion('OLD_ID')]: 'y' });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: {},
      io,
      probe: async (clientId) => {
        probed.push(clientId);
        return 'ok';
      },
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'OLD_ID', clientSecret: 'OLD_SECRET' });
    expect(probed).toEqual(['OLD_ID']);
    expect(asked).toEqual([reuseQuestion('OLD_ID')]);
  });

  it('prompts for new credentials on no (probe ok)', async () => {
    const { io, asked } = fakeIO({
      [reuseQuestion('OLD_ID')]: 'n',
      'Client ID: ': 'NEW_ID',
      'Client Secret: ': 'NEW_SECRET',
    });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: {},
      io,
      probe: async () => 'ok',
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'NEW_ID', clientSecret: 'NEW_SECRET' });
    expect(asked).toEqual([reuseQuestion('OLD_ID'), 'Client ID: ', 'Client Secret: ']);
  });

  it('treats an unknown probe result as ok: the reuse question still asks, nothing blocks', async () => {
    const { io } = fakeIO({ [reuseQuestion('OLD_ID')]: 'y' });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: {},
      io,
      probe: async () => 'unknown',
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'OLD_ID', clientSecret: 'OLD_SECRET' });
  });

  it('dead stored pair: skips the reuse question, prompts new, re-probes', async () => {
    const probed: string[] = [];
    const notes: string[] = [];
    const { io, asked } = fakeIO({ 'Client ID: ': 'NEW_ID', 'Client Secret: ': 'NEW_SECRET' });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: {},
      io,
      probe: async (clientId) => {
        probed.push(clientId);
        return clientId === 'OLD_ID' ? 'invalid' : 'ok';
      },
      note: (message) => notes.push(message),
    });
    expect(result).toEqual({ clientId: 'NEW_ID', clientSecret: 'NEW_SECRET' });
    expect(probed).toEqual(['OLD_ID', 'NEW_ID']);
    expect(asked).toEqual(['Client ID: ', 'Client Secret: ']);
    expect(notes[0]).toContain('does not recognize the stored client');
  });

  it('dead pair and dead entry: rejected (no browser round trip)', async () => {
    const { io } = fakeIO({ 'Client ID: ': 'ALSO_DEAD', 'Client Secret: ': 'X' });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: {},
      io,
      probe: async () => 'invalid',
      note: () => {},
    });
    expect(result).toEqual({ rejected: true });
  });

  it('flags skip the probe and every prompt', async () => {
    const { io, asked } = fakeIO({});
    const result = await selectAppCredentials({
      existing: STORED,
      flags: { clientId: 'FLAG_ID', clientSecret: 'FLAG_SECRET' },
      io,
      probe: neverProbe,
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'FLAG_ID', clientSecret: 'FLAG_SECRET' });
    expect(asked).toEqual([]);
  });

  it('a partial flag prompts for the missing half, never the stored counterpart', async () => {
    const { io } = fakeIO({ 'Client Secret: ': 'TYPED_SECRET' });
    const result = await selectAppCredentials({
      existing: STORED,
      flags: { clientId: 'FLAG_ID' },
      io,
      probe: neverProbe,
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'FLAG_ID', clientSecret: 'TYPED_SECRET' });
  });

  it('fresh setup (nothing stored) prompts for both, no probe', async () => {
    const { io, asked } = fakeIO({ 'Client ID: ': 'ID1', 'Client Secret: ': 'SEC1' });
    const result = await selectAppCredentials({
      existing: undefined,
      flags: {},
      io,
      probe: neverProbe,
      note: () => {},
    });
    expect(result).toEqual({ clientId: 'ID1', clientSecret: 'SEC1' });
    expect(asked).toEqual(['Client ID: ', 'Client Secret: ']);
  });
});

describe('wiring', () => {
  const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const SERVICE_SOURCE = readFileSync(
    new URL('../../src/services/TeslaService.ts', import.meta.url),
    'utf8'
  );

  it('runAuthenticate routes selection through selectAppCredentials with the real probe', () => {
    expect(INDEX_SOURCE).toContain('selectAppCredentials({');
    expect(INDEX_SOURCE).toContain('probeClientCredentials({');
    expect(INDEX_SOURCE).toContain('validateStatus: () => true');
  });

  it('refreshTokens classifies token-endpoint failures for the operator', () => {
    expect(SERVICE_SOURCE).toContain('classifyTokenEndpointError(error)');
    expect(SERVICE_SOURCE).toContain('app recreated or rotated');
    expect(SERVICE_SOURCE).toContain('rejected the refresh token');
  });

  it('registration failures surface Tesla body and stop the pairing flow', () => {
    expect(INDEX_SOURCE).toContain('Registration failed while trying to ${phase}');
    expect(INDEX_SOURCE).toContain('if (!(await registerDomainWithTesla');
  });
});
