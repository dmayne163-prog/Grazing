/**
 * Cibo Labs' PastureKey API: the same paddock readings as the website's
 * download, fetched each morning, plus the feed maps as tiles for the app's map.
 *
 * Logging in: the client ID and secret Cibo issued (local.env only, never git)
 * are swapped for an access token, good for 24 hours. The secret never leaves
 * this server; the browser only ever sees our own tile URLs.
 *
 * Each morning the readings from three weeks before the newest one held up to
 * today are fetched again: Cibo smooths each figure over several passes, so a
 * recent one can still shift a little as later passes come in. They're stored
 * as PastureKey readings, the same as an imported download, so the model,
 * charts and planner use them without knowing where they came from.
 *
 * Limits Cibo gave: 30 seconds and 6 MB per request, and a shared pool of
 * capacity. A morning's fetch is a handful of requests, one at a time.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { requireAdmin } from "../auth/middleware.js";
import { addEvent, db, getSetting, setSetting } from "../db/database.js";
import { logger } from "../logger.js";
import { today } from "../stock/store.js";
import { refreshEstimates } from "./sentinel.js";

const log = logger("cibo-api");
const LOGIN = "https://login.cibolabs.com/oauth2/token";
const DATA = "https://data.pasturekey.cibolabs.com";
const TILES = "https://tiles.pasturekey.cibolabs.com";
const PK = "cibo-pasturekey";
/** With nothing held yet, how far back to start. PastureKey's history here begins Aug 2025. */
const FIRST_FROM = "2025-08-01";
/** Fetched again each time: recent figures still settle as later passes arrive. */
const REFETCH_DAYS = 21;
/** Days per request, to stay well inside the 30-second limit. */
const CHUNK_DAYS = 60;

export const ciboApiConfigured = () => !!(config.ciboClientId && config.ciboClientSecret && config.ciboPropertyId);

/* -------------------------------- logging in ------------------------------- */

let token: { value: string; until: number } | null = null;

async function getToken(fresh = false): Promise<string> {
  if (!fresh && token && Date.now() < token.until) return token.value;
  const basic = Buffer.from(`${config.ciboClientId}:${config.ciboClientSecret}`).toString("base64");
  const res = await fetch(LOGIN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    token = null;
    throw new Error(res.status === 400 || res.status === 401
      ? "Cibo didn't accept the client ID and secret: check CIBO_CLIENT_ID and CIBO_CLIENT_SECRET in local.env"
      : `Cibo's login answered ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Cibo's login gave no access token");
  // Renewed an hour early, so a token never runs out part-way through a fetch.
  const life = Number.isFinite(body.expires_in) && body.expires_in! > 7200 ? body.expires_in! * 1000 : 24 * 3600_000;
  token = { value: body.access_token, until: Date.now() + life - 3600_000 };
  return token.value;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * One request with the token. An expired or refused token is renewed once;
 * busy (429) or briefly down (5xx) waits and tries again.
 */
async function call(url: string, init: RequestInit = {}, accept = "application/json"): Promise<Response> {
  let renewed = false;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await getToken()}`, Accept: accept },
      signal: AbortSignal.timeout(40_000),
    });
    if ((res.status === 401 || res.status === 403) && !renewed) {
      renewed = true;
      await getToken(true);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(5_000 * attempt);
      continue;
    }
    return res;
  }
}

async function callJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await call(url, init);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ` ${((await res.json()) as { message?: string }).message ?? ""}`; } catch { /* no body */ }
    throw new Error(`Cibo answered ${msg.trim()}`);
  }
  return (await res.json()) as T;
}

/* --------------------------------- readings -------------------------------- */

const toApi = (iso: string) => iso.replaceAll("-", "");
const fromApi = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10));
const shift = (iso: string, n: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

interface Stat {
  measure: string;
  dates?: string[];
  [field: string]: unknown;
}
interface StatsReply { property_id: string; paddocks: Array<{ paddock_id: string; paddock_name: string; area_ha: number; stats: Stat[] }> }

/** One pass's figures for one paddock, from however many of the stats calls had it. */
export interface ApiReading {
  paddock: string; date: string;
  tsdm: number | null; error: number | null; change_rate: number | null; captured_pct: number | null; signal: string | null;
  green: number | null; green_change_rate: number | null; dead: number | null;
  fc_green: number | null; fc_dead: number | null; fc_bare: number | null;
}

/** The i-th value of a stats field: a list per date, or a single value when there's one date. */
function nth(stat: Stat, field: string, i: number): unknown {
  const v = stat[field];
  return Array.isArray(v) ? v[i] : v;
}
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** Every reading from the four stats calls for one span of dates, merged by paddock and date. */
async function fetchSpan(from: string, to: string): Promise<ApiReading[]> {
  const q = `startdate=${toApi(from)}&enddate=${toApi(to)}`;
  const pid = encodeURIComponent(config.ciboPropertyId);
  const post = { method: "POST" };
  const replies: StatsReply[] = [];
  // One after another, not all at once: Cibo's capacity is shared.
  for (const path of [`gettsdmstats/${pid}?${q}&signal_strength=yes`, `gettsdmgreenstats/${pid}?${q}`, `gettsdmdeadstats/${pid}?${q}`, `getfcstats/${pid}?${q}`]) {
    replies.push(await callJson<StatsReply>(`${DATA}/${path}`, post));
  }
  const byKey = new Map<string, ApiReading>();
  const at = (paddock: string, date: string) => {
    const k = `${paddock}|${date}`;
    let r = byKey.get(k);
    if (!r) {
      r = { paddock, date, tsdm: null, error: null, change_rate: null, captured_pct: null, signal: null, green: null, green_change_rate: null, dead: null, fc_green: null, fc_dead: null, fc_bare: null };
      byKey.set(k, r);
    }
    return r;
  };
  for (const reply of replies) {
    for (const p of reply.paddocks ?? []) {
      for (const s of p.stats ?? []) {
        (s.dates ?? []).forEach((d, i) => {
          const r = at(p.paddock_name, fromApi(String(d)));
          const v = (f: string) => numOrNull(nth(s, f, i));
          switch (s.measure) {
            case "tsdm":
              r.tsdm = v("median"); r.error = v("median_error"); r.change_rate = v("change_rate"); r.captured_pct = v("captured");
              { const sig = nth(s, "signal_strength", i); r.signal = typeof sig === "string" ? sig : null; }
              break;
            case "tsdmgreen": r.green = v("median"); r.green_change_rate = v("change_rate"); break;
            case "tsdmdead": r.dead = v("median"); break;
            case "fcgreen": r.fc_green = v("median"); break;
            case "fcdead": r.fc_dead = v("median"); break;
            case "fcbare": r.fc_bare = v("median"); break;
          }
        });
      }
    }
  }
  // A pass with no total figure (cloud, or nothing estimated) isn't a reading.
  return [...byKey.values()].filter((r) => r.tsdm !== null);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface CiboApiStatus {
  configured: boolean;
  running: boolean;
  last?: { at: number; ok: boolean; from?: string; to?: string; readings?: number; added?: number; updated?: number; newest?: string | null; unmatched?: string[]; error?: string };
}

let running = false;

export function ciboApiStatus(): CiboApiStatus {
  let last: CiboApiStatus["last"];
  try { last = JSON.parse(getSetting("cibo_api_last") ?? "null") ?? undefined; } catch { last = undefined; }
  return { configured: ciboApiConfigured(), running, last };
}

/** Fetches the readings since a little before the newest held, and stores them. */
export async function syncCiboApi(): Promise<CiboApiStatus> {
  if (!ciboApiConfigured()) throw new Error("The Cibo API isn't set up on this server");
  if (running) return ciboApiStatus();
  running = true;
  const started = Date.now();
  try {
    const newest = (db.prepare("SELECT MAX(date) AS d FROM pasture_obs WHERE source = ? AND feature_id != 0").get(PK) as { d: string | null }).d;
    const from = newest ? shift(newest, -REFETCH_DAYS) : FIRST_FROM;
    const to = today();
    const readings: ApiReading[] = [];
    for (let a = from; a <= to; a = shift(a, CHUNK_DAYS)) {
      const b = shift(a, CHUNK_DAYS - 1);
      readings.push(...(await fetchSpan(a, b < to ? b : to)));
    }

    const pads = db.prepare("SELECT id, name FROM features WHERE kind = 'paddock' AND deleted_at IS NULL").all() as Array<{ id: number; name: string }>;
    const index = new Map(pads.map((p) => [norm(p.name), p.id]));
    const have = new Set((db.prepare("SELECT feature_id || '|' || date AS k FROM pasture_obs WHERE source = ?").all(PK) as Array<{ k: string }>).map((x) => x.k));
    const unmatched = new Set<string>();
    const now = Date.now();
    const up = db.prepare(`
      INSERT INTO pasture_obs (feature_id, date, source, tsdm_p50, tsdm_error, change_rate, captured_pct, green, green_change_rate,
        dead, fc_green, fc_dead, fc_bare, signal, import_file, created_at, updated_at)
      VALUES (@fid, @date, '${PK}', @tsdm, @error, @change_rate, @captured_pct, @green, @green_change_rate,
        @dead, @fc_green, @fc_dead, @fc_bare, @signal, 'cibo-api', @now, @now)
      ON CONFLICT(feature_id, date, source) DO UPDATE SET
        tsdm_p50 = excluded.tsdm_p50, tsdm_error = excluded.tsdm_error, change_rate = excluded.change_rate,
        captured_pct = excluded.captured_pct, green = excluded.green, green_change_rate = excluded.green_change_rate,
        dead = excluded.dead, fc_green = excluded.fc_green, fc_dead = excluded.fc_dead, fc_bare = excluded.fc_bare,
        signal = excluded.signal, import_file = excluded.import_file, updated_at = excluded.updated_at
      WHERE pasture_obs.tsdm_p50 IS NOT excluded.tsdm_p50 OR pasture_obs.green IS NOT excluded.green
        OR pasture_obs.dead IS NOT excluded.dead OR pasture_obs.fc_green IS NOT excluded.fc_green
        OR pasture_obs.signal IS NOT excluded.signal OR pasture_obs.captured_pct IS NOT excluded.captured_pct
    `);
    let added = 0, updated = 0;
    db.transaction(() => {
      for (const r of readings) {
        const fid = index.get(norm(r.paddock));
        if (!fid) { unmatched.add(r.paddock); continue; }
        const { paddock: _p, ...vals } = r;
        const changed = up.run({ ...vals, fid, now }).changes > 0;
        if (!changed) continue;
        if (have.has(`${fid}|${r.date}`)) updated++; else added++;
      }
    })();
    const newestNow = (db.prepare("SELECT MAX(date) AS d FROM pasture_obs WHERE source = ? AND feature_id != 0").get(PK) as { d: string | null }).d;
    const last = { at: started, ok: true, from, to, readings: readings.length, added, updated, newest: newestNow, unmatched: [...unmatched].sort() };
    setSetting("cibo_api_last", JSON.stringify(last));
    setSetting("cibo_api_synced_on", today());
    log.info(`fetched ${readings.length} PastureKey readings ${from} to ${to}: ${added} new, ${updated} changed${unmatched.size ? `; not matched to a paddock: ${[...unmatched].join(", ")}` : ""}`);
    // The satellite estimate leans on the newest PastureKey readings: rework it when they change.
    if (added || updated) await refreshEstimates(false).catch((e) => log.warn(`reworking the satellite estimate failed: ${String(e)}`));
    return ciboApiStatus();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSetting("cibo_api_last", JSON.stringify({ at: started, ok: false, error }));
    throw e;
  } finally {
    running = false;
  }
}

export function startCiboApiSync(): NodeJS.Timeout {
  const due = () => ciboApiConfigured() && getSetting("cibo_api_synced_on") !== today();
  const run = () => syncCiboApi().catch((e) => log.error(`Cibo API fetch failed: ${String(e)}`));
  setTimeout(() => { if (due()) void run(); }, 60_000).unref();
  const t = setInterval(() => {
    if (new Date().getHours() >= config.ciboHour && due()) void run();
  }, 30 * 60_000);
  t.unref();
  return t;
}

/* ----------------------------------- maps ---------------------------------- */

/** The feed maps the map's layer offers, in Cibo's own names. */
export const CIBO_LAYERS: Array<{ id: string; label: string }> = [
  { id: "tsdm", label: "Total feed (kg/ha)" },
  { id: "greentsdm", label: "Green feed (kg/ha)" },
  { id: "drytsdm", label: "Dead feed (kg/ha)" },
  { id: "tsdmchange", label: "Change over the last 30 days" },
  { id: "fractionalcover", label: "Ground cover: red bare, green green, blue dead" },
  { id: "totalcover", label: "Total ground cover (%)" },
  { id: "greencover", label: "Green ground cover (%)" },
  { id: "nbar", label: "Satellite picture (true colour)" },
];
const LAYER_IDS = new Set(CIBO_LAYERS.map((l) => l.id));

let datesCache: { at: number; dates: string[] } | null = null;
/** The dates Cibo has maps for, newest first, as YYYY-MM-DD. Asked at most every hour. */
async function mapDates(): Promise<string[]> {
  if (datesCache && Date.now() - datesCache.at < 3600_000) return datesCache.dates;
  const r = await callJson<{ dates?: string[] }>(`${TILES}/getimagedates/${encodeURIComponent(config.ciboPropertyId)}`);
  const dates = (r.dates ?? []).map((d) => fromApi(String(d))).sort().reverse();
  datesCache = { at: Date.now(), dates };
  return dates;
}

const legends = new Map<string, unknown>();
let boundsCache: unknown = null;

const tileRoot = join(config.dataDir, "tiles", "cibo");
/** A few tiles at a time: Cibo's capacity is shared. */
let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

async function tile(layer: string, date: string, z: number, x: number, y: number): Promise<Buffer | null> {
  const file = join(tileRoot, layer, date, String(z), String(x), `${y}.png`);
  // A date's map doesn't change once made, so a kept tile is used as it is.
  try { return await readFile(file); } catch { /* not kept yet */ }
  const res = await slot(() => call(`${TILES}/${layer}/${toApi(date)}/${encodeURIComponent(config.ciboPropertyId)}/${z}/${x}/${y}`, {}, "image/png"));
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Cibo tile ${layer} ${date} ${z}/${x}/${y}: ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
  } catch (e) { log.warn(`couldn't keep a Cibo tile: ${String(e)}`); }
  return buf;
}

/** Status, the morning fetch on demand, and what the map layer needs. Mounted under /api (signed in). */
export const ciboApi = Router();

ciboApi.get("/cibo/status", (_req, res) => {
  res.json(ciboApiStatus());
});

/** Fetches now, in the background; the status says how it went. */
ciboApi.post("/cibo/sync", requireAdmin, (req, res) => {
  if (!ciboApiConfigured()) { res.status(400).json({ error: "The Cibo API isn't set up on this server" }); return; }
  addEvent({ ts: Date.now(), source: "pasture", kind: "action", severity: "info", message: `${req.user?.username ?? null} fetched PastureKey readings from Cibo`, value: null });
  syncCiboApi().catch((e) => log.error(`Cibo API fetch failed: ${String(e)}`));
  res.json({ ...ciboApiStatus(), running: true });
});

/** The dates and layers for the map, with the property's extent. */
ciboApi.get("/cibo/maps", async (_req, res) => {
  if (!ciboApiConfigured()) { res.json({ configured: false, layers: CIBO_LAYERS, dates: [] }); return; }
  try {
    if (!boundsCache) boundsCache = await callJson(`${TILES}/getbounds/${encodeURIComponent(config.ciboPropertyId)}`);
    res.json({ configured: true, layers: CIBO_LAYERS, dates: await mapDates(), bounds: boundsCache });
  } catch (e) {
    log.warn(`Cibo map dates: ${String(e)}`);
    res.status(502).json({ error: "Couldn't reach Cibo for the map dates" });
  }
});

/** What each colour means on a layer. */
ciboApi.get("/cibo/legend/:layer", async (req, res) => {
  const layer = String(req.params["layer"]);
  if (!LAYER_IDS.has(layer) || !ciboApiConfigured()) { res.status(404).end(); return; }
  try {
    if (!legends.has(layer)) legends.set(layer, await callJson(`${TILES}/legend/${layer}`));
    res.json(legends.get(layer));
  } catch {
    // fractionalcover and nbar have no legend: the map says what their colours mean.
    res.json(null);
  }
});

/** The map tiles, fetched with the server's token and kept on disk. Mounted under /tiles/cibo (signed in). */
export const ciboTiles = Router();

ciboTiles.get("/:layer/:date/:z/:x/:y", async (req, res) => {
  const layer = String(req.params["layer"]);
  const date = String(req.params["date"]);
  const z = Number(req.params["z"]), x = Number(req.params["x"]);
  const y = Number(String(req.params["y"]).replace(/\.png$/, ""));
  const n = 2 ** z;
  if (!ciboApiConfigured() || !LAYER_IDS.has(layer) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || ![z, x, y].every(Number.isInteger) || z < 5 || z > 18 || x < 0 || y < 0 || x >= n || y >= n) {
    res.status(404).end();
    return;
  }
  try {
    const buf = await tile(layer, date, z, x, y);
    if (!buf) { res.status(404).end(); return; }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.end(buf);
  } catch (e) {
    log.warn(String(e));
    res.status(502).end();
  }
});
