// Feasibility test: can free Sentinel-2 imagery reproduce the PastureKey
// paddock figures already held in the app?
//
//   node dev/sentinel-test.mjs fetch [maxDates]   pull paddock band averages (cached)
//   node dev/sentinel-test.mjs analyse            fit and score against PastureKey
//
// Reads the LOCAL test database only (read-only). Imagery comes from the public
// Sentinel-2 archive on AWS (Element 84 "Earth Search"); only the search box,
// rounded out to 0.1 degree, is sent. Nothing but paddock averages is kept.
//
// No extra libraries: the small GeoTIFF reader below handles exactly what the
// Sentinel-2 cloud-optimised files use (tiled, deflate, 8/16-bit).

import Database from "better-sqlite3";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const DB = process.env.GRAZING_DB ?? "data/grazing.db";
const OUT = process.env.SENTINEL_OUT ?? "C:/Projects/grazing-files/Sentinel";
const CACHE = path.join(OUT, "cache");
const STAC = "https://earth-search.aws.element84.com/v1/search";
const PK = "cibo-pasturekey";
const PIXEL = 40; // metres: an overview level every band has
export const BANDS = ["blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08", "swir16", "swir22"];
const CLEAR = new Set([4, 5, 6, 7]); // scene classes: vegetation, bare, water, unclassified

// ---------- map maths: longitude/latitude to UTM (WGS84, southern hemisphere) ----------
export function toUtm(lon, lat, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const phi = (lat * Math.PI) / 180, lam = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const c = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + k0 * A * E, 10000000 + k0 * A * N];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((r) => inRing(x, y, r));

// ---------- fetching ----------
async function get(url, init, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      if (i >= tries || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
}
let bytesFetched = 0;
async function range(url, start, length) {
  const r = await get(url, { headers: { range: `bytes=${start}-${start + length - 1}` } });
  const b = Buffer.from(await r.arrayBuffer());
  bytesFetched += b.length;
  return b;
}
async function pool(jobs, size = 8) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

// ---------- minimal cloud-optimised GeoTIFF reader ----------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8, 16: 8 };
class Cog {
  static async open(url) {
    const c = new Cog();
    c.url = url;
    c.head = await range(url, 0, 65536);
    const h = c.head;
    if (h.toString("latin1", 0, 2) !== "II" || h.readUInt16LE(2) !== 42) throw new Error(`not a little-endian classic TIFF: ${url}`);
    c.ifds = [];
    let off = h.readUInt32LE(4);
    while (off) {
      const buf = await c.bytes(off, 2);
      const count = buf.readUInt16LE(0);
      const body = await c.bytes(off + 2, count * 12 + 4);
      const tags = {};
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
  async bytes(at, len) {
    if (at + len <= this.head.length) return this.head.subarray(at, at + len);
    return range(this.url, at, len);
  }
  async values(ifd, tag) {
    const t = this.ifds[ifd][tag];
    if (!t) return null;
    const b = t.inline ?? (await this.bytes(t.at, t.size));
    const out = [];
    for (let i = 0; i < t.n; i++) {
      if (t.type === 3) out.push(b.readUInt16LE(i * 2));
      else if (t.type === 4) out.push(b.readUInt32LE(i * 4));
      else if (t.type === 12) out.push(b.readDoubleLE(i * 8));
      else if (t.type === 16) out.push(Number(b.readBigUInt64LE(i * 8)));
      else out.push(b[i]);
    }
    return out;
  }
  async one(ifd, tag, fallback) { const v = await this.values(ifd, tag); return v ? v[0] : fallback; }

  /** Georeferencing of the full-resolution image: [originX, originY, pixelSize]. */
  async geo() {
    const scale = await this.values(0, 33550), tie = await this.values(0, 33922);
    return { x0: tie[3], y0: tie[4], px: scale[0], width: await this.one(0, 256), height: await this.one(0, 257) };
  }
  /** Index of the image level whose pixels are `metres` across. */
  async level(metres) {
    const g = await this.geo();
    for (let i = 0; i < this.ifds.length; i++) {
      const w = await this.one(i, 256);
      if (Math.abs((g.px * g.width) / w - metres) < 0.5) return i;
    }
    throw new Error(`no ${metres} m level in ${this.url}`);
  }
  /** Pixels col0..col1-1, row0..row1-1 of one level, as a typed array (0 = no data). */
  async window(ifd, col0, row0, col1, row1) {
    const W = await this.one(ifd, 256), H = await this.one(ifd, 257);
    const tw = await this.one(ifd, 322), th = await this.one(ifd, 323);
    const bits = await this.one(ifd, 258), comp = await this.one(ifd, 259, 1), pred = await this.one(ifd, 317, 1);
    if (!tw) throw new Error("image is not tiled");
    const offs = await this.values(ifd, 324), counts = await this.values(ifd, 325);
    const across = Math.ceil(W / tw);
    const Arr = bits === 8 ? Uint8Array : Uint16Array, bps = bits / 8;
    const w = col1 - col0, h = row1 - row0, out = new Arr(w * h);
    const jobs = [];
    for (let ty = Math.floor(Math.max(0, row0) / th); ty * th < Math.min(H, row1); ty++) {
      for (let tx = Math.floor(Math.max(0, col0) / tw); tx * tw < Math.min(W, col1); tx++) {
        jobs.push(async () => {
          const i = ty * across + tx;
          if (!counts[i]) return;
          let raw = await range(this.url, offs[i], counts[i]);
          if (comp === 8 || comp === 32946) raw = zlib.inflateSync(raw);
          else if (comp === 50000) raw = zlib.zstdDecompressSync(raw);
          else if (comp !== 1) throw new Error(`compression ${comp} not handled`);
          const tile = new Arr(raw.buffer, raw.byteOffset, (tw * th * bps) / bps);
          if (pred === 2) for (let r = 0; r < th; r++) for (let c = 1; c < tw; c++) tile[r * tw + c] += tile[r * tw + c - 1];
          else if (pred !== 1) throw new Error(`predictor ${pred} not handled`);
          for (let r = Math.max(row0, ty * th); r < Math.min(row1, (ty + 1) * th, H); r++) {
            for (let c = Math.max(col0, tx * tw); c < Math.min(col1, (tx + 1) * tw, W); c++) {
              out[(r - row0) * w + (c - col0)] = tile[(r - ty * th) * tw + (c - tx * tw)];
            }
          }
        });
      }
    }
    await pool(jobs, 4);
    return out;
  }
}

// ---------- the property ----------
function loadPaddocks() {
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  const ids = db.prepare("SELECT DISTINCT feature_id AS f FROM pasture_obs WHERE source = ?").all(PK).map((r) => r.f);
  const rows = db.prepare(`SELECT id, name, area_ha, geometry FROM features WHERE id IN (${ids.join(",")})`).all();
  const obs = db.prepare("SELECT feature_id AS id, date, tsdm_p50 AS tsdm, green, captured_pct AS captured, tsdm_error AS error FROM pasture_obs WHERE source = ? ORDER BY date").all(PK);
  db.close();
  const paddocks = rows.map((r) => {
    const g = JSON.parse(r.geometry);
    const lonlat = g.coordinates;
    const zone = Math.floor((lonlat[0][0][0] + 180) / 6) + 1;
    return { id: r.id, name: r.name, area_ha: r.area_ha, zone, lonlat, rings: lonlat.map((ring) => ring.map(([x, y]) => toUtm(x, y, zone))) };
  });
  return { paddocks, obs };
}

/** For one tile grid, the pixels whose centres fall inside each paddock. */
function pixelsFor(paddock, grid) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of paddock.rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const c0 = Math.floor((x0 - grid.x0) / PIXEL), c1 = Math.ceil((x1 - grid.x0) / PIXEL);
  const r0 = Math.floor((grid.y0 - y1) / PIXEL), r1 = Math.ceil((grid.y0 - y0) / PIXEL);
  if (c0 < 0 || r0 < 0 || c1 > grid.size || r1 > grid.size) return null; // not wholly on this tile
  const px = [];
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    if (inPolygon(grid.x0 + (c + 0.5) * PIXEL, grid.y0 - (r + 0.5) * PIXEL, paddock.rings)) px.push([c, r]);
  }
  return px;
}

async function search(bbox, from, to) {
  const items = [];
  let body = { collections: ["sentinel-2-l2a"], bbox, datetime: `${from}T00:00:00Z/${to}T23:59:59Z`, limit: 200 };
  for (;;) {
    const j = await (await get(STAC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    items.push(...j.features);
    const next = (j.links ?? []).find((l) => l.rel === "next");
    if (!next || !j.features.length) break;
    body = next.body;
  }
  return items;
}

async function fetchAll(maxDates) {
  fs.mkdirSync(CACHE, { recursive: true });
  const { paddocks, obs } = loadPaddocks();
  const dates = [...new Set(obs.map((o) => o.date))].sort();
  let w = 180, e = -180, s = 90, n = -90;
  for (const p of paddocks) for (const [x, y] of p.lonlat[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const bbox = [Math.floor(w * 10) / 10, Math.floor(s * 10) / 10, Math.ceil(e * 10) / 10, Math.ceil(n * 10) / 10];
  console.log(`${paddocks.length} paddocks, ${dates.length} PastureKey dates ${dates[0]} to ${dates.at(-1)}`);
  const items = await search(bbox, dates[0], dates.at(-1));
  console.log(`${items.length} Sentinel-2 scenes found`);

  // Tile grids, and which tile serves each paddock (fewest tiles wins).
  const grids = new Map();
  for (const it of items) {
    const code = it.properties["grid:code"];
    if (grids.has(code)) continue;
    const t = it.assets.red["proj:transform"];
    grids.set(code, { code, x0: t[2], y0: t[5], size: Math.round((it.assets.red["proj:shape"][0] * t[0]) / PIXEL), zone: Number(String(it.properties["proj:epsg"] ?? it.properties["proj:code"]).slice(-2)) });
  }
  for (const g of grids.values()) g.pixels = new Map(paddocks.map((p) => [p.id, p.zone === g.zone ? pixelsFor(p, g) : null]));
  const order = [...grids.values()].sort((a, b) => count(b) - count(a));
  function count(g) { return [...g.pixels.values()].filter(Boolean).length; }
  const tileOf = new Map(paddocks.map((p) => [p.id, order.find((g) => g.pixels.get(p.id))?.code]));
  const used = [...new Set(tileOf.values())];
  console.log(`tiles: ${order.map((g) => `${g.code} holds ${count(g)}`).join(", ")}; using ${used.join(", ")}`);
  if (used.includes(undefined)) throw new Error("a paddock straddles tiles; not handled");

  let done = 0;
  for (const date of dates.slice(0, maxDates ?? dates.length)) {
    const file = path.join(CACHE, `${date}.json`);
    if (fs.existsSync(file)) { done++; continue; }
    const result = { date, scenes: [], paddocks: {} };
    for (const code of used) {
      const scene = items.filter((it) => it.properties["grid:code"] === code && it.properties.datetime.slice(0, 10) === date)
        .sort((a, b) => (b.properties.updated ?? "").localeCompare(a.properties.updated ?? ""))[0];
      if (!scene) continue;
      const grid = grids.get(code);
      const mine = paddocks.filter((p) => tileOf.get(p.id) === code);
      let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
      for (const p of mine) for (const [c, r] of grid.pixels.get(p.id)) { c0 = Math.min(c0, c); c1 = Math.max(c1, c + 1); r0 = Math.min(r0, r); r1 = Math.max(r1, r + 1); }
      const wide = c1 - c0;
      const layers = Object.fromEntries(await pool(["scl", ...BANDS].map((b) => async () => {
        const cog = await Cog.open(scene.assets[b].href);
        return [b, await cog.window(await cog.level(PIXEL), c0, r0, c1, r1)];
      }), 6));
      result.scenes.push({ id: scene.id, cloud: scene.properties["eo:cloud_cover"], boa_offset_applied: scene.properties["earthsearch:boa_offset_applied"], baseline: scene.properties["s2:processing_baseline"] });
      for (const p of mine) {
        const px = grid.pixels.get(p.id);
        const sum = Object.fromEntries(BANDS.map((b) => [b, 0]));
        let clear = 0, seen = 0;
        for (const [c, r] of px) {
          const i = (r - r0) * wide + (c - c0), cls = layers.scl[i];
          if (cls === 0 || layers.red[i] === 0) continue;
          seen++;
          if (!CLEAR.has(cls)) continue;
          clear++;
          for (const b of BANDS) sum[b] += layers[b][i];
        }
        result.paddocks[p.id] = { pixels: px.length, seen, clear, bands: clear ? Object.fromEntries(BANDS.map((b) => [b, Math.round((sum[b] / clear) * 10) / 10])) : null };
      }
    }
    fs.writeFileSync(file, JSON.stringify(result));
    done++;
    const got = Object.values(result.paddocks);
    console.log(`${date}  scenes ${result.scenes.length}  paddocks with clear view ${got.filter((p) => p.clear > 0.9 * p.pixels).length}/${got.length}  (${(bytesFetched / 1e6).toFixed(0)} MB so far)`);
  }
  console.log(`done: ${done} dates cached in ${CACHE}`);
}

const cmd = process.argv[2];
if (cmd === "fetch") await fetchAll(process.argv[3] ? Number(process.argv[3]) : undefined);
else if (cmd === "analyse") await (await import("./sentinel-analyse.mjs")).analyse({ loadPaddocks, CACHE, OUT, BANDS });
else if (cmd === "check") {
  // Self-check of the map maths against a scene's own corner coordinates.
  const [it] = await search([148.0, -24.6, 148.1, -24.5], "2026-09-06", "2026-09-06");
  const t = it.assets.red["proj:transform"];
  console.log(it.id, "tile origin", t[2], t[5], "bbox", it.bbox);
  const ring = it.geometry.coordinates[0];
  for (const [lon, lat] of ring.slice(0, 4)) console.log(lon, lat, "->", toUtm(lon, lat, 55).map((v) => v.toFixed(1)).join(", "));
} else console.log("usage: node dev/sentinel-test.mjs fetch|analyse|check");
