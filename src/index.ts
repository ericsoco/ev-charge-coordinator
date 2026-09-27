#!/usr/bin/env node
/**
 * EV Charge Coordinator CLI
 * 
 * Coordinate EV charging with home solar battery storage.
 * Supports Tesla vehicles and FranklinWH battery systems.
 */

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { FranklinWHService, TeslaService } from './services/index.js';
import { credentialStore } from './utils/credentials.js';

const program = new Command();
let franklinService: FranklinWHService | null = null;
let teslaService: TeslaService | null = null;
let isRunning = false;

function createReadline() {
  return createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createReadline();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * The intent of having promptPassword separate from prompt is be able to
 * hide the password input in the terminal. GenAI provided a borked implementation,
 * so this is a placeholder for now.
 * 
 * TODO: try a lib like 'readline-sync' or 'inquirer' to handle hidden input properly.
 */
async function promptPassword(question: string): Promise<string> {
  const rl = createReadline();

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function initializeFranklin(): Promise<boolean> {
  if (franklinService?.isAuthenticated()) {
    return true;
  }

  const stored = await credentialStore.getFranklinCredentials();
  
  if (stored) {
    console.log('Using stored FranklinWH credentials...');
    franklinService = new FranklinWHService();
    try {
      await franklinService.initialize({
        username: stored.username,
        password: stored.password,
        gatewayId: stored.gatewayId
      });
      console.log('✓ Connected to FranklinWH');
      return true;
    } catch (error) {
      console.error('Failed to connect with stored credentials:', error);
      franklinService = null;
    }
  }

  console.log('\nFranklinWH authentication required.');
  const username = await prompt('Email: ');
  const password = await promptPassword('Password: ');
  const gatewayId = await prompt('Gateway ID (found in app under More -> Site Address): ');

  franklinService = new FranklinWHService();
  try {
    await franklinService.initialize({ username, password, gatewayId });
    
    const save = await prompt('Save credentials for future use? (y/n): ');
    if (save.toLowerCase() === 'y') {
      await credentialStore.setFranklinCredentials(username, password, gatewayId);
      console.log('✓ Credentials saved securely');
    }
    
    console.log('✓ Connected to FranklinWH');
    return true;
  } catch (error) {
    console.error('Authentication failed:', error);
    franklinService = null;
    return false;
  }
}

async function initializeTesla(): Promise<boolean> {
  if (teslaService?.isAuthenticated()) {
    return true;
  }

  const stored = await credentialStore.getTeslaCredentials();
  
  if (stored?.accessToken && stored?.refreshToken) {
    console.log('Using stored Tesla credentials...');
    teslaService = new TeslaService();
    try {
      await teslaService.initialize({
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        vin: stored.vin
      });
      
      if (stored.vin) {
        teslaService.setVin(stored.vin);
      }
      
      console.log('✓ Connected to Tesla');
      return true;
    } catch (error) {
      console.error('Failed to connect with stored credentials:', error);
      teslaService = null;
    }
  }

  console.log('\nTesla Fleet API authentication required.');
  console.log('You need a Tesla Developer account with a registered application.');
  console.log('Visit https://developer.tesla.com to create one.\n');
  
  const clientId = await prompt('Client ID: ');
  const clientSecret = await promptPassword('Client Secret: ');
  
  teslaService = new TeslaService();
  await teslaService.initialize({ clientId, clientSecret });
  
  console.log('\nStarting OAuth authentication...');
  console.log('A browser window should open. If not, copy and paste the URL below.\n');
  
  try {
    await teslaService.authenticate((authUrl) => {
      console.log('Please visit this URL to authorize:\n');
      console.log(authUrl);
      console.log('\nWaiting for authorization...');
    });
    
    // List vehicles and let user select
    const vehicles = await teslaService.listVehicles();
    if (vehicles.length === 0) {
      console.log('No vehicles found in your Tesla account.');
      return false;
    }
    
    console.log('\nAvailable vehicles:');
    vehicles.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.displayName} (${v.vin})`);
    });
    
    let selectedVin: string;
    if (vehicles.length === 1) {
      selectedVin = vehicles[0].vin;
      console.log(`\nUsing vehicle: ${vehicles[0].displayName}`);
    } else {
      const selection = await prompt('Select vehicle number: ');
      const index = parseInt(selection) - 1;
      if (index < 0 || index >= vehicles.length) {
        console.log('Invalid selection');
        return false;
      }
      selectedVin = vehicles[index].vin;
    }
    
    teslaService.setVin(selectedVin);
    
    const save = await prompt('Save credentials for future use? (y/n): ');
    if (save.toLowerCase() === 'y') {
      await credentialStore.setTeslaCredentials(
        clientId,
        clientSecret,
        undefined,
        undefined,
        undefined,
        selectedVin
      );
      console.log('✓ Credentials saved securely');
    }
    
    console.log('✓ Connected to Tesla');
    return true;
  } catch (error) {
    console.error('Authentication failed:', error);
    teslaService = null;
    return false;
  }
}

// CLI Commands
program
  .name('ev-charge-coordinator')
  .description('Coordinate EV charging with home solar battery storage')
  .version('1.0.0');

program
  .command('start')
  .description('Start the Python API proxy and NodeJS server')
  .action(async () => {
    console.log('Starting EV Charge Coordinator...\n');
    
    // Initialize FranklinWH
    if (!(await initializeFranklin())) {
      console.log('Warning: FranklinWH service not available');
    }
    
    // Initialize Tesla
    if (!(await initializeTesla())) {
      console.log('Warning: Tesla service not available');
    }
    
    if (!franklinService?.isAuthenticated() && !teslaService?.isAuthenticated()) {
      console.log('\nNo services available. Exiting.');
      return;
    }
    
    isRunning = true;
    console.log('\n✓ Services started successfully');
    console.log('Type "help" for available commands or "exit" to quit.\n');
    
    // Interactive command loop
    const rl = createReadline();
    
    const handleCommand = async (input: string) => {
      const cmd = input.trim().toLowerCase();
      
      switch (cmd) {
        case 'help':
          console.log(`
Available commands:
  get-ev-bsoc         Get the current battery state of charge from the EV
  get-battery-soc     Get the current battery state of charge from the solar battery
  set-ev-charge-limit Set the EV's charge limit
  start-ev-charging   Start charging the EV
  stop-ev-charging    Stop charging the EV
  charge-from-battery Set the EV charge limit based on solar battery SoC
  set-battery-buffer  Set the amount of charge to keep in the solar battery
  status              Show current status of all systems
  exit                Exit the application
`);
          break;
          
        case 'status':
          console.log('\n--- System Status ---');
          console.log(`FranklinWH: ${franklinService?.isAuthenticated() ? '✓ Connected' : '✗ Not connected'}`);
          console.log(`Tesla: ${teslaService?.isAuthenticated() ? '✓ Connected' : '✗ Not connected'}`);
          const buffer = await credentialStore.getBatteryBuffer();
          console.log(`Battery Buffer: ${buffer}%`);
          console.log('');
          break;
          
        case 'get-ev-bsoc':
          if (!teslaService?.isAuthenticated()) {
            console.log('Tesla not connected');
            break;
          }
          try {
            console.log('Getting EV battery state of charge...');
            const soc = await teslaService.getStateOfCharge();
            console.log(`EV Battery SoC: ${soc}%`);
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'get-battery-soc':
          if (!franklinService?.isAuthenticated()) {
            console.log('FranklinWH not connected');
            break;
          }
          try {
            console.log('Getting solar battery state of charge...');
            const soc = await franklinService.getStateOfCharge();
            console.log(`Solar Battery SoC: ${soc}%`);
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'set-ev-charge-limit':
          if (!teslaService?.isAuthenticated()) {
            console.log('Tesla not connected');
            break;
          }
          try {
            const limitStr = await prompt('Enter charge limit (50-100%): ');
            const limit = parseInt(limitStr);
            if (isNaN(limit) || limit < 50 || limit > 100) {
              console.log('Invalid charge limit. Must be between 50 and 100.');
              break;
            }
            console.log('Setting EV charge limit...');
            await teslaService.setChargeLimit(limit);
            console.log(`✓ EV charge limit set to ${limit}%`);
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'start-ev-charging':
          if (!teslaService?.isAuthenticated()) {
            console.log('Tesla not connected');
            break;
          }
          try {
            console.log('Starting EV charging...');
            await teslaService.startCharging();
            console.log('✓ EV charging started');
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'stop-ev-charging':
          if (!teslaService?.isAuthenticated()) {
            console.log('Tesla not connected');
            break;
          }
          try {
            console.log('Stopping EV charging...');
            await teslaService.stopCharging();
            console.log('✓ EV charging stopped');
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'charge-from-battery':
          if (!franklinService?.isAuthenticated() || !teslaService?.isAuthenticated()) {
            console.log('Both FranklinWH and Tesla must be connected');
            break;
          }
          try {
            console.log('Getting solar battery state...');
            const batterySoc = await franklinService.getStateOfCharge();
            const buffer = await credentialStore.getBatteryBuffer();
            
            // Calculate available charge
            const availableCharge = Math.max(0, batterySoc - buffer);
            
            // EV charge limit must be at least 50%
            const evLimit = Math.max(50, Math.min(100, availableCharge));
            
            console.log(`Solar Battery: ${batterySoc}%`);
            console.log(`Buffer: ${buffer}%`);
            console.log(`Available for EV: ${availableCharge}%`);
            console.log(`Setting EV limit to: ${evLimit}%`);
            
            if (evLimit <= 50) {
              console.log('Not enough charge available (minimum EV limit is 50%)');
              break;
            }
            
            await teslaService.setChargeLimit(evLimit);
            console.log(`✓ EV charge limit set to ${evLimit}%`);
            
            const startCharging = await prompt('Start charging now? (y/n): ');
            if (startCharging.toLowerCase() === 'y') {
              await teslaService.startCharging();
              console.log('✓ EV charging started');
            }
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'set-battery-buffer':
          try {
            const bufferStr = await prompt('Enter battery buffer percentage (0-100): ');
            const buffer = parseInt(bufferStr);
            if (isNaN(buffer) || buffer < 0 || buffer > 100) {
              console.log('Invalid buffer. Must be between 0 and 100.');
              break;
            }
            await credentialStore.setBatteryBuffer(buffer);
            console.log(`✓ Battery buffer set to ${buffer}%`);
          } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
          }
          break;
          
        case 'exit':
        case 'quit':
          rl.close();
          return;
          
        case '':
          break;
          
        default:
          console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
      }
      
      rl.prompt();
    };
    
    rl.setPrompt('ev-charge> ');
    rl.prompt();
    
    rl.on('line', handleCommand);
    
    rl.on('close', async () => {
      console.log('\nShutting down...');
      isRunning = false;
      
      if (franklinService) {
        await franklinService.disconnect();
      }
      if (teslaService) {
        await teslaService.disconnect();
      }
      
      console.log('Goodbye!');
      process.exit(0);
    });
  });

program
  .command('exit')
  .description('Terminate the Python API proxy and NodeJS server')
  .action(async () => {
    console.log('Shutting down services...');
    
    if (franklinService) {
      await franklinService.disconnect();
    }
    if (teslaService) {
      await teslaService.disconnect();
    }
    
    console.log('✓ Services stopped');
  });

program
  .command('get-ev-bsoc')
  .description('Get the current battery state of charge from the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    
    try {
      const soc = await teslaService!.getStateOfCharge();
      console.log(`EV Battery SoC: ${soc}%`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('get-battery-soc')
  .description('Get the current battery state of charge from the solar battery')
  .action(async () => {
    if (!(await initializeFranklin())) {
      process.exit(1);
    }
    
    try {
      const soc = await franklinService!.getStateOfCharge();
      console.log(`Solar Battery SoC: ${soc}%`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await franklinService!.disconnect();
    }
  });

program
  .command('set-ev-charge-limit')
  .description('Set the EV charge limit')
  .argument('<percent>', 'Charge limit percentage (50-100)')
  .action(async (percent: string) => {
    const limit = parseInt(percent);
    if (isNaN(limit) || limit < 50 || limit > 100) {
      console.error('Charge limit must be between 50 and 100');
      process.exit(1);
    }
    
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    
    try {
      await teslaService!.setChargeLimit(limit);
      console.log(`✓ EV charge limit set to ${limit}%`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('start-ev-charging')
  .description('Start charging the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    
    try {
      await teslaService!.startCharging();
      console.log('✓ EV charging started');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('stop-ev-charging')
  .description('Stop charging the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    
    try {
      await teslaService!.stopCharging();
      console.log('✓ EV charging stopped');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('charge-from-battery')
  .description('Set EV charge limit based on solar battery SoC minus buffer')
  .action(async () => {
    if (!(await initializeFranklin()) || !(await initializeTesla())) {
      console.error('Both FranklinWH and Tesla must be connected');
      process.exit(1);
    }
    
    try {
      const batterySoc = await franklinService!.getStateOfCharge();
      const buffer = await credentialStore.getBatteryBuffer();
      
      const availableCharge = Math.max(0, batterySoc - buffer);
      const evLimit = Math.max(50, Math.min(100, availableCharge));
      
      console.log(`Solar Battery: ${batterySoc}%`);
      console.log(`Buffer: ${buffer}%`);
      console.log(`Available for EV: ${availableCharge}%`);
      
      if (evLimit <= 50) {
        console.log('Not enough charge available (minimum EV limit is 50%)');
        process.exit(0);
      }
      
      await teslaService!.setChargeLimit(evLimit);
      console.log(`✓ EV charge limit set to ${evLimit}%`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await franklinService!.disconnect();
    }
  });

program
  .command('set-battery-buffer')
  .description('Set the amount of charge to keep in the solar battery')
  .argument('<percent>', 'Buffer percentage (0-100)')
  .action(async (percent: string) => {
    const buffer = parseInt(percent);
    if (isNaN(buffer) || buffer < 0 || buffer > 100) {
      console.error('Buffer must be between 0 and 100');
      process.exit(1);
    }
    
    await credentialStore.setBatteryBuffer(buffer);
    console.log(`✓ Battery buffer set to ${buffer}%`);
  });

program
  .command('config')
  .description('Show or update configuration')
  .option('--clear-franklin', 'Clear FranklinWH credentials')
  .option('--clear-tesla', 'Clear Tesla credentials')
  .option('--clear-all', 'Clear all stored credentials')
  .action(async (options) => {
    if (options.clearFranklin) {
      await credentialStore.clearFranklinCredentials();
      console.log('✓ FranklinWH credentials cleared');
    } else if (options.clearTesla) {
      await credentialStore.clearTeslaCredentials();
      console.log('✓ Tesla credentials cleared');
    } else if (options.clearAll) {
      await credentialStore.clearAll();
      console.log('✓ All credentials cleared');
    } else {
      // Show current config
      const franklin = await credentialStore.getFranklinCredentials();
      const tesla = await credentialStore.getTeslaCredentials();
      const buffer = await credentialStore.getBatteryBuffer();
      
      console.log('\n--- Configuration ---');
      console.log(`FranklinWH: ${franklin ? `Configured (Gateway: ${franklin.gatewayId})` : 'Not configured'}`);
      console.log(`Tesla: ${tesla ? `Configured${tesla.vin ? ` (VIN: ${tesla.vin})` : ''}` : 'Not configured'}`);
      console.log(`Battery Buffer: ${buffer}%`);
      console.log('');
    }
  });

program.parse();
