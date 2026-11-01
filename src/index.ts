#!/usr/bin/env node
/**
 * EV Charge Coordinator CLI
 *
 * Coordinate EV charging with home solar battery storage.
 * Supports Tesla vehicles and FranklinWH battery systems.
 *
 * This file is wiring only: it assembles the Commander program from the
 * per-command modules in src/commands/ and starts parsing. Each command's
 * behavior lives once in the module that creates it (a createXCommand factory,
 * modeled on createNotifyCommand), because the logic used to exist twice --
 * here and in the REPL switch -- and the two copies had already drifted.
 */

import { Command } from 'commander';
import { resolveDaemonConfig } from './utils/daemonConfig.js';
import { credentialStore } from './utils/credentials.js';
import { promptSecret } from './commands/prompt.js';
import { createSession } from './commands/session.js';
import { createStartCommand } from './commands/start.js';
import { createExitCommand } from './commands/exit.js';
import { createDaemonCommand } from './commands/daemon.js';
import {
  createSessionsCommand,
  createSetHomeLocationCommand,
  createStatusCommand,
} from './commands/system.js';
import {
  createChargeFromBatteryCommand,
  createGetBatterySocCommand,
  createGetChargingStateCommand,
  createGetEvBsocCommand,
  createSetEvChargeLimitCommand,
  createStartEvChargingCommand,
  createStopEvChargingCommand,
} from './commands/vehicle.js';
import { createAuthenticateCommand } from './commands/authenticate.js';
import { createConfigCommand } from './commands/config.js';
import { createPairTeslaKeyCommand } from './commands/pairTeslaKey.js';
import { createNotifyCommand } from './commands/notify.js';

const program = new Command();
// Options bind to the command they follow (Commander positional mode) —
// required for the daemon subcommands' passThroughOptions, so a subcommand
// flag like `daemon uninstall --dry-run` is not swallowed by the parent's
// same-named option.
program.enablePositionalOptions();
program
  .name('ev-charge-coordinator')
  .description('Coordinate EV charging with home solar battery storage')
  .version('1.0.0');

const session = createSession();

/**
 * Print a subcommand's help from its Commander definition, so the REPL shows
 * exactly what `node dist/index.js <command> --help` prints and the option
 * descriptions live in one place. helpInformation() renders without exiting,
 * unlike Commander's own --help option. Returns false for unknown names.
 */
function printCommandHelp(name: string): boolean {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) return false;
  console.log(command.helpInformation());
  return true;
}

// Registration order is the order `--help` lists them in.
program.addCommand(createStartCommand({ session, printCommandHelp }));
program.addCommand(createExitCommand({ session }));
program.addCommand(createDaemonCommand({ session }));
program.addCommand(createStatusCommand({ session }));
program.addCommand(createSessionsCommand({ session }));
program.addCommand(createSetHomeLocationCommand({ session }));
program.addCommand(createGetEvBsocCommand({ session }));
program.addCommand(createGetBatterySocCommand({ session }));
program.addCommand(createGetChargingStateCommand({ session }));
program.addCommand(createSetEvChargeLimitCommand({ session }));
program.addCommand(createStartEvChargingCommand({ session }));
program.addCommand(createStopEvChargingCommand({ session }));
program.addCommand(createChargeFromBatteryCommand({ session }));
program.addCommand(createAuthenticateCommand());
program.addCommand(
  createNotifyCommand({
    getNotifierEntries: () => resolveDaemonConfig().config?.notifiers ?? null,
    getSecrets: () => credentialStore.getNotifierSecrets(),
    setNtfyTopic: (topic) => credentialStore.setNtfyTopic(topic),
    setSlackWebhookUrl: (url) => credentialStore.setSlackWebhookUrl(url),
    clearNotifierSecrets: () => credentialStore.clearNotifierSecrets(),
    promptSecret,
    log: (message) => console.log(message),
    nowMs: () => Date.now(),
  })
);
program.addCommand(createConfigCommand());
program.addCommand(createPairTeslaKeyCommand());

program.parse();
