/**
 * Run scripts/spike-franklin-history.py with credentials from the store.
 *
 * Python resolution matches `npm run check:franklin` (run-python-check.mjs).
 * Credentials prefer a complete FRANKLIN_* environment (the live-test
 * convention) and otherwise come from the CLI's own CredentialStore — passed
 * to the child as environment only, never printed, never written to disk.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePython } from './run-python-check.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildEnv() {
  const env = { ...process.env };
  const complete =
    env.FRANKLIN_PASSWORD &&
    (env.FRANKLIN_USERNAME || env.FRANKLIN_EMAIL) &&
    env.FRANKLIN_GATEWAY_ID;
  if (complete) return env;

  let store;
  try {
    const mod = await import(
      pathToFileURL(path.join(projectRoot, 'dist/utils/credentials.js')).href
    );
    store = new mod.CredentialStore();
  } catch (err) {
    console.error(`✗ Could not load dist/utils/credentials.js: ${err.message}`);
    console.error('  Fix: npm run build');
    process.exit(1);
  }

  let creds;
  try {
    creds = await store.getFranklinCredentials();
  } catch (err) {
    console.error(`✗ Could not read the credential store: ${err.message}`);
    console.error(
      '  Set FRANKLIN_USERNAME/FRANKLIN_PASSWORD/FRANKLIN_GATEWAY_ID instead.'
    );
    process.exit(1);
  }
  if (!creds) {
    console.error('✗ No FranklinWH credentials in the store.');
    console.error(
      '  Set FRANKLIN_USERNAME/FRANKLIN_PASSWORD/FRANKLIN_GATEWAY_ID, or run the CLI once.'
    );
    process.exit(1);
  }

  env.FRANKLIN_USERNAME = env.FRANKLIN_USERNAME || env.FRANKLIN_EMAIL || creds.username;
  env.FRANKLIN_PASSWORD = env.FRANKLIN_PASSWORD || creds.password;
  env.FRANKLIN_GATEWAY_ID = env.FRANKLIN_GATEWAY_ID || creds.gatewayId;
  return env;
}

const env = await buildEnv();
const { command, source } = resolvePython();
const script = path.join(projectRoot, 'scripts/spike-franklin-history.py');
const child = spawn(command, [script], { env, stdio: 'inherit' });
child.on('error', () => {
  console.error(`✗ Could not run ${source} (${command}).`);
  console.error('  Fix: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
