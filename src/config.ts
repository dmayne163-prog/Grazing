/**
 * All runtime configuration comes from environment variables so the container
 * can be reconfigured from the Unraid template without rebuilding the image.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** A comma-separated environment variable, trimmed and with blanks dropped. */
function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : fallback;
}

export const config = {
  /** HTTP port inside the container. */
  port: num("PORT", 8080),

  /** SQLite database and the imagery tile cache live here. */
  dataDir: str("DATA_DIR", "/data"),

  /** Shown in the page title and on the sign-in screen. */
  propertyName: str("PROPERTY_NAME", "Wealwandangie"),

  /**
   * Where the map opens before any paddocks exist. Once paddocks are loaded
   * the map fits to them instead, so this only matters on a fresh install.
   */
  mapCentre: [num("MAP_CENTRE_LAT", -24.1), num("MAP_CENTRE_LON", 148.1)] as [number, number],
  mapZoom: num("MAP_ZOOM", 11),

  /**
   * Imagery tiles are fetched through this server and kept on disk, so the map
   * still draws on the property's LAN when the internet is down, and so the
   * page's Content-Security-Policy can stay same-origin only.
   *
   * Tiles older than this are refetched when next viewed, which is how newer
   * imagery flights eventually show up. Set to 0 to keep tiles forever.
   */
  tileMaxAgeDays: num("TILE_MAX_AGE_DAYS", 180),

  /** Nightly database copies into DATA_DIR/backups: the hour they run, and how many are kept. */
  backupHour: num("BACKUP_HOUR", 2),
  backupKeep: num("BACKUP_KEEP", 30),

  /* ------------------------------- accounts ------------------------------ */

  /**
   * Require a login. Turning this off gives full access to anything that can
   * reach the port, which is only reasonable on a trusted network.
   */
  requireAuth: bool("REQUIRE_AUTH", true),

  /**
   * Which upstream addresses may set X-Forwarded-For / X-Forwarded-Proto.
   * Anything trusted here can claim to be on the LAN, reach the setup page,
   * and poison the rate limiter's buckets and the audit log by choosing its
   * own address, so keep it as narrow as you can.
   */
  trustedProxies: list("TRUSTED_PROXIES", ["loopback", "uniquelocal"]),

  /**
   * Extra hostnames the app is served on, for the cross-site request check.
   * The tunnel hostname normally arrives in the Host header on its own.
   */
  trustedOrigins: list("TRUSTED_ORIGINS", []),

  /** Cloudflare Access team name and Application Audience tag. */
  cfAccessTeamDomain: str("CF_ACCESS_TEAM_DOMAIN", ""),
  cfAccessAud: str("CF_ACCESS_AUD", ""),

  /**
   * Refuse non-LAN requests that have not been through Access. Fails closed:
   * on but unconfigured means remote requests are refused, not let through.
   */
  cfAccessRequired: bool("CF_ACCESS_REQUIRED", true),

  /**
   * The first-run page creates the administrator, so whoever reaches it first
   * owns the app. A token is the deliberate way to do it remotely — supplied
   * as `?setup_token=…`, and it stops working the moment an account exists.
   */
  setupLanOnly: bool("SETUP_LAN_ONLY", true),
  setupToken: str("SETUP_TOKEN", ""),

  /** How long a session lasts, refreshed each time it is used. */
  sessionDays: num("SESSION_DAYS", 60),

  logLevel: str("LOG_LEVEL", "info"),
};
