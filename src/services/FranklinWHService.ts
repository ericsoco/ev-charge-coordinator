/**
 * FranklinWH Battery Service
 * 
 * Communicates with the FranklinWH API through the Python proxy server.
 */

import axios, { AxiosInstance } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  BatteryService,
  BatteryCredentials,
  BatteryFullStats,
  BatteryCurrentStats,
  BatteryTotals
} from '../types/battery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface FranklinStatsResponse {
  current: {
    solar_production: number;
    generator_production: number;
    generator_enabled: boolean;
    battery_use: number;
    grid_use: number;
    home_load: number;
    battery_soc: number;
    switch_1_load: number;
    switch_2_load: number;
    v2l_use: number;
    grid_status: string;
  };
  totals: {
    battery_charge: number;
    battery_discharge: number;
    grid_import: number;
    grid_export: number;
    solar: number;
    generator: number;
    home_use: number;
    switch_1_use: number;
    switch_2_use: number;
    v2l_export: number;
    v2l_import: number;
  };
}

export class FranklinWHService implements BatteryService {
  private client: AxiosInstance;
  private proxyProcess: ChildProcess | null = null;
  private authenticated = false;
  private proxyPort: number;

  constructor(proxyPort = 3001) {
    this.proxyPort = proxyPort;
    this.client = axios.create({
      baseURL: `http://127.0.0.1:${proxyPort}`,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  getName(): string {
    return 'FranklinWH aPower';
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Start the Python proxy server.
   */
  async startProxy(): Promise<void> {
    if (this.proxyProcess) {
      return; // Already running
    }

    const pythonScript = path.join(__dirname, '../../python/franklin_proxy.py');
    
    return new Promise((resolve, reject) => {
      this.proxyProcess = spawn('python3', [pythonScript], {
        env: {
          ...process.env,
          FRANKLIN_PROXY_PORT: String(this.proxyPort)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let started = false;

      this.proxyProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (output.includes('Starting FranklinWH API Proxy') || output.includes('Running on')) {
          if (!started) {
            started = true;
            // Give it a moment to fully start
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.proxyProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        // Flask outputs to stderr, check for running message
        if (output.includes('Running on') || output.includes('Press CTRL+C')) {
          if (!started) {
            started = true;
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.proxyProcess.on('error', (err) => {
        if (!started) {
          reject(new Error(`Failed to start proxy: ${err.message}`));
        }
      });

      this.proxyProcess.on('exit', (code) => {
        if (!started) {
          reject(new Error(`Proxy exited with code ${code}`));
        }
        this.proxyProcess = null;
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!started) {
          this.stopProxy();
          reject(new Error('Proxy startup timed out'));
        }
      }, 10000);
    });
  }

  /**
   * Stop the Python proxy server.
   */
  async stopProxy(): Promise<void> {
    if (!this.proxyProcess) {
      return;
    }

    try {
      await this.client.post('/shutdown');
    } catch {
      // If shutdown endpoint fails, kill the process
    }

    this.proxyProcess.kill('SIGTERM');
    this.proxyProcess = null;
    this.authenticated = false;
  }

  /**
   * Check if the proxy is running and healthy.
   */
  async isProxyHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return response.data.status === 'ok';
    } catch {
      return false;
    }
  }

  async initialize(credentials: BatteryCredentials): Promise<void> {
    // Ensure proxy is running
    if (!(await this.isProxyHealthy())) {
      await this.startProxy();
    }

    // Authenticate with the proxy
    const response = await this.client.post('/auth', {
      username: credentials.username,
      password: credentials.password,
      gateway_id: credentials.gatewayId
    });

    if (!response.data.success) {
      throw new Error(response.data.error || 'Authentication failed');
    }

    this.authenticated = true;
  }

  async getStateOfCharge(): Promise<number> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const response = await this.client.get('/soc');
    return response.data.battery_soc;
  }

  async getStats(): Promise<BatteryFullStats> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const response = await this.client.get<FranklinStatsResponse>('/stats');
    const data = response.data;

    const current: BatteryCurrentStats = {
      solarProduction: data.current.solar_production,
      generatorProduction: data.current.generator_production,
      generatorEnabled: data.current.generator_enabled,
      batteryUse: data.current.battery_use,
      gridUse: data.current.grid_use,
      homeLoad: data.current.home_load,
      batterySoc: data.current.battery_soc,
      switch1Load: data.current.switch_1_load,
      switch2Load: data.current.switch_2_load,
      v2lUse: data.current.v2l_use,
      gridStatus: data.current.grid_status
    };

    const totals: BatteryTotals = {
      batteryCharge: data.totals.battery_charge,
      batteryDischarge: data.totals.battery_discharge,
      gridImport: data.totals.grid_import,
      gridExport: data.totals.grid_export,
      solar: data.totals.solar,
      generator: data.totals.generator,
      homeUse: data.totals.home_use,
      switch1Use: data.totals.switch_1_use,
      switch2Use: data.totals.switch_2_use,
      v2lExport: data.totals.v2l_export,
      v2lImport: data.totals.v2l_import
    };

    return { current, totals };
  }

  async disconnect(): Promise<void> {
    await this.stopProxy();
  }
}
