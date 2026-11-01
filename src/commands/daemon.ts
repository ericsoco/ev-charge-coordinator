/**
 * `daemon`: run the collect daemon in the foreground, plus the launchd
 * lifecycle subcommands (stop/restart/install/uninstall/logs).
 *
 * The lifecycle implementations live in daemonLifecycle.ts; this file is the
 * Commander wiring plus the foreground runner's config/service plumbing.
 */
import { Command } from 'commander';
import { runDaemonOnce, startDaemon } from '../daemon/runDaemon.js';
import { credentialStore } from '../utils/credentials.js';
import {
  daemonConfigPath,
  ensureDaemonConfigFile,
  resolveDaemonConfig,
} from '../utils/daemonConfig.js';
import { installConsoleTimestamps } from '../utils/time.js';
import * as paint from '../utils/color.js';
import {
  restartDaemon,
  runDaemonScript,
  showLogs,
  stopDaemon,
  strayParentFlagProblem,
  type LifecycleResult,
} from './daemonLifecycle.js';
import { reportDebugDetails, type Session } from './session.js';

/** Lifecycle actions share one printer: message when there is one, code when failed. */
const reportLifecycle = (result: LifecycleResult): void => {
  if (result.message) {
    console.log(result.ok ? paint.positive(result.message) : paint.error(result.message));
  }
  if (!result.ok) process.exitCode = 1;
};

export function createDaemonCommand(deps: { session: Session }): Command {
  const daemonCommand = new Command('daemon')
    .passThroughOptions()
    .description('Run the collect daemon in the foreground (samplers, sessions, history)')
    .option('--once', 'Run every sampler once and exit (non-zero if any failed)')
    .option('--dry-run', 'Evaluate and record decisions without actuating (forces dry-run mode)')
    .option('--debug', 'Print full stack traces for startup failures')
    .action(async (cliOptions) => {
      // One timestamp format across daemon.log and daemon.err.log — every line
      // this process emits ([proxy], wake notices, sampler lines) is stamped
      // from here. Event times inside messages are data and stay as they are.
      installConsoleTimestamps();
      // Single source of truth: the file exists after the first daemon start.
      const ensured = ensureDaemonConfigFile();
      if (ensured === 'created') {
        console.log(
          paint.info(`daemon-config.json not found — created with defaults (${daemonConfigPath()})`)
        );
      } else if (ensured === 'migrated') {
        console.log(
          paint.info(`migrated legacy daemon.json → daemon-config.json (${daemonConfigPath()})`)
        );
      } else if (ensured === 'updated') {
        console.log(
          paint.info(
            `daemon-config.json updated: added missing keys with defaults ` +
              `(operator edits preserved) (${daemonConfigPath()})`
          )
        );
      }
      const resolved = resolveDaemonConfig();
      if (!resolved.config) {
        for (const problem of resolved.problems) console.log(paint.error(problem));
        console.log(paint.error(`Fix ${daemonConfigPath()} and try again.`));
        process.exitCode = 1;
        return;
      }

      const franklin = await deps.session.initializeFranklin();
      const tesla = await deps.session.initializeTesla();
      if (!franklin.ok && !tesla.ok) {
        console.log(paint.error('No services available. Exiting.'));
        process.exitCode = 1;
        return;
      }

      const franklinCreds = await credentialStore.getFranklinCredentials();
      const teslaCreds = await credentialStore.getTeslaCredentials();
      const teslaService = deps.session.getTesla();
      let vehicleId = teslaCreds?.vin;
      if (!vehicleId && tesla.ok && teslaService) {
        vehicleId = (await teslaService.listVehicles())[0]?.vin;
        if (vehicleId) await credentialStore.setTeslaVin(vehicleId);
      }

      const daemonOptions = {
        services: {
          franklin: franklin.ok ? deps.session.getFranklin() : null,
          tesla: tesla.ok ? teslaService : null,
        },
        homeBatteryId: franklinCreds?.gatewayId,
        vehicleId,
        config: resolved.config,
        dryRun: cliOptions.dryRun === true,
      };

      try {
        if (cliOptions.once) {
          console.log(paint.info('Running one collection cycle…'));
          const outcome = await runDaemonOnce(daemonOptions);
          for (const [task, result] of Object.entries(outcome.taskResults)) {
            if (result === null) {
              console.log(paint.positive(`✓ ${task}`));
            } else {
              const message = result instanceof Error ? result.message : String(result);
              console.log(paint.error(`✗ ${task}: ${message}`));
            }
          }
          console.log(
            outcome.ok ? paint.positive('✓ Cycle complete') : paint.error('Cycle finished with errors')
          );
          if (!outcome.ok) process.exitCode = 1;
          return;
        }

        const handle = await startDaemon(daemonOptions);
        console.log(paint.info('Daemon running in the foreground. Stop with Ctrl-C.'));
        await new Promise<void>((resolve) => {
          const stop = () => {
            void handle.stop().then(() => resolve());
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        console.log(paint.positive('\n✓ Daemon stopped'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(paint.error(`Daemon failed: ${message}`));
        reportDebugDetails(cliOptions.debug, error);
        process.exitCode = 1;
      }
    });

  daemonCommand
    .command('stop')
    .description('Stop the launchd daemon (bootout; the agent stays installed)')
    .action(async () => reportLifecycle(stopDaemon()));

  daemonCommand
    .command('restart')
    .description('Restart the launchd daemon (stop + bootstrap the installed plist; no file changes)')
    .action(async () => reportLifecycle(restartDaemon()));

  daemonCommand
    .command('install')
    .description('Install (or upgrade) the LaunchAgent and Login Item launcher')
    .option('--dry-run', 'Print the actions; change nothing')
    .action(async (options) => reportLifecycle(runDaemonScript('install', options.dryRun === true)));

  daemonCommand
    .command('uninstall')
    .description('Remove the LaunchAgent and Login Item launcher (keeps store, logs, credentials)')
    .option('--dry-run', 'Print the actions; change nothing')
    .action(async (options) => reportLifecycle(runDaemonScript('uninstall', options.dryRun === true)));

  daemonCommand
    .command('logs')
    .description('Show recent daemon log lines (--follow to stream, --err for the error log)')
    .option('--lines <n>', 'Recent lines to show (default 50)')
    .option('-f, --follow', 'Keep streaming after printing (tail -F; Ctrl-C stops)')
    .option('--err', 'Also show daemon.err.log ([proxy] lines, task failures)')
    .action(async (options) => {
      // Validate here, not in an argParser: commander does not catch parser
      // throws, so a bad value would surface as a raw stack trace.
      const lines = options.lines === undefined ? 50 : Number(options.lines);
      if (!Number.isInteger(lines) || lines < 0) {
        console.log(paint.error('--lines must be a non-negative integer'));
        process.exitCode = 1;
        return;
      }
      reportLifecycle(
        showLogs({ lines, follow: options.follow === true, err: options.err === true })
      );
    });

  // A parent-level flag before a lifecycle subcommand (`daemon --dry-run
  // uninstall`) parses onto the parent, whose action never runs when a
  // subcommand is present — refuse instead of silently doing the real thing.
  daemonCommand.hook('preAction', (_thisCommand, actionCommand) => {
    if (actionCommand === daemonCommand) return;
    const stray = strayParentFlagProblem(daemonCommand.opts());
    if (stray !== null) {
      console.log(paint.error(stray));
      process.exit(1);
    }
  });

  return daemonCommand;
}