/**
 * Electric Vehicle types and interfaces.
 */

export interface EVBatteryStats {
  soc: number; // State of charge percentage (0-100)
  chargeLimit: number; // Current charge limit percentage
  isCharging: boolean;
  chargingState: string; // e.g., "Disconnected", "Charging", "Complete", "Stopped"
  chargeRate?: number; // Current charge rate in kW
  minutesToFull?: number; // Estimated minutes to reach charge limit
  batteryRange?: number; // Estimated range in miles
}

export interface EVStatus {
  vin: string;
  displayName: string;
  state: string; // e.g., "online", "asleep", "offline"
  battery: EVBatteryStats;
}

export interface EVCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  vin?: string;
}

export interface TeslaTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
}

export interface EVService {
  /**
   * Initialize the EV service with credentials.
   */
  initialize(credentials: EVCredentials): Promise<void>;

  /**
   * Get the current battery state of charge.
   */
  getStateOfCharge(): Promise<number>;

  /**
   * Get the current charge limit.
   */
  getChargeLimit(): Promise<number>;

  /**
   * Set the charge limit percentage.
   */
  setChargeLimit(percent: number): Promise<void>;

  /**
   * Start charging the vehicle.
   */
  startCharging(): Promise<void>;

  /**
   * Stop charging the vehicle.
   */
  stopCharging(): Promise<void>;

  /**
   * Get full vehicle status.
   */
  getStatus(): Promise<EVStatus>;

  /**
   * Wake up the vehicle if asleep.
   */
  wakeUp(): Promise<void>;

  /**
   * Check if the service is authenticated.
   */
  isAuthenticated(): boolean;

  /**
   * Get the service name/type.
   */
  getName(): string;

  /**
   * List available vehicles.
   */
  listVehicles(): Promise<Array<{ vin: string; displayName: string }>>;

  /**
   * Disconnect and cleanup.
   */
  disconnect(): Promise<void>;
}
