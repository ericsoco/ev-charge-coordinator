/**
 * Tesla Fleet API Service
 * 
 * Communicates with Tesla vehicles using the official Fleet API.
 * Handles OAuth2 authentication, token management, and vehicle commands.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as http from 'http';
import * as url from 'url';
import type { EVService, EVCredentials, EVStatus, EVBatteryStats, TeslaTokens } from '../types/ev.js';
import { credentialStore } from '../utils/credentials.js';

const TESLA_AUTH_URL = 'https://auth.tesla.com';
const TESLA_API_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com'; // North America
const REDIRECT_URI = 'http://localhost:8089/callback';

const REQUIRED_SCOPES = [
  'openid',
  'offline_access',
  'vehicle_device_data',
  'vehicle_cmds',
  'vehicle_charging_cmds'
].join(' ');

interface TeslaVehicle {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: string;
}

interface TeslaChargeState {
  battery_level: number;
  charge_limit_soc: number;
  charging_state: string;
  charge_rate?: number;
  minutes_to_full_charge?: number;
  battery_range?: number;
}

interface TeslaVehicleData {
  id: number;
  vin: string;
  display_name: string;
  state: string;
  charge_state: TeslaChargeState;
}

export class TeslaService implements EVService {
  private client: AxiosInstance;
  private authenticated = false;
  private tokens: TeslaTokens | null = null;
  private clientId: string = '';
  private clientSecret: string = '';
  private vin: string = '';

  constructor() {
    this.client = axios.create({
      baseURL: TESLA_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor to include auth token
    this.client.interceptors.request.use(async (config) => {
      if (this.tokens?.accessToken) {
        // Check if token is expired
        if (this.tokens.expiresAt && Date.now() >= this.tokens.expiresAt - 60000) {
          await this.refreshTokens();
        }
        config.headers.Authorization = `Bearer ${this.tokens.accessToken}`;
      }
      return config;
    });

    // Add response interceptor for token refresh on 401
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        if (error.response?.status === 401 && this.tokens?.refreshToken) {
          try {
            await this.refreshTokens();
            // Retry the request
            const config = error.config;
            if (config) {
              config.headers.Authorization = `Bearer ${this.tokens.accessToken}`;
              return this.client.request(config);
            }
          } catch {
            // Refresh failed, will need to re-authenticate
            this.authenticated = false;
          }
        }
        throw error;
      }
    );
  }

  getName(): string {
    return 'Tesla Fleet API';
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Generate OAuth2 authorization URL.
   */
  private generateAuthUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      scope: REQUIRED_SCOPES,
      state
    });

    return `${TESLA_AUTH_URL}/oauth2/v3/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens.
   */
  private async exchangeCode(code: string): Promise<TeslaTokens> {
    const response = await axios.post(`${TESLA_AUTH_URL}/oauth2/v3/token`, {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: REDIRECT_URI
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const data = response.data;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };
  }

  /**
   * Refresh the access token using refresh token.
   */
  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await axios.post(`${TESLA_AUTH_URL}/oauth2/v3/token`, {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const data = response.data;
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.tokens.refreshToken,
      expiresIn: data.expires_in,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    // Save updated tokens
    await credentialStore.updateTeslaTokens(
      this.tokens.accessToken,
      this.tokens.refreshToken,
      this.tokens.expiresAt
    );
  }

  /**
   * Start local OAuth callback server and wait for authorization.
   */
  private async waitForOAuthCallback(
    state: string,
    onAuthUrl: (url: string) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url || '', true);
        
        if (parsedUrl.pathname === '/callback') {
          const code = parsedUrl.query.code as string;
          const returnedState = parsedUrl.query.state as string;
          const error = parsedUrl.query.error as string;

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Invalid State</h1></body></html>');
            server.close();
            reject(new Error('OAuth state mismatch'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; text-align: center; padding: 50px;">
                <h1>✓ Authorization Successful</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          
          server.close();
          resolve(code);
        }
      });

      server.listen(8089, '127.0.0.1', () => {
        const authUrl = this.generateAuthUrl(state);
        onAuthUrl(authUrl);
      });

      server.on('error', (err) => {
        reject(new Error(`Failed to start OAuth server: ${err.message}`));
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth timeout - authorization not completed within 5 minutes'));
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Initialize with stored credentials or prompt for new auth.
   */
  async initialize(credentials: EVCredentials): Promise<void> {
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;

    if (credentials.accessToken && credentials.refreshToken) {
      // Use provided tokens
      this.tokens = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresIn: 3600,
        expiresAt: Date.now() + 3600000
      };
      this.authenticated = true;

      if (credentials.vin) {
        this.vin = credentials.vin;
      }
    }
  }

  /**
   * Perform interactive OAuth authentication.
   */
  async authenticate(onAuthUrl: (url: string) => void): Promise<void> {
    const state = Math.random().toString(36).substring(2);
    
    const code = await this.waitForOAuthCallback(state, onAuthUrl);
    this.tokens = await this.exchangeCode(code);
    this.authenticated = true;

    // Save tokens
    await credentialStore.updateTeslaTokens(
      this.tokens.accessToken,
      this.tokens.refreshToken,
      this.tokens.expiresAt
    );
  }

  async listVehicles(): Promise<Array<{ vin: string; displayName: string }>> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with Tesla');
    }

    const response = await this.client.get<{ response: TeslaVehicle[] }>('/api/1/vehicles');
    return response.data.response.map(v => ({
      vin: v.vin,
      displayName: v.display_name
    }));
  }

  setVin(vin: string): void {
    this.vin = vin;
  }

  async wakeUp(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    // Wake up can take a while
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.client.post(`/api/1/vehicles/${this.vin}/wake_up`);
        
        // Check if vehicle is online
        const response = await this.client.get<{ response: TeslaVehicleData }>(
          `/api/1/vehicles/${this.vin}/vehicle_data`
        );
        
        if (response.data.response.state === 'online') {
          return;
        }
      } catch (error) {
        if (i === maxAttempts - 1) throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async getStatus(): Promise<EVStatus> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    const response = await this.client.get<{ response: TeslaVehicleData }>(
      `/api/1/vehicles/${this.vin}/vehicle_data`,
      { params: { endpoints: 'charge_state' } }
    );

    const data = response.data.response;
    const chargeState = data.charge_state;

    const battery: EVBatteryStats = {
      soc: chargeState.battery_level,
      chargeLimit: chargeState.charge_limit_soc,
      isCharging: chargeState.charging_state === 'Charging',
      chargingState: chargeState.charging_state,
      chargeRate: chargeState.charge_rate,
      minutesToFull: chargeState.minutes_to_full_charge,
      batteryRange: chargeState.battery_range
    };

    return {
      vin: data.vin,
      displayName: data.display_name,
      state: data.state,
      battery
    };
  }

  async getStateOfCharge(): Promise<number> {
    const status = await this.getStatus();
    return status.battery.soc;
  }

  async getChargeLimit(): Promise<number> {
    const status = await this.getStatus();
    return status.battery.chargeLimit;
  }

  async setChargeLimit(percent: number): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    // Validate percent
    if (percent < 50 || percent > 100) {
      throw new Error('Charge limit must be between 50 and 100 percent');
    }

    await this.wakeUp();
    
    await this.client.post(`/api/1/vehicles/${this.vin}/command/set_charge_limit`, {
      percent
    });
  }

  async startCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.client.post(`/api/1/vehicles/${this.vin}/command/charge_start`);
  }

  async stopCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.client.post(`/api/1/vehicles/${this.vin}/command/charge_stop`);
  }

  async disconnect(): Promise<void> {
    this.authenticated = false;
    this.tokens = null;
  }
}
