import express from "express";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auth } from "./api/auth-routes.js";
import { mapApi } from "./api/map-routes.js";
import { stockApi } from "./api/stock-routes.js";
import { rainApi } from "./api/rain-routes.js";
import { attachUser, needsSetup, requireAuth } from "./auth/middleware.js";
import { accessConfigured, initAccess, requireAccess } from "./auth/cloudflare.js";
import { startRateLimitSweeper } from "./auth/ratelimit.js";
import { blockCrossSite, noStore, securityHeaders } from "./http/security.js";
import { config } from "./config.js";
import { checkpointWal, deleteExpiredSessions } from "./db/database.js";
import { startBackups } from "./db/backup.js";
import { logger } from "./logger.js";
import { tiles } from "./tiles/proxy.js";

const log = logger("app");
const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js -> ../public
const publicDir = join(here, "..", "public");

// The map libraries are served straight out of node_modules, from this origin,
// so the page needs no CDN and still loads on the LAN with the internet down.
const require = createRequire(import.meta.url);
const leafletDir = dirname(require.resolve("leaflet/dist/leaflet.js"));
const geomanDir = dirname(require.resolve("@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css"));

const app = express();

// Only the listed proxies may set X-Forwarded-*. `true` would let any caller
// forge a LAN address to reach first-run setup or dodge the rate limiter.
app.set("trust proxy", config.trustedProxies);

// No ETags on generated responses: every API response is per-session, and a
// revalidated 304 could hand one session's body to another.
app.set("etag", false);

app.use(securityHeaders);
// Generous for JSON because a paddock boundary traced from imagery can carry
// thousands of vertices. File uploads use their own raw parser and limit.
app.use(express.json({ limit: "4mb" }));

// The edge check comes before everything else, including static files: someone
// on the internet who has not been through Access should not even learn that
// this install exists.
app.use((req, res, next) => {
  requireAccess(req, res, next).catch(next);
});

app.use(blockCrossSite);
app.use(attachUser);

app.use("/api", noStore);
// For the container healthcheck. Says nothing about the farm.
app.get("/api/health", (_req, res) => { res.json({ ok: true }); });
app.use("/api/auth", auth);
app.use("/api", stockApi);
app.use("/api", rainApi);
app.use("/api", mapApi);

app.use("/tiles", requireAuth, tiles);

const vendorOpts = { etag: true, maxAge: "7d", index: false } as const;
app.use("/vendor/leaflet", express.static(leafletDir, vendorOpts));
app.use("/vendor/geoman", express.static(geomanDir, vendorOpts));

/**
 * Unauthenticated visitors get the sign-in page instead of the app. This one
 * URL serves two different documents depending on the session cookie, so it
 * must never be cached or revalidated.
 */
app.get(["/", "/index.html"], noStore, (req, res, next) => {
  if (!config.requireAuth || req.user) return next();
  res.sendFile(join(publicDir, "login.html"), { etag: false });
});

// No max-age: an app left open on a phone would otherwise keep running stale
// JS for that long after an update. The service worker handles offline.
app.use(express.static(publicDir, { index: "index.html", etag: true, maxAge: 0 }));

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.get("*", noStore, (_req, res) => {
  res.sendFile(join(publicDir, "index.html"), { etag: false });
});

const server = createServer(app);

void initAccess();
const rateLimitSweeper = startRateLimitSweeper();
const backupTimer = startBackups();

const housekeeping = setInterval(() => {
  const gone = deleteExpiredSessions();
  if (gone > 0) log.info(`removed ${gone} expired session(s)`);
  checkpointWal();
}, 6 * 3_600_000);

server.listen(config.port, () => {
  log.info(`${config.propertyName} grazing on http://0.0.0.0:${config.port}`);
  log.info(`data in ${config.dataDir}`);
  if (!config.requireAuth) {
    log.warn("REQUIRE_AUTH is off — anyone who can reach this port has full access");
  } else if (needsSetup()) {
    const how = config.setupLanOnly
      ? (config.setupToken ? "from the LAN, or remotely with the setup token" : "from the LAN only")
      : "from ANYWHERE — set SETUP_LAN_ONLY=true before publishing this";
    log.warn(`no accounts yet — the first administrator can be created ${how}`);
  }
  if (accessConfigured()) {
    log.info("Cloudflare Access: remote requests must carry a verified Access token");
  } else if (config.cfAccessRequired) {
    log.warn(
      "Cloudflare Access is not configured (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD). " +
      "Remote requests will be refused until it is."
    );
  }
});

function shutdown(signal: string) {
  log.info(`${signal} — shutting down`);
  clearInterval(housekeeping);
  clearInterval(rateLimitSweeper);
  clearInterval(backupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
