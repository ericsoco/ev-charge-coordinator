/**
 * `exit`: stop the Tesla command sidecar and the FranklinWH Python proxy.
 *
 * A fresh process has no in-service services, which is exactly the case this
 * command used to silently no-op on while reporting success. The proxy to stop
 * is located via runtime state (`~/.ev-charge-coordinator/runtime.json`), so
 * `exit` works from a different process than the one that ran `start`.
 */
import { Command } from 'commander';
import axios from 'axios';
import {
  clearRuntimeState,
  isProcessAlive,
  readRuntimeState,
  terminateProcess,
} from '../services/ProcessManager.js';
import { stopTeslaProxy } from '../services/TeslaCommandProxy.js';
import * as paint from '../utils/color.js';
import { DEFAULT_PROXY_PORT, type Session } from './session.js';

/**
 * Report a proxy listening on the port with no state file.
 *
 * Deliberately reports rather than kills: without a recorded PID there is no way
 * to know the process is ours, and killing whatever holds the port could take out
 * something unrelated.
 */
function reportOrphanedProxy(): void {
  console.log(
    paint.positive(
      `If a proxy is still listening on port ${DEFAULT_PROXY_PORT}, stop it with:\n` +
        `  lsof -ti tcp:${DEFAULT_PROXY_PORT} | xargs kill`
    )
  );
}

export function createExitCommand(deps: { session: Session }): Command {
  return new Command('exit')
    .description('Terminate the Python API proxy and NodeJS server')
    .action(async () => {
      console.log(paint.info('Shutting down services...\n'));

      // Stop in-process services first, when this process has any. A fresh process
      // has none, which is exactly the case this command used to silently no-op on
      // while reporting success.
      const tesla = deps.session.getTesla();
      if (tesla) {
        await tesla.disconnect();
      }

      if (await stopTeslaProxy()) {
        console.log(paint.positive('✓ Tesla command proxy stopped'));
      }

      const state = readRuntimeState();
      if (!state) {
        console.log(paint.info('No runtime state file; no proxy was started by `start`.'));
        reportOrphanedProxy();
        console.log(paint.positive('\n✓ Nothing to stop'));
        return;
      }

      if (!isProcessAlive(state.pid)) {
        console.log(paint.info(`Recorded proxy (pid ${state.pid}) is no longer running; clearing stale state.`));
        clearRuntimeState();
        console.log(paint.positive('\n✓ Nothing to stop'));
        return;
      }

      console.log(paint.info(`Stopping proxy on port ${state.port} (pid ${state.pid})...`));

      // Ask the proxy to shut down first so it can close cleanly: it replies,
      // then SIGTERMs itself into a normal interpreter exit (no os._exit). The
      // response can still lose that race, so terminateProcess below remains
      // the real guarantee that the process ends.
      try {
        await axios.post(`http://127.0.0.1:${state.port}/shutdown`, undefined, {
          timeout: 5000,
          // A state file from before Phase 3 carries no token; the proxy then
          // 401s and the SIGTERM path performs the same clean shutdown anyway.
          ...(state.token ? { headers: { 'X-Proxy-Token': state.token } } : {}),
        });
      } catch {
        // A lost response is a race, not a failure; the escalation below is the
        // guarantee that the process ends.
      }

      const outcome = await terminateProcess(state.pid);
      clearRuntimeState();

      const verb =
        outcome === 'exited' ? 'stopped cleanly' :
        outcome === 'killed' ? 'stopped (SIGKILL required)' :
        'already gone';
      console.log(paint.positive(`✓ Proxy ${verb}`));
      console.log(paint.positive('\n✓ Services stopped'));
    });
}
