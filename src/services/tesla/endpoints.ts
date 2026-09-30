/**
 * Tesla Fleet API endpoints and region resolution.
 *
 * Hosts verified against the Tesla Fleet API docs (Getting Started -> Regions and
 * Countries) plus live unauthenticated GET /status probes:
 *   na -> https://fleet-api.prd.na.vn.cloud.tesla.com  (returns "ok")
 *   eu -> https://fleet-api.prd.eu.vn.cloud.tesla.com  (returns "ok")
 *   cn -> https://fleet-api.prd.cn.vn.cloud.tesla.cn   (note: .tesla.cn, separate portal)
 *
 * IMPORTANT CORRECTION: there is no separate APAC host. Tesla maps
 * "North America, Asia-Pacific (excluding China)" to the SAME na base URL, and
 * Europe/Middle East/Africa to eu. China is a separate deployment requiring a
 * developer.tesla.cn account (+86 phone) and its own app registration.
 */

export type TeslaRegion = 'na' | 'eu' | 'cn';

export interface TeslaRegionInfo {
  region: TeslaRegion;
  /** Base URL for all /api/1/* calls, and the value used for `audience`. */
  apiBaseUrl: string;
  /** Human-readable coverage, shown in CLI output. */
  coverage: string;
  /**
   * True when the region is served by a separate developer portal whose OAuth
   * hosts Tesla does not document alongside the global ones.
   */
  separatePortal: boolean;
}

export const TESLA_REGIONS: Record<TeslaRegion, TeslaRegionInfo> = {
  na: {
    region: 'na',
    apiBaseUrl: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
    coverage: 'North America and Asia-Pacific (excluding China)',
    separatePortal: false,
  },
  eu: {
    region: 'eu',
    apiBaseUrl: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    coverage: 'Europe, Middle East, Africa',
    separatePortal: false,
  },
  cn: {
    region: 'cn',
    apiBaseUrl: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
    coverage: 'China (separate developer.tesla.cn app and account)',
    separatePortal: true,
  },
};

/**
 * Where the user authorizes the app in a browser. Documented on the Third-Party
 * Tokens page and confirmed by that page's curl example.
 */
export const TESLA_AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

/**
 * Where token exchanges are performed.
 *
 * The docs are self-contradictory here: the OIDC metadata at
 * /oauth2/v3/thirdparty/.well-known/openid-configuration advertises
 * https://auth.tesla.com/oauth2/v3/token, but both the Partner Tokens and
 * Third-Party Tokens pages carry an explicit "Important" note that calls to
 * /token must use fleet-auth.prd.vn.cloud.tesla.com, and every curl example on
 * those pages uses it. We follow the explicit note. Override with
 * ECC_TESLA_TOKEN_URL if Tesla changes this.
 */
export const TESLA_TOKEN_URL =
  process.env.ECC_TESLA_TOKEN_URL ?? 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

/**
 * Scopes this application needs. Kept identical to the set the CLI requested
 * before this module existed, so authorization prompts do not change shape:
 * device data for SoC reads, charging commands for start/stop/limit, cmds for
 * wake-up, and offline_access so a refresh token is issued at all (without it
 * Tesla returns only a short-lived access token and the app must re-pair hourly).
 */
export const TESLA_SCOPES = [
  'openid',
  'offline_access',
  'vehicle_device_data',
  'vehicle_cmds',
  'vehicle_charging_cmds',
] as const;

export const TESLA_SCOPE_STRING = TESLA_SCOPES.join(' ');

/** Revoke a third-party token by sending the user to Tesla's consent manager. */
export function buildRevokeConsentUrl(clientId: string, region: TeslaRegion): string {
  const url = new URL(`${TESLA_REGIONS[region].apiBaseUrl}/oauth2/v3/consent`);
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

export function isTeslaRegion(value: unknown): value is TeslaRegion {
  return value === 'na' || value === 'eu' || value === 'cn';
}

/**
 * Resolve a region name to its endpoint info. Falls back to na, matching Tesla's
 * default, and throws a listing of valid values for anything unrecognised so a
 * typo fails loudly instead of silently talking to the wrong deployment (which
 * surfaces later as HTTP 421 "Incorrect region").
 */
export function resolveRegion(value?: string): TeslaRegionInfo {
  if (value === undefined || value === '') return TESLA_REGIONS.na;
  if (!isTeslaRegion(value)) {
    const valid = Object.keys(TESLA_REGIONS).join(', ');
    throw new Error(`Unknown Tesla region "${value}". Valid regions: ${valid}`);
  }
  return TESLA_REGIONS[value];
}
