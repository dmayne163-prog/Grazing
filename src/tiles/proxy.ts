/**
 * Imagery tiles, fetched through this server.
 *
 * Two reasons not to let the browser fetch them directly. The page's
 * Content-Security-Policy stays same-origin only, with no imagery host to
 * allowlist. And tiles from the Queensland Government service are kept on disk,
 * so the map still draws on the property's LAN when the internet is down —
 * which, for a map used to record where the cattle went, is when it matters.
 *
 * Only sources whose licence allows keeping copies are cached. QLD imagery is
 * CC-BY 4.0. Esri World Imagery is passed through untouched; its terms do not
 * allow building an offline copy.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

const log = logger("tiles");

export interface TileSource {
  id: string;
  label: string;
  /** {z}/{y}/{x} — ArcGIS order, row before column. */
  url: string;
  maxZoom: number;
  attribution: string;
  /** Whether copies may be kept on disk and in the phone's offline cache. */
  cache: boolean;
}

export const TILE_SOURCES: TileSource[] = [
  {
    id: "qld",
    label: "QLD aerial",
    url: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}",
    maxZoom: 20,
    attribution: "Imagery © State of Queensland (Department of Resources), CC-BY 4.0",
    cache: true,
  },
  {
    id: "esri",
    label: "Esri satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    cache: false,
  },
];

const BY_ID = new Map(TILE_SOURCES.map((s) => [s.id, s]));

const tileRoot = join(config.dataDir, "tiles");
const maxAgeMs = config.tileMaxAgeDays > 0 ? config.tileMaxAgeDays * 86_400_000 : Infinity;

/* ------------------------------- fetching -------------------------------- */

/** Upstream fetches at once. A map pan asks for dozens; the servers are public and shared. */
const MAX_CONCURRENT = 6;
let active = 0;
const queue: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** One upstream request per tile, however many viewers ask for it at once. */
const inFlight = new Map<string, Promise<Buffer | null>>();

async function fetchUpstream(src: TileSource, z: number, x: number, y: number): Promise<Buffer | null> {
  const url = src.url.replace("{z}", String(z)).replace("{y}", String(y)).replace("{x}", String(x));
  return slot(async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "wealwandangie-grazing/0.1 (farm map tile cache)" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${src.id} ${z}/${x}/${y}: HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    // ArcGIS answers some out-of-coverage requests with a 200 and a JSON error.
    if (!type.startsWith("image/")) return null;
    return Buffer.from(await res.arrayBuffer());
  });
}

function sniffType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  return "image/jpeg";
}

async function readCached(file: string): Promise<{ buf: Buffer; fresh: boolean } | null> {
  try {
    const st = await stat(file);
    const buf = await readFile(file);
    return { buf, fresh: Date.now() - st.mtimeMs < maxAgeMs };
  } catch {
    return null;
  }
}

async function writeCached(file: string, buf: Buffer) {
  await mkdir(join(file, ".."), { recursive: true });
  // Written aside and renamed, so a reader never sees half a tile.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

async function getTile(src: TileSource, z: number, x: number, y: number): Promise<Buffer | null> {
  const file = join(tileRoot, src.id, String(z), String(x), String(y));
  const cached = src.cache ? await readCached(file) : null;
  if (cached?.fresh) return cached.buf;

  const key = `${src.id}/${z}/${x}/${y}`;
  let p = inFlight.get(key);
  if (!p) {
    p = fetchUpstream(src, z, x, y).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }

  try {
    const buf = await p;
    if (buf && src.cache) {
      await writeCached(file, buf).catch((e) => log.warn(`could not cache ${key}: ${String(e)}`));
    }
    return buf;
  } catch (e) {
    // Offline, or the service is down: an old tile beats a grey square.
    if (cached) return cached.buf;
    throw e;
  }
}

/* --------------------------------- route --------------------------------- */

export const tiles = Router();

tiles.get("/:src/:z/:x/:y", async (req, res) => {
  const src = BY_ID.get(req.params["src"] ?? "");
  const z = Number(req.params["z"]);
  const x = Number(req.params["x"]);
  const y = Number(String(req.params["y"]).replace(/\.\w+$/, ""));

  if (!src || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    res.status(404).end();
    return;
  }
  const n = 2 ** z;
  if (z < 0 || z > src.maxZoom || x < 0 || y < 0 || x >= n || y >= n) {
    res.status(404).end();
    return;
  }

  try {
    const buf = await getTile(src, z, x, y);
    if (!buf) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", sniffType(buf));
    // Private: the tiles are public imagery, but they are served behind the
    // login, and a shared cache has no business holding them. Uncacheable
    // sources are not kept by the browser either, beyond the page it is on.
    res.setHeader(
      "Cache-Control",
      src.cache ? "private, max-age=2592000" : "private, max-age=3600"
    );
    res.end(buf);
  } catch (e) {
    log.debug(`tile failed: ${String(e)}`);
    res.status(502).end();
  }
});
