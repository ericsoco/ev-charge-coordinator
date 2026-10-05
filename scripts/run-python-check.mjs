/**
 * Locate a Python interpreter for the FranklinWH scripts.
 *
 * Order matches FranklinWHService: the project .venv first, because that is where
 * `pip install -r python/requirements.txt` puts franklinwh; then $ECC_PYTHON; then
 * whatever python3 resolves to. Kept as a small module so the two entry points
 * cannot drift.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolvePython() {
  const venv = path.join(projectRoot, '.venv/bin/python');
  if (fs.existsSync(venv)) return { command: venv, source: 'the project .venv' };
  if (process.env.ECC_PYTHON) return { command: process.env.ECC_PYTHON, source: 'ECC_PYTHON' };
  return { command: 'python3', source: 'the system python3' };
}

/** Run the auth check, inheriting stdio so a password prompt still works. */
export function runCheck() {
  const { command, source } = resolvePython();
  const script = path.join(projectRoot, 'scripts/check-franklin-auth.py');
  const child = spawn(command, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('error', () => {
    console.error(`✗ Could not run ${source} (${command}).`);
    console.error('  Fix: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt');
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

runCheck();