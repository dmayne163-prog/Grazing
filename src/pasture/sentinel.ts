/**
 * Satellite estimate: the app's own paddock pasture figure, worked out from
 * the free Sentinel-2 satellite (the same one Cibo Labs uses) and fitted to
 * the PastureKey readings already held here.
 *
 * Each day the app asks the public Sentinel-2 archive on AWS (Element 84's
 * "Earth Search") for new passes over the property, reads only the part of
 * each image that covers the paddocks, and keeps one row per paddock per pass:
 * the average of ten colour bands over the pixels the satellite saw clearly.
 * A ridge regression fitted on the passes PastureKey also reported turns those
 * averages into kg/ha of total and green dry matter.
 *
 * It is an estimate of what PastureKey would say, not a measurement of the
 * paddock: it is kept as its own source ("sentinel-estimate") and nothing else
 * in the app reads it unless told to.
 *
 * Privacy: the only thing sent out is the search box, rounded out to a tenth
 * of a degree, and byte-range requests for public image files.
 *
 * No GeoTIFF library: the reader below handles exactly what these files use
 * (little-endian classic TIFF, tiled, deflate, 8 or 16 bit).
 */
import zlib from "node:zlib";
import { addEvent, db, getSetting, setSetting } from "../db/database.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { localDate } from "../climate/silo.js";

const log = logger("sentinel");

export const SAT = "sentinel-estimate";
const PK = "cibo-pasturekey";
const STAC = "https://earth-search.aws.element84.com/v1/search";
/** Metres across one pixel: an overview level every band's file carries. */
const PIXEL = 40;
const BANDS = ["blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08", "swir16", "swir22"] as const;
type Band = (typeof BANDS)[number];
type BandMeans = Record<Band, number>;
/** Scene classes that count as a clear view: vegetation, bare, water, unclassified. */
const CLEAR = new Set([4, 5, 6, 7]);
/** A pass counts for a paddock when this share of it was seen clearly. */
const CLEAR_SHARE = 0.9;
const MIN_PIXELS = 5;
/** Fewer matched PastureKey readings than this and no model is fitted. */
const MIN_TRAINING = 200;
/**
 * After a paddock's last PastureKey reading its estimate is shifted by the
 * paddock's own gap to PastureKey over this many days before it, and the shift
 * halves every half-life. The one model reads heavy paddocks low and light ones
 * high; in forward tests this correction cut the typical miss by about a fifth.
 */
const OFFSET_DAYS = 60;
const OFFSET_HALF_LIFE = 90;

/* ------------------------------- map maths ------------------------------- */

/** Longitude/latitude to UTM metres (WGS84, southern hemisphere), Krüger series. */
export function toUtm(lon: number, lat: number, zone: number): [number, number] {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const al = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const phi = (lat * Math.PI) / 180, lam = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const c = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  al.forEach((v, i) => {
    const j = i + 1;
    E += v * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += v * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  });
  return [500000 + k0 * A * E, 10000000 + k0 * A * N];
}

type Ring = Array<[number, number]>;
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (x: number, y: number, rings: Ring[]) => inRing(x, y, rings[0]!) && !rings.slice(1).some((r) => inRing(x, y, r));

/* -------------------------------- fetching ------------------------------- */

async function get(url: string, init?: RequestInit, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return r;
      if (i >= tries || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} from ${new URL(url).host}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
}
async function range(url: string, start: number, length: number): Promise<Buffer> {
  const r = await get(url, { headers: { range: `bytes=${start}-${start + length - 1}` } });
  return Buffer.from(await r.arrayBuffer());
}
async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

/* ------------------- minimal cloud-optimised GeoTIFF reader ------------------ */

interface Tag { type: number; n: number; inline: Buffer | null; at: number; size: number }
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8, 16: 8 };

class Cog {
  private head!: Buffer;
  private ifds: Array<Record<number, Tag>> = [];
  private constructor(private url: string) {}

  static async open(url: string): Promise<Cog> {
    const c = new Cog(url);
    c.head = await range(url, 0, 65536);
    const h = c.head;
    if (h.toString("latin1", 0, 2) !== "II" || h.readUInt16LE(2) !== 42) throw new Error("unexpected image file format");
    let off = h.readUInt32LE(4);
    while (off) {
      const count = (await c.bytes(off, 2)).readUInt16LE(0);
      const body = await c.bytes(off + 2, count * 12 + 4);
      const tags: Record<number, Tag> = {};
      for (let i = 0; i < count; i++) {
        const e = body.subarray(i * 12, i * 12 + 12);
        const type = e.readUInt16LE(2), n = e.readUInt32LE(4);
        const size = (TYPE_SIZE[type] ?? 1) * n;
        tags[e.readUInt16LE(0)] = { type, n, inline: size <= 4 ? Buffer.from(e.subarray(8, 12)) : null, at: e.readUInt32LE(8), size };
      }
      c.ifds.push(tags);
      off = body.readUInt32LE(count * 12);
    }
    return c;
  }
  private async bytes(at: number, len: number): Promise<Buffer> {
    if (at + len <= this.head.length) return this.head.subarray(at, at + len);
    return range(this.url, at, len);
  }
  private async values(ifd: number, tag: number): Promise<number[] | null> {
    const t = this.ifds[ifd]?.[tag];
    if (!t) return null;
    const b = t.inline ?? (await this.bytes(t.at, t.size));
    const out: number[] = [];
    for (let i = 0; i < t.n; i++) {
      if (t.type === 3) out.push(b.readUInt16LE(i * 2));
      else if (t.type === 4) out.push(b.readUInt32LE(i * 4));
      else if (t.type === 12) out.push(b.readDoubleLE(i * 8));
      else if (t.type === 16) out.push(Number(b.readBigUInt64LE(i * 8)));
      else out.push(b[i]!);
    }
    return out;
  }
  private async one(ifd: number, tag: number, fallback = 0): Promise<number> {
    return (await this.values(ifd, tag))?.[0] ?? fallback;
  }
  /** Index of the image level whose pixels are `metres` across, given the full image's pixel size. */
  async level(fullPixel: number, metres: number): Promise<number> {
    const full = await this.one(0, 256);
    for (let i = 0; i < this.ifds.length; i++) {
      const w = await this.one(i, 256);
      if (w && Math.abs((fullPixel * full) / w - metres) < 0.5) return i;
    }
    throw new Error(`no ${metres} m level in a Sentinel-2 image`);
  }
  /** Pixels col0..col1-1, row0..row1-1 of one level (0 = no data). */
  async window(ifd: number, col0: number, row0: number, col1: number, row1: number): Promise<Uint8Array | Uint16Array> {
    const W = await this.one(ifd, 256), H = await this.one(ifd, 257);
    const tw = await this.one(ifd, 322), th = await this.one(ifd, 323);
    const bits = await this.one(ifd, 258), comp = await this.one(ifd, 259, 1), pred = await this.one(ifd, 317, 1);
    if (!tw || !th || (bits !== 8 && bits !== 16)) throw new Error("unexpected image layout");
    const offs = (await this.values(ifd, 324)) ?? [], counts = (await this.values(ifd, 325)) ?? [];
    const across = Math.ceil(W / tw);
    const w = col1 - col0, h = row1 - row0;
    const out = bits === 8 ? new Uint8Array(w * h) : new Uint16Array(w * h);
    const jobs: Array<() => Promise<void>> = [];
    for (let ty = Math.floor(Math.max(0, row0) / th); ty * th < Math.min(H, row1); ty++) {
      for (let tx = Math.floor(Math.max(0, col0) / tw); tx * tw < Math.min(W, col1); tx++) {
        jobs.push(async () => {
          const i = ty * across + tx;
          const at = offs[i], len = counts[i];
          if (!at || !len) return;
          let raw = await range(this.url, at, len);
          if (comp === 8 || comp === 32946) raw = zlib.inflateSync(raw);
          else if (comp !== 1) throw new Error(`image compression ${comp} not handled`);
          if (raw.byteLength < (tw * th * bits) / 8) throw new Error("short image tile");
          // A fresh buffer, so 16-bit values sit on an even byte.
          const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
          const tile = bits === 8 ? new Uint8Array(ab, 0, tw * th) : new Uint16Array(ab, 0, tw * th);
          if (pred === 2) { for (let r = 0; r < th; r++) for (let c = 1; c < tw; c++) tile[r * tw + c]! += tile[r * tw + c - 1]!; }
          else if (pred !== 1) throw new Error(`image predictor ${pred} not handled`);
          for (let r = Math.max(row0, ty * th); r < Math.min(row1, (ty + 1) * th, H); r++) {
            for (let c = Math.max(col0, tx * tw); c < Math.min(col1, (tx + 1) * tw, W); c++) {
              out[(r - row0) * w + (c - col0)] = tile[(r - ty * th) * tw + (c - tx * tw)]!;
            }
          }
        });
      }
    }
    await pool(jobs, 4);
    return out;
  }
}

/* ------------------------------- the property ------------------------------ */

interface Pad { id: number; name: string; zone: number; polys: Ring[][]; lonlat: Array<[number, number]> }

function loadPaddocks(): Pad[] {
  const rows = db.prepare("SELECT id, name, geometry FROM features WHERE kind = 'paddock' AND deleted_at IS NULL").all() as Array<{ id: number; name: string; geometry: string }>;
  const out: Pad[] = [];
  for (const r of rows) {
    let g: { type: string; coordinates: unknown };
    try { g = JSON.parse(r.geometry) as typeof g; } catch { continue; }
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) as number[][][][];
    const first = polys[0]?.[0]?.[0];
    if (!first) continue;
    const zone = Math.floor((first[0]! + 180) / 6) + 1;
    out.push({
      id: r.id, name: r.name, zone,
      lonlat: polys.flatMap((p) => (p[0] ?? []).map((c) => [c[0]!, c[1]!] as [number, number])),
      polys: polys.map((p) => p.map((ring) => ring.map((c) => toUtm(c[0]!, c[1]!, zone)))),
    });
  }
  return out;
}

interface Grid { code: string; x0: number; y0: number; size: number; zone: number; full: number }

/** The pixels of one tile whose centres fall inside the paddock; null if it isn't wholly on the tile. */
function pixelsFor(p: Pad, g: Grid): Array<[number, number]> | null {
  if (p.zone !== g.zone) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const poly of p.polys) for (const [x, y] of poly[0]!) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const c0 = Math.floor((x0 - g.x0) / PIXEL), c1 = Math.ceil((x1 - g.x0) / PIXEL);
  const r0 = Math.floor((g.y0 - y1) / PIXEL), r1 = Math.ceil((g.y0 - y0) / PIXEL);
  if (c0 < 0 || r0 < 0 || c1 > g.size || r1 > g.size) return null;
  const px: Array<[number, number]> = [];
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    const x = g.x0 + (c + 0.5) * PIXEL, y = g.y0 - (r + 0.5) * PIXEL;
    if (p.polys.some((poly) => inPolygon(x, y, poly))) px.push([c, r]);
  }
  return px;
}

interface Item {
  id: string;
  properties: Record<string, unknown> & { datetime: string };
  assets: Record<string, { href: string; "proj:transform"?: number[]; "proj:shape"?: number[] }>;
}

async function search(bbox: number[], from: string, to: string): Promise<Item[]> {
  const items: Item[] = [];
  let body: unknown = { collections: ["sentinel-2-l2a"], bbox, datetime: `${from}T00:00:00Z/${to}T23:59:59Z`, limit: 200 };
  for (let page = 0; page < 50; page++) {
    const r = await get(STAC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json()) as { features?: Item[]; links?: Array<{ rel: string; body?: unknown }> };
    const got = j.features ?? [];
    items.push(...got);
    const next = (j.links ?? []).find((l) => l.rel === "next");
    if (!next?.body || !got.length) break;
    body = next.body;
  }
  return items;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayGap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/* ---------------------------------- sync --------------------------------- */

export interface SyncResult { passes: number; estimates: number }

let running: Promise<SyncResult> | null = null;
let progress: string | null = null;
let lastError: string | null = null;

/** Fetches any passes not yet held, then brings the estimates up to date. One run at a time. */
export function syncSentinel(): Promise<SyncResult> {
  if (!running) {
    running = doSync()
      .then((r) => { lastError = null; return r; }, (e: unknown) => { lastError = e instanceof Error ? e.message : String(e); throw e; })
      .finally(() => { running = null; progress = null; });
  }
  return running;
}

async function doSync(): Promise<SyncResult> {
  const paddocks = loadPaddocks();
  if (!paddocks.length) return { passes: 0, estimates: 0 };
  const today = localDate();
  const firstPk = (db.prepare("SELECT MIN(date) AS d FROM pasture_obs WHERE source = ? AND feature_id != 0").get(PK) as { d: string | null }).d;
  const lastPass = (db.prepare("SELECT MAX(date) AS d FROM sentinel_passes").get() as { d: string | null }).d;
  // Scenes can reach the archive a few days late, so each run looks back a little.
  const from = lastPass ? addDays(lastPass, -10) : firstPk ?? addDays(today, -400);

  let w = 180, e = -180, s = 90, n = -90;
  for (const p of paddocks) for (const [x, y] of p.lonlat) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const bbox = [Math.floor(w * 10) / 10, Math.floor(s * 10) / 10, Math.ceil(e * 10) / 10, Math.ceil(n * 10) / 10];
  // The pass's date where the property is: the satellite crosses mid-morning local time.
  const hours = (w + e) / 2 / 15;
  const dateOf = (it: Item) => new Date(Date.parse(it.properties.datetime) + hours * 3_600_000).toISOString().slice(0, 10);

  progress = "looking for new passes";
  const items = (await search(bbox, from, today)).filter((it) => it.assets["red"] && it.assets["scl"]);

  const grids = new Map<string, Grid>();
  for (const it of items) {
    const code = String(it.properties["grid:code"] ?? "");
    const t = it.assets["red"]!["proj:transform"], shape = it.assets["red"]!["proj:shape"];
    const epsg = String(it.properties["proj:epsg"] ?? it.properties["proj:code"] ?? "");
    if (!code || grids.has(code) || !t || !shape || !/327\d\d$/.test(epsg)) continue;
    grids.set(code, { code, x0: t[2]!, y0: t[5]!, full: t[0]!, size: Math.round((shape[0]! * t[0]!) / PIXEL), zone: Number(epsg.slice(-2)) });
  }
  const pixelCache = new Map<string, Array<[number, number]> | null>();
  const pixels = (p: Pad, g: Grid) => {
    const k = `${g.code}|${p.id}`;
    if (!pixelCache.has(k)) pixelCache.set(k, pixelsFor(p, g));
    return pixelCache.get(k)!;
  };
  // Tiles overlap; the one holding the most paddocks is tried first, so most days need one or two.
  const order = [...grids.values()].sort((a, b) =>
    paddocks.filter((p) => pixels(p, b)).length - paddocks.filter((p) => pixels(p, a)).length || a.code.localeCompare(b.code));

  const held = new Map((db.prepare("SELECT date, complete FROM sentinel_passes").all() as Array<{ date: string; complete: number }>).map((r) => [r.date, r.complete]));
  const dates = [...new Set(items.map(dateOf))].sort()
    // A pass missing a tile is tried again for a few days, then left as it is.
    .filter((d) => !held.has(d) || (held.get(d) === 0 && d >= addDays(today, -6)));

  const putBand = db.prepare(`INSERT INTO sentinel_bands (feature_id, date, pixels, seen, clear, bands, scene, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feature_id, date) DO UPDATE SET
    pixels = excluded.pixels, seen = excluded.seen, clear = excluded.clear, bands = excluded.bands, scene = excluded.scene, fetched_at = excluded.fetched_at`);
  const putPass = db.prepare(`INSERT INTO sentinel_passes (date, scenes, complete, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET scenes = excluded.scenes, complete = excluded.complete, fetched_at = excluded.fetched_at`);

  let done = 0;
  for (const date of dates) {
    progress = `reading the pass of ${date} (${done + 1} of ${dates.length})`;
    const sceneOf = new Map<string, Item>();
    for (const it of items) {
      if (dateOf(it) !== date) continue;
      const code = String(it.properties["grid:code"] ?? "");
      const cur = sceneOf.get(code);
      if (!cur || String(it.properties["updated"] ?? "") > String(cur.properties["updated"] ?? "")) sceneOf.set(code, it);
    }
    const byTile = new Map<string, Pad[]>();
    let complete = true;
    for (const p of paddocks) {
      const g = order.find((o) => sceneOf.has(o.code) && pixels(p, o));
      if (g) (byTile.get(g.code) ?? byTile.set(g.code, []).get(g.code)!).push(p);
      else if (order.some((o) => pixels(p, o))) complete = false;
    }
    const rows: Array<[number, string, number, number, number, string | null, string, number]> = [];
    for (const [code, mine] of byTile) {
      const grid = grids.get(code)!, scene = sceneOf.get(code)!;
      let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
      for (const p of mine) for (const [c, r] of pixels(p, grid)!) { c0 = Math.min(c0, c); c1 = Math.max(c1, c + 1); r0 = Math.min(r0, r); r1 = Math.max(r1, r + 1); }
      if (!Number.isFinite(c0)) continue;
      const wide = c1 - c0;
      const names = ["scl", ...BANDS];
      const read = await pool(names.map((b) => async () => {
        const asset = scene.assets[b];
        if (!asset) throw new Error(`a Sentinel-2 scene has no ${b} band`);
        const cog = await Cog.open(asset.href);
        const full = asset["proj:transform"]?.[0] ?? (b === "blue" || b === "green" || b === "red" || b === "nir" ? 10 : 20);
        return cog.window(await cog.level(full, PIXEL), c0, r0, c1, r1);
      }), 6);
      const layer = new Map(names.map((b, i) => [b, read[i]!]));
      const scl = layer.get("scl")!, red = layer.get("red")!;
      for (const p of mine) {
        const px = pixels(p, grid)!;
        const sum = BANDS.map(() => 0);
        let clear = 0, seen = 0;
        for (const [c, r] of px) {
          const i = (r - r0) * wide + (c - c0), cls = scl[i]!;
          if (cls === 0 || red[i] === 0) continue;
          seen++;
          if (!CLEAR.has(cls)) continue;
          clear++;
          BANDS.forEach((b, k) => { sum[k]! += layer.get(b)![i]!; });
        }
        const bands = clear ? JSON.stringify(Object.fromEntries(BANDS.map((b, k) => [b, Math.round((sum[k]! / clear) * 10) / 10]))) : null;
        rows.push([p.id, date, px.length, seen, clear, bands, scene.id, Date.now()]);
      }
    }
    db.transaction(() => {
      for (const r of rows) putBand.run(...r);
      putPass.run(date, JSON.stringify([...sceneOf.values()].map((it) => it.id)), complete ? 1 : 0, Date.now());
    })();
    done++;
  }

  progress = "working out the estimates";
  const estimates = await refreshEstimates();
  setSetting("sentinel_synced_on", today);
  if (estimates) changed?.();
  if (done) log.info(`${done} new Sentinel-2 pass(es) read; ${estimates} estimate(s) written or changed`);
  return { passes: done, estimates };
}

/* --------------------------------- model --------------------------------- */

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : NaN;
}
const ndviOf = (b: BandMeans) => (b.nir - b.red) / (b.nir + b.red);

/** What the regression sees for one paddock on one pass. `pg` is the paddock's low-point greenness. */
function featuresOf(b: BandMeans, pg: number): number[] {
  const r = BANDS.map((k) => b[k] / 10000);
  const [, green, red, rededge1, , , nir, nir08, swir16, swir22] = r as [number, number, number, number, number, number, number, number, number, number];
  const nd = (x: number, y: number) => (x - y) / (x + y);
  const ndvi = nd(nir, red), ndti = nd(swir16, swir22), bright = mean(r);
  const idx = [ndvi, ndti, nd(nir08, swir16), nd(nir, rededge1), nd(nir, green), bright, swir22 / swir16, red / green];
  const base = [...r, ...idx];
  return [...base, ...base.map((v) => v * v), pg, pg * ndvi, pg * ndti, ndvi * ndti, ndvi * bright];
}

interface Fit { lambda: number; ym: number; mu: number[]; sd: number[]; beta: number[]; medAE: number; r2: number }
export interface SentinelModel {
  version: string; trained_at: string; n: number; paddocks: number; from: string; to: string;
  pg: Record<string, number>; pgDefault: number; tsdm: Fit; green: Fit;
}

function ridge(X: number[][], y: number[], lambda: number): Omit<Fit, "lambda" | "medAE" | "r2"> {
  const n = X.length, p = X[0]!.length;
  const mu = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j]!)));
  const sd = Array.from({ length: p }, (_, j) => Math.sqrt(mean(X.map((r) => (r[j]! - mu[j]!) ** 2))) || 1);
  const ym = mean(y);
  const A = Array.from({ length: p }, () => new Float64Array(p + 1));
  const z = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const row = X[i]!, d = y[i]! - ym;
    for (let j = 0; j < p; j++) z[j] = (row[j]! - mu[j]!) / sd[j]!;
    for (let j = 0; j < p; j++) { const zj = z[j]!, a = A[j]!; for (let k = j; k < p; k++) a[k]! += zj * z[k]!; a[p]! += zj * d; }
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) A[j]![k] = A[k]![j]!; A[j]![j]! += lambda; }
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = c + 1; r < p; r++) { const f = A[r]![c]! / A[c]![c]!; if (f) for (let k = c; k <= p; k++) A[r]![k]! -= f * A[c]![k]!; }
  }
  const beta = new Array<number>(p).fill(0);
  for (let c = p - 1; c >= 0; c--) { let s = A[c]![p]!; for (let k = c + 1; k < p; k++) s -= A[c]![k]! * beta[k]!; beta[c] = s / A[c]![c]!; }
  return { ym, mu, sd, beta };
}
const predict = (f: Pick<Fit, "ym" | "mu" | "sd" | "beta">, x: number[]) => f.ym + x.reduce((s, v, j) => s + ((v - f.mu[j]!) / f.sd[j]!) * f.beta[j]!, 0);
const pause = () => new Promise<void>((res) => setImmediate(res));

/** Fits one target, choosing the penalty on held-out thirds and scoring on held-out tenths. */
async function fitTarget(X: number[][], y: number[]): Promise<Fit> {
  let best = { lambda: 1, e: Infinity };
  for (const lambda of [0.1, 1, 10, 100]) {
    let e = 0;
    for (let k = 0; k < 3; k++) {
      const f = ridge(X.filter((_, i) => i % 3 !== k), y.filter((_, i) => i % 3 !== k), lambda);
      X.forEach((x, i) => { if (i % 3 === k) e += Math.abs(predict(f, x) - y[i]!); });
      await pause();
    }
    if (e < best.e) best = { lambda, e };
  }
  const err: number[] = [];
  let ssr = 0;
  const fold = (i: number) => (i * 7919) % 10;
  for (let k = 0; k < 10; k++) {
    const f = ridge(X.filter((_, i) => fold(i) !== k), y.filter((_, i) => fold(i) !== k), best.lambda);
    X.forEach((x, i) => { if (fold(i) === k) { const d = predict(f, x) - y[i]!; err.push(Math.abs(d)); ssr += d * d; } });
    await pause();
  }
  const ym = mean(y), sst = y.reduce((s, v) => s + (v - ym) ** 2, 0);
  return { lambda: best.lambda, ...ridge(X, y, best.lambda), medAE: Math.round(median(err)), r2: Math.round((1 - ssr / sst) * 100) / 100 };
}

interface BandRow { feature_id: number; date: string; pixels: number; clear: number; bands: string }
function clearRows(): Array<{ id: number; date: string; clearPct: number; b: BandMeans }> {
  const rows = db.prepare(
    "SELECT feature_id, date, pixels, clear, bands FROM sentinel_bands WHERE bands IS NOT NULL AND pixels >= ? AND clear >= ? * pixels ORDER BY feature_id, date"
  ).all(MIN_PIXELS, CLEAR_SHARE) as BandRow[];
  return rows.map((r) => ({ id: r.feature_id, date: r.date, clearPct: Math.round((100 * r.clear) / r.pixels), b: JSON.parse(r.bands) as BandMeans }));
}

/** Each paddock's low-point greenness over its clear passes: a stand-in for tree cover. */
function persistentGreen(rows: ReturnType<typeof clearRows>): { pg: Record<string, number>; pgDefault: number } {
  const by = new Map<number, number[]>();
  for (const r of rows) (by.get(r.id) ?? by.set(r.id, []).get(r.id)!).push(ndviOf(r.b));
  const pg: Record<string, number> = {};
  for (const [id, v] of by) {
    if (v.length < 8) continue;
    const s = [...v].sort((a, b) => a - b);
    pg[String(id)] = s[Math.round(0.1 * (s.length - 1))]!;
  }
  const all = Object.values(pg);
  return { pg, pgDefault: all.length ? median(all) : 0.2 };
}

export function currentModel(): SentinelModel | null {
  try { return JSON.parse(getSetting("sentinel_model") ?? "null") as SentinelModel | null; } catch { return null; }
}

/** The passes PastureKey also reported with a clear capture: what the model is fitted on. */
function trainingRows(rows: ReturnType<typeof clearRows>) {
  const pk = new Map((db.prepare(
    "SELECT feature_id, date, tsdm_p50 AS tsdm, green FROM pasture_obs WHERE source = ? AND feature_id != 0 AND tsdm_p50 IS NOT NULL AND green IS NOT NULL AND (captured_pct IS NULL OR captured_pct >= 90)"
  ).all(PK) as Array<{ feature_id: number; date: string; tsdm: number; green: number }>).map((r) => [`${r.feature_id}|${r.date}`, r]));
  return rows.flatMap((r) => { const o = pk.get(`${r.id}|${r.date}`); return o ? [{ ...r, tsdm: o.tsdm, green: o.green }] : []; });
}

async function fitModel(rows: ReturnType<typeof clearRows>, train: ReturnType<typeof trainingRows>): Promise<SentinelModel> {
  const { pg, pgDefault } = persistentGreen(rows);
  const X = train.map((r) => featuresOf(r.b, pg[String(r.id)] ?? pgDefault));
  const tsdm = await fitTarget(X, train.map((r) => r.tsdm));
  const green = await fitTarget(X, train.map((r) => r.green));
  const dates = train.map((r) => r.date).sort();
  const m: SentinelModel = {
    version: `${localDate()} on ${train.length} readings`, trained_at: localDate(), n: train.length,
    paddocks: new Set(train.map((r) => r.id)).size, from: dates[0]!, to: dates[dates.length - 1]!, pg, pgDefault, tsdm, green,
  };
  setSetting("sentinel_model", JSON.stringify(m));
  addEvent({ ts: Date.now(), source: "pasture", kind: "action", severity: "info",
    message: `Satellite estimate fitted to ${train.length} PastureKey readings (${m.paddocks} paddocks, ${m.from} to ${m.to}): typically within ${tsdm.medAE} kg/ha of PastureKey`, value: null });
  log.info(`model fitted on ${train.length} readings: total ±${tsdm.medAE} kg/ha (R² ${tsdm.r2}), green ±${green.medAE} (R² ${green.r2})`);
  return m;
}

const round10 = (v: number) => Math.round(v / 10) * 10;

/**
 * Fits the model when there is none (or the PastureKey record it rests on has
 * changed), then writes an estimate for every clear pass. Each figure is the
 * average of the paddock's last three clear passes inside twelve days, which
 * steadies it the way PastureKey's own figures are steadied. Passes after a
 * paddock's last PastureKey reading also carry its own recent gap to
 * PastureKey (see OFFSET_DAYS); earlier ones are the plain model, so the two
 * can be compared honestly where they overlap. Returns how many rows were
 * written or changed.
 */
export async function refreshEstimates(refit = false): Promise<number> {
  const rows = clearRows();
  const train = trainingRows(rows);
  let model = currentModel();
  if (train.length >= MIN_TRAINING && (refit || !model || Math.abs(train.length - model.n) > 0.05 * model.n)) model = await fitModel(rows, train);
  if (!model) return 0;
  const fresh = persistentGreen(rows);
  const pgOf = (id: number) => model.pg[String(id)] ?? fresh.pg[String(id)] ?? model.pgDefault;

  const lastPk = new Map((db.prepare("SELECT feature_id, MAX(date) AS d FROM pasture_obs WHERE source = ? AND feature_id != 0 GROUP BY feature_id")
    .all(PK) as Array<{ feature_id: number; d: string }>).map((r) => [r.feature_id, r.d]));
  const trainBy = new Map<number, typeof train>();
  for (const r of train) (trainBy.get(r.id) ?? trainBy.set(r.id, []).get(r.id)!).push(r);

  const want = new Map<string, { id: number; date: string; tsdm: number; raw: number; green: number; clearPct: number; rate: number | null }>();
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j]!.id === rows[i]!.id) j++;
    const mine = rows.slice(i, j);
    const rawT = mine.map((r) => predict(model.tsdm, featuresOf(r.b, pgOf(r.id))));
    const rawG = mine.map((r) => predict(model.green, featuresOf(r.b, pgOf(r.id))));
    // The paddock's own recent gap to PastureKey, pulled towards zero when few readings back it.
    const id = mine[0]!.id, end = lastPk.get(id) ?? null;
    const recent = end ? (trainBy.get(id) ?? []).filter((r) => dayGap(r.date, end) <= OFFSET_DAYS) : [];
    const gapTo = (f: Fit, key: "tsdm" | "green") => (recent.length
      ? (mean(recent.map((r) => r[key] - predict(f, featuresOf(r.b, pgOf(id))))) * recent.length) / (recent.length + 3) : 0);
    const offT = gapTo(model.tsdm, "tsdm"), offG = gapTo(model.green, "green");
    const fade = (date: string) => (end ? Math.min(1, 0.5 ** (dayGap(end, date) / OFFSET_HALF_LIFE)) : 0);
    const steady: number[] = [];
    mine.forEach((r, k) => {
      const after = end !== null && r.date > end;
      const tOf = (q: number) => rawT[q]! + (after ? offT * fade(mine[q]!.date) : 0);
      const gOf = (q: number) => rawG[q]! + (after ? offG * fade(mine[q]!.date) : 0);
      const use = [k - 2, k - 1, k].filter((q) => q >= 0 && dayGap(mine[q]!.date, r.date) <= 12);
      const t = Math.max(0, round10(mean(use.map(tOf))));
      const g = Math.min(t, Math.max(0, round10(mean(use.map(gOf)))));
      steady.push(t);
      // The daily change, against the paddock's figure ten days to five weeks earlier.
      let rate: number | null = null;
      for (let q = k - 1; q >= 0; q--) {
        const gap = dayGap(mine[q]!.date, r.date);
        if (gap > 35) break;
        if (gap >= 10) { rate = Math.round(((t - steady[q]!) / gap) * 10) / 10; break; }
      }
      want.set(`${r.id}|${r.date}`, { id: r.id, date: r.date, tsdm: t, raw: Math.max(0, Math.round(tOf(k))), green: g, clearPct: r.clearPct, rate });
    });
    i = j;
  }

  const have = new Map((db.prepare(
    "SELECT id, feature_id, date, tsdm_p50, tsdm_mean, green, change_rate, tsdm_error FROM pasture_obs WHERE source = ?"
  ).all(SAT) as Array<{ id: number; feature_id: number; date: string; tsdm_p50: number; tsdm_mean: number; green: number; change_rate: number | null; tsdm_error: number | null }>)
    .map((r) => [`${r.feature_id}|${r.date}`, r]));
  const put = db.prepare(`INSERT INTO pasture_obs (feature_id, date, source, tsdm_mean, tsdm_p50, tsdm_error, change_rate, captured_pct, green, import_file, created_at, updated_at)
    VALUES (@id, @date, '${SAT}', @raw, @tsdm, @error, @rate, @clearPct, @green, @version, @now, @now)
    ON CONFLICT(feature_id, date, source) DO UPDATE SET tsdm_mean = excluded.tsdm_mean, tsdm_p50 = excluded.tsdm_p50, tsdm_error = excluded.tsdm_error,
      change_rate = excluded.change_rate, captured_pct = excluded.captured_pct, green = excluded.green, import_file = excluded.import_file, updated_at = excluded.updated_at`);
  const drop = db.prepare("DELETE FROM pasture_obs WHERE id = ?");
  let changed = 0;
  const now = Date.now(), error = model.tsdm.medAE, version = model.version;
  db.transaction(() => {
    for (const [k, v] of want) {
      const h = have.get(k);
      if (h && h.tsdm_p50 === v.tsdm && h.tsdm_mean === v.raw && h.green === v.green && h.change_rate === v.rate && h.tsdm_error === error) continue;
      put.run({ ...v, error, version, now });
      changed++;
    }
    for (const [k, h] of have) if (!want.has(k)) { drop.run(h.id); changed++; }
  })();
  return changed;
}

/* ------------------------------- for the app ------------------------------ */

/** Whether the pasture model and the rotation planner start from the estimate where it is newer than PastureKey. */
export function satelliteInUse(): boolean { return getSetting("sentinel_use") !== "0"; }

/** Changes whenever the estimates the model would use change: part of the model's cache keys. */
export function satelliteStamp(): string {
  if (!satelliteInUse()) return "off";
  const r = db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM pasture_obs WHERE source = ?").get(SAT) as { n: number; t: number | null };
  return `${r.n}:${r.t ?? 0}`;
}

let changed: (() => void) | null = null;
/** Called after a background check has changed the estimates, so the plan is worked out again. */
export function onEstimatesChanged(fn: () => void): void { changed = fn; }

export interface SatelliteReading { date: string; tsdm: number; raw: number | null; green: number | null; change_rate: number | null; captured_pct: number | null; error: number | null }

/** Every satellite estimate for one paddock, oldest first. */
export function satelliteSeries(featureId: number): SatelliteReading[] {
  return db.prepare(
    "SELECT date, tsdm_p50 AS tsdm, tsdm_mean AS raw, green, change_rate, captured_pct, tsdm_error AS error FROM pasture_obs WHERE feature_id = ? AND source = ? ORDER BY date"
  ).all(featureId, SAT) as SatelliteReading[];
}

export interface SentinelStatus {
  enabled: boolean; in_use: boolean; running: boolean; progress: string | null; error: string | null;
  checked_on: string | null; passes: number; last_pass: string | null;
  estimates: number; paddocks: number; last_estimate: string | null; last_pasturekey: string | null;
  model: { version: string; trained_at: string; n: number; paddocks: number; from: string; to: string; tsdm_error: number; tsdm_r2: number; green_error: number; green_r2: number } | null;
}

export function sentinelStatus(): SentinelStatus {
  const p = db.prepare("SELECT COUNT(*) AS n, MAX(date) AS d FROM sentinel_passes").get() as { n: number; d: string | null };
  const e = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT feature_id) AS f, MAX(date) AS d FROM pasture_obs WHERE source = ?").get(SAT) as { n: number; f: number; d: string | null };
  const pk = db.prepare("SELECT MAX(date) AS d FROM pasture_obs WHERE source = ? AND feature_id != 0").get(PK) as { d: string | null };
  const m = currentModel();
  return {
    enabled: config.sentinelSync, in_use: satelliteInUse(), running: running !== null, progress, error: lastError,
    checked_on: getSetting("sentinel_synced_on"), passes: p.n, last_pass: p.d,
    estimates: e.n, paddocks: e.f, last_estimate: e.d, last_pasturekey: pk.d,
    model: m ? { version: m.version, trained_at: m.trained_at, n: m.n, paddocks: m.paddocks, from: m.from, to: m.to,
      tsdm_error: m.tsdm.medAE, tsdm_r2: m.tsdm.r2, green_error: m.green.medAE, green_r2: m.green.r2 } : null,
  };
}

/** Checks for new passes once a day, after the hour set; the first run fetches the whole record. */
export function startSentinelSync(): NodeJS.Timeout {
  const due = () => config.sentinelSync && getSetting("sentinel_synced_on") !== localDate();
  const run = () => syncSentinel().catch((e) => log.error(`Sentinel-2 check failed: ${String(e)}`));
  setTimeout(() => { if (due()) void run(); }, 45_000).unref();
  const t = setInterval(() => {
    if (new Date().getHours() >= config.sentinelHour && due()) void run();
  }, 30 * 60_000);
  t.unref();
  return t;
}
