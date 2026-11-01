/**
 * `config`: show or update configuration (credentials, Tesla region/domain,
 * energy values, virtual key public key).
 *
 * `runConfig` is shared by the Commander action and the REPL dispatch (modeled
 * on runAuthenticate): it returns success, and only the Commander wrapper turns
 * failure into a process exit code.
 */
import { Command } from 'commander';
import { resolveRegion } from '../services/tesla/endpoints.js';
import { normalizeDomain, VirtualKeyService } from '../services/tesla/VirtualKeyService.js';
import {
  describeConfigProblems,
  ENERGY_CONFIG_TEMPLATE,
  energyConfigPath,
  resolveEnergyConfig,
  setEnergyConfigField,
} from '../utils/config.js';
import { credentialStore } from '../utils/credentials.js';
import type { EnergyConfig } from '../utils/energy.js';
import * as paint from '../utils/color.js';
import { describeError } from './context.js';

/** Options of the `config` command; the REPL builds the same shape from flags. */
export interface ConfigOptions {
  showPublicKey?: boolean;
  clearFranklin?: boolean;
  clearTesla?: boolean;
  clearCredentials?: boolean;
  teslaRegion?: string;
  teslaDomain?: string;
  setBatteryKwh?: string;
  setEvKwh?: string;
  setEfficiency?: string;
  setBuffer?: string;
  [key: string]: unknown;
}

export async function runConfig(options: ConfigOptions): Promise<boolean> {
  if (options.showPublicKey) {
    const service = new VirtualKeyService({ apiBaseUrl: resolveRegion().apiBaseUrl });
    console.log(await service.getPublicKeyPem());
    return true;
  }
  // Energy setters write to config.json, the single source of truth.
  const energySetters: [option: string, field: keyof EnergyConfig, label: string][] = [
    ['setBatteryKwh', 'batteryCapacityKwh', 'Battery capacity'],
    ['setEvKwh', 'evBatteryKwh', 'EV capacity'],
    ['setBuffer', 'bufferPercent', 'Battery buffer'],
    ['setEfficiency', 'chargeEfficiency', 'Charge efficiency'],
  ];
  const setter = energySetters.find(([option]) => options[option] !== undefined);
  if (setter) {
    const [, field, label] = setter;
    const raw = options[setter[0]] as string;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      console.error(paint.error(`${label} must be a number (got "${raw}")`));
      return false;
    }
    try {
      const patch: Partial<EnergyConfig> = {};
      patch[field] = value;
      setEnergyConfigField(patch);
      console.log(paint.positive(`✓ ${label} set to ${value}`));
      console.log(paint.info(`  Saved to ${energyConfigPath()}`));
      return true;
    } catch (error) {
      console.error(paint.error(describeError(error)));
      return false;
    }
  }
  if (options.teslaDomain) {
    // Validated the same way pair-tesla-key validates it, so a bad domain is
    // rejected here rather than after the key has been published to it.
    try {
      const domain = normalizeDomain(options.teslaDomain);
      await credentialStore.setTeslaCredentials({ domain });
      console.log(paint.positive(`✓ Tesla key domain set to ${domain}`));
      console.log(paint.info('  Run pair-tesla-key to register it with Tesla.'));
      return true;
    } catch (error) {
      console.error(paint.error(describeError(error)));
      return false;
    }
  }
  if (options.teslaRegion) {
    // Validated through resolveRegion so a typo fails here instead of surfacing
    // later as an HTTP 421 "incorrect region" from Tesla.
    try {
      const { region, coverage } = resolveRegion(options.teslaRegion);
      await credentialStore.setTeslaCredentials({ region });
      console.log(paint.positive(`✓ Tesla region set to ${region} (${coverage})`));
      console.log(paint.info('  Re-run the pairing step if this moves you to a different deployment.'));
      return true;
    } catch (error) {
      console.error(paint.error(describeError(error)));
      return false;
    }
  }
  if (options.clearFranklin) {
    await credentialStore.clearFranklinCredentials();
    console.log(paint.positive('✓ FranklinWH credentials cleared'));
    return true;
  }
  if (options.clearTesla) {
    await credentialStore.clearTeslaCredentials();
    console.log(paint.positive('✓ Tesla credentials cleared'));
    return true;
  }
  if (options.clearCredentials) {
    await credentialStore.clearAll();
    console.log(paint.positive('✓ All credentials cleared'));
    return true;
  }

  // Show current config
  const franklin = await credentialStore.getFranklinCredentials();
  const tesla = await credentialStore.getTeslaCredentials();
  const energy = resolveEnergyConfig();

  console.log(paint.info('\n--- Configuration ---'));
  console.log(`FranklinWH: ${franklin ? `Configured (Gateway: ${franklin.gatewayId})` : 'Not configured'}`);
  console.log(`Tesla: ${tesla ? `Configured${tesla.vin ? ` (VIN: ${tesla.vin})` : ''}${tesla.region ? ` Region: ${tesla.region}` : ''}${tesla.domain ? ` Key domain: ${tesla.domain}` : ''}` : 'Not configured'}`);
  console.log(`Energy config: ${energyConfigPath()}`);
  if (energy.config) {
    console.log(`  Battery capacity: ${energy.config.batteryCapacityKwh} kWh`);
    console.log(`  EV capacity: ${energy.config.evBatteryKwh} kWh`);
    console.log(`  Battery Buffer: ${energy.config.bufferPercent}%`);
    console.log(`  Charge efficiency: ${energy.config.chargeEfficiency}`);
  } else if (energy.invalid.length > 0) {
    // Hand-edit mistakes: echo every problem with the path.
    for (const line of describeConfigProblems(energy)) console.log(paint.error(line));
  } else {
    console.log(paint.warning(`  Incomplete (missing: ${energy.missing.join(', ')})`));
    console.log(paint.info('  Create it with:'));
    console.log(ENERGY_CONFIG_TEMPLATE);
  }
  console.log('');
  return true;
}

export function createConfigCommand(): Command {
  return new Command('config')
    .allowExcessArguments(false)
    .description('Show or update configuration')
    .option('--clear-franklin', 'Clear FranklinWH credentials')
    .option('--clear-tesla', 'Clear Tesla credentials')
    .option('--clear-credentials', 'Clear all stored credentials')
    .option('--tesla-region <region>', 'Set the Tesla Fleet API deployment (na | eu | cn)')
    .option('--tesla-domain <domain>', 'Set the domain that hosts the virtual key public key')
    .option('--show-public-key', 'Print the virtual key public key that Tesla reads')
    .option('--set-battery-kwh <n>', 'Set house battery capacity, kWh')
    .option('--set-ev-kwh <n>', 'Set EV battery capacity, kWh')
    .option('--set-efficiency <0-1>', 'Set charge efficiency (0-1)')
    .option('--set-buffer <percent>', 'Set the battery buffer reserve, percent (0-100)')
    .action(async (options) => {
      // exitCode stays here so a REPL session cannot inherit it.
      if (!(await runConfig(options))) process.exitCode = 1;
    });
}
