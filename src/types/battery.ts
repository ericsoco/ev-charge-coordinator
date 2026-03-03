/**
 * Battery-related types and interfaces for solar battery systems.
 */

export interface BatteryStats {
  soc: number; // State of charge percentage (0-100)
  power: number; // Current power in watts (positive = charging, negative = discharging)
  energyCapacity?: number; // Total energy capacity in kWh
  availableEnergy?: number; // Currently available energy in kWh
}

export interface BatteryCurrentStats {
  solarProduction: number;
  generatorProduction: number;
  generatorEnabled: boolean;
  batteryUse: number;
  gridUse: number;
  homeLoad: number;
  batterySoc: number;
  switch1Load: number;
  switch2Load: number;
  v2lUse: number;
  gridStatus: string;
}

export interface BatteryTotals {
  batteryCharge: number;
  batteryDischarge: number;
  gridImport: number;
  gridExport: number;
  solar: number;
  generator: number;
  homeUse: number;
  switch1Use: number;
  switch2Use: number;
  v2lExport: number;
  v2lImport: number;
}

export interface BatteryFullStats {
  current: BatteryCurrentStats;
  totals: BatteryTotals;
}

export interface BatteryCredentials {
  username: string;
  password: string;
  gatewayId: string;
}

export interface BatteryService {
  /**
   * Initialize the battery service with credentials.
   */
  initialize(credentials: BatteryCredentials): Promise<void>;

  /**
   * Get the current battery state of charge.
   */
  getStateOfCharge(): Promise<number>;

  /**
   * Get full battery statistics.
   */
  getStats(): Promise<BatteryFullStats>;

  /**
   * Check if the service is authenticated.
   */
  isAuthenticated(): boolean;

  /**
   * Get the service name/type.
   */
  getName(): string;

  /**
   * Disconnect and cleanup.
   */
  disconnect(): Promise<void>;
}
