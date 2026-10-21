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
  chargeEnergyAdded?: number; // kWh added in the current charge session (charge_energy_added)
  batteryRange?: number; // Estimated range in miles
}

export interface EVStatus {
  vin: string;
  displayName: string;
  state: string; // e.g., "online", "asleep", "offline"
  battery: EVBatteryStats;
}

/** Connectivity from the cheap non-waking vehicle probe. */
export interface EVVehicleState {
  state: string; // e.g., "online", "asleep", "offline"
}

export interface EVCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  /** Absolute unix time in ms; without it a stored token looks freshly minted. */
  expiresAt?: number;
  vin?: string;
  /** Tesla deployment region ("na" | "eu" | "cn"); defaults to "na". */
  region?: string;
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
   * Cheap connectivity probe: never wakes the vehicle and never waits on it,
   * so unlike a vehicle_data read it cannot 408. The poll-while-awake daemon
   * loop gates the expensive read on this result.
   */
  getVehicleState(): Promise<EVVehicleState>;

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
