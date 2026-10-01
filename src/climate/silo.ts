/**
 * SILO climate data: daily rain, temperature and evaporation from the
 * Queensland Government's gridded dataset, 1889 to yesterday.
 *
 * The grid is 0.05° (about 5 km), so a property this size spans several grid
 * points. Each paddock is assigned the grid point its centre falls nearest,
 * and property-wide figures are the paddock-area-weighted mean of those.
 *
 * SILO is an estimate interpolated from Bureau stations, not a measurement
 * here, so it lives in its own tables. The gauges stay the farm's record.
 */
import { config } from "../config.js";
import { db, getSetting, setSetting } from "../db/database.js";
import { logger } from "../logger.js";

const log = logger("silo");
const API = "https://www.longpaddock.qld.gov.au/cgi-bin/silo/DataDrillDataset.php";
const GRID = 0.05;
export const SILO_START = "1889-01-01";
/** SILO revises recent days as late station reports arrive, so each top-up re-fetches this many. */
const REVISE_DAYS = 60;

export interface Cell { cell: string; lat: number; lon: number; area_ha: number; paddocks: number[] }

type Ring = [number, number][];

/** Area-weighted centre of a ring, in plain lon/lat — fine at paddock scale. */
function ringCentre(ring: Ring): { x: number; y: number; a: number } {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!, [x1, y1] = ring[i]!;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length || 1;
    return { x: ring.reduce((t, p) => t + p[0], 0) / n, y: ring.reduce((t, p) => t + p[1], 0) / n, a: 0 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a), a: Math.abs(a / 2) };
}

function centreOf(geometry: { type: string; coordinates: unknown }): { lat: number; lon: number } | null {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates as Ring[]]
    : geometry.type === "MultiPolygon" ? (geometry.coordinates as Ring[][]) : [];
  let best: { x: number; y: number; a: number } | null = null;
  for (const p of polys) {
    const c = p[0] ? ringCentre(p[0]) : null;
    if (c && (!best || c.a > best.a)) best = c;
  }
  return best ? { lat: best.y, lon: best.x } : null;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
const cellId = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/** Which grid point each paddock uses. */
export function paddockCells(): Map<number, string> {
  const rows = db.prepare(
    "SELECT id, geometry FROM features WHERE kind = 'paddock' AND deleted_at IS NULL"
  ).all() as Array<{ id: number; geometry: string }>;
  const out = new Map<number, string>();
  for (const r of rows) {
    const c = centreOf(JSON.parse(r.geometry));
    if (c) out.set(r.id, cellId(snap(c.lat), snap(c.lon)));
  }
  return out;
}

/** The grid points the property needs, each with the paddock area it stands for. */
export function propertyCells(): Cell[] {
  const area = new Map((db.prepare(
    "SELECT id, area_ha FROM features WHERE kind = 'paddock' AND deleted_at IS NULL"
  ).all() as Array<{ id: number; area_ha: number | null }>).map((r) => [r.id, r.area_ha ?? 0]));
  const cells = new Map<string, Cell>();
  for (const [pid, id] of paddockCells()) {
    const [lat, lon] = id.split(",").map(Number) as [number, number];
    const c = cells.get(id) ?? { cell: id, lat, lon, area_ha: 0, paddocks: [] };
    c.area_ha += area.get(pid) ?? 0;
    c.paddocks.push(pid);
    cells.set(id, c);
  }
  return [...cells.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}

export interface SiloDay { date: string; rain: number | null; tmax: number | null; tmin: number | null; evap: number | null; et0: number | null }

/** Parses SILO's CSV output (comment=RXNEF), finding columns by heading. */
export function parseSiloCsv(text: string): { elevation: number | null; days: SiloDay[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? "").split(",").map((h) => h.trim());
  const at = (name: string) => head.indexOf(name);
  const iDate = at("YYYY-MM-DD");
  if (iDate < 0) throw new Error(`SILO sent something unexpected: ${(lines[0] ?? "").slice(0, 200)}`);
  const cols = { rain: at("daily_rain"), tmax: at("max_temp"), tmin: at("min_temp"), evap: at("evap_pan"), et0: at("et_short_crop") };
  const num = (cells: string[], i: number) => {
    if (i < 0) return null;
    const n = Number(cells[i]);
    return Number.isFinite(n) ? n : null;
  };
  let elevation: number | null = null;
  const days: SiloDay[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const m = /elevation=\s*([\d.]+)/.exec(line);
    if (m) elevation = Number(m[1]);
    const date = (cells[iDate] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    days.push({ date, rain: num(cells, cols.rain), tmax: num(cells, cols.tmax), tmin: num(cells, cols.tmin), evap: num(cells, cols.evap), et0: num(cells, cols.et0) });
  }
  return { elevation, days };
}

const compact = (d: string) => d.replaceAll("-", "");

async function fetchCell(lat: number, lon: number, start: string, finish: string) {
  const q = new URLSearchParams({
    lat: lat.toFixed(2), lon: lon.toFixed(2), start: compact(start), finish: compact(finish),
    format: "csv", comment: "RXNEF", username: config.siloEmail, password: "apirequest",
  });
  const res = await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`SILO answered ${res.status}`);
  return parseSiloCsv(await res.text());
}

/** Local calendar date, n days from today. */
export function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const upsert = db.prepare(`
  INSERT INTO climate_daily (cell, date, rain, tmax, tmin, evap, et0) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(cell, date) DO UPDATE SET rain = excluded.rain, tmax = excluded.tmax, tmin = excluded.tmin,
    evap = excluded.evap, et0 = excluded.et0
`);

let running: Promise<SyncResult> | null = null;
export interface SyncResult { cells: number; days: number; errors: string[]; skipped?: string }

/**
 * Brings every grid point up to yesterday: the whole record the first time,
 * then the last couple of months each day. One grid point at a time, to go
 * easy on a free public service.
 */
export function syncClimate(): Promise<SyncResult> {
  running ??= doSync().finally(() => { running = null; });
  return running;
}

async function doSync(): Promise<SyncResult> {
  if (!config.siloEmail) return { cells: 0, days: 0, errors: [], skipped: "SILO_EMAIL is not set" };
  const cells = propertyCells();
  const yesterday = localDate(-1);
  const known = new Map((db.prepare("SELECT * FROM climate_cells").all() as Array<{ cell: string; last_date: string | null }>)
    .map((r) => [r.cell, r.last_date]));
  let days = 0;
  const errors: string[] = [];
  for (const c of cells) {
    const last = known.get(c.cell) ?? null;
    const start = last ? addDays(last, -REVISE_DAYS) : SILO_START;
    if (last && last >= yesterday && known.has(c.cell)) continue;
    try {
      const t0 = Date.now();
      const got = await fetchCell(c.lat, c.lon, start, yesterday);
      if (!got.days.length) throw new Error("SILO returned no days");
      db.transaction(() => {
        for (const d of got.days) upsert.run(c.cell, d.date, d.rain, d.tmax, d.tmin, d.evap, d.et0);
        db.prepare(`
          INSERT INTO climate_cells (cell, lat, lon, elevation_m, first_date, last_date, fetched_at, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(cell) DO UPDATE SET elevation_m = COALESCE(excluded.elevation_m, elevation_m),
            first_date = MIN(COALESCE(first_date, excluded.first_date), excluded.first_date),
            last_date = excluded.last_date, fetched_at = excluded.fetched_at, error = NULL
        `).run(c.cell, c.lat, c.lon, got.elevation, got.days[0]!.date, got.days[got.days.length - 1]!.date, Date.now());
      })();
      days += got.days.length;
      log.info(`${c.cell}: ${got.days.length} days to ${got.days[got.days.length - 1]!.date} in ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${c.cell}: ${msg}`);
      log.warn(`fetching ${c.cell} failed: ${msg}`);
      db.prepare(`
        INSERT INTO climate_cells (cell, lat, lon, error) VALUES (?, ?, ?, ?)
        ON CONFLICT(cell) DO UPDATE SET error = excluded.error
      `).run(c.cell, c.lat, c.lon, msg.slice(0, 300));
    }
  }
  if (!errors.length) setSetting("silo_synced_on", localDate());
  return { cells: cells.length, days, errors };
}

/**
 * Tops up once a day after SILO_HOUR, and straight away at start-up when
 * today's top-up hasn't happened, so a fresh install fills in on its own.
 */
export function startClimateSync(): NodeJS.Timeout {
  const due = () => getSetting("silo_synced_on") !== localDate();
  const run = () => syncClimate().catch((e) => log.error(`SILO sync failed: ${String(e)}`));
  setTimeout(() => { if (due()) void run(); }, 20_000).unref();
  const t = setInterval(() => {
    if (new Date().getHours() >= config.siloHour && due()) void run();
  }, 30 * 60_000);
  t.unref();
  return t;
}

export interface ClimateStatus {
  configured: boolean;
  cells: Array<{ cell: string; area_ha: number; paddocks: number; first_date: string | null; last_date: string | null; error: string | null }>;
  last_date: string | null;
  syncing: boolean;
}

export function climateStatus(): ClimateStatus {
  const stored = new Map((db.prepare("SELECT * FROM climate_cells").all() as Array<{ cell: string; first_date: string | null; last_date: string | null; error: string | null }>)
    .map((r) => [r.cell, r]));
  const cells = propertyCells().map((c) => {
    const s = stored.get(c.cell);
    return { cell: c.cell, area_ha: c.area_ha, paddocks: c.paddocks.length, first_date: s?.first_date ?? null, last_date: s?.last_date ?? null, error: s?.error ?? null };
  });
  const ready = cells.filter((c) => c.last_date);
  return {
    configured: !!config.siloEmail,
    cells,
    last_date: ready.length === cells.length && ready.length ? ready.map((c) => c.last_date!).sort()[0]! : null,
    syncing: running !== null,
  };
}

/**
 * Property-wide daily climate: the paddock-area-weighted mean over the grid
 * points that have data. Only days every such grid point has are returned.
 */
export function propertyDaily(from = SILO_START, to = "9999-12-31"): SiloDay[] {
  const cells = propertyCells().filter((c) => c.area_ha > 0);
  const have = new Set((db.prepare("SELECT cell FROM climate_cells WHERE last_date IS NOT NULL").all() as Array<{ cell: string }>).map((r) => r.cell));
  const use = cells.filter((c) => have.has(c.cell));
  if (!use.length) return [];
  const total = use.reduce((t, c) => t + c.area_ha, 0);
  const weight = new Map(use.map((c) => [c.cell, c.area_ha / total]));
  const rows = db.prepare(`
    SELECT cell, date, rain, tmax, tmin, evap, et0 FROM climate_daily
    WHERE date BETWEEN ? AND ? AND cell IN (${use.map(() => "?").join(",")}) ORDER BY date
  `).all(from, to, ...use.map((c) => c.cell)) as Array<SiloDay & { cell: string }>;
  const out: SiloDay[] = [];
  let cur: { date: string; n: number; acc: Record<"rain" | "tmax" | "tmin" | "evap" | "et0", number> } | null = null;
  const flush = () => {
    if (cur && cur.n === use.length) out.push({ date: cur.date, ...cur.acc });
  };
  for (const r of rows) {
    if (!cur || cur.date !== r.date) {
      flush();
      cur = { date: r.date, n: 0, acc: { rain: 0, tmax: 0, tmin: 0, evap: 0, et0: 0 } };
    }
    const w = weight.get(r.cell)!;
    cur.n++;
    cur.acc.rain += (r.rain ?? 0) * w;
    cur.acc.tmax += (r.tmax ?? 0) * w;
    cur.acc.tmin += (r.tmin ?? 0) * w;
    cur.acc.evap += (r.evap ?? 0) * w;
    cur.acc.et0 += (r.et0 ?? 0) * w;
  }
  flush();
  return out;
}
