import express, { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import { KINDS } from "../map/kinds.js";
import { GeometryError } from "../map/geometry.js";
import { exportGeoJson, exportKml } from "../map/export.js";
import { ImportError, parseMapFile, type Candidate } from "../map/importers.js";
import {
  ConflictError, createFeature, createFeatures, deleteFeature, getFeature, listDeleted,
  listFeatures, listRevisions, NotFoundError, restoreFeature, splitFeature, toFeature,
  updateFeature, type FeatureInput,
} from "../map/store.js";
import { TILE_SOURCES } from "../tiles/proxy.js";
import { backupTo, listBackups } from "../db/backup.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

const log = logger("map");
export const mapApi = Router();

mapApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;

/** Maps the store's errors onto status codes, so each route stays short. */
function fail(res: Response, e: unknown) {
  if (e instanceof GeometryError || e instanceof ImportError) {
    res.status(400).json({ error: e.message });
  } else if (e instanceof ConflictError) {
    res.status(409).json({ error: e.message });
  } else if (e instanceof NotFoundError) {
    res.status(404).json({ error: e.message });
  } else {
    log.error("request failed", e);
    res.status(500).json({ error: "Something went wrong on the server" });
  }
}

function idParam(req: Request): number | null {
  const id = Number(req.params["id"]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* ---------------------------------- meta --------------------------------- */

/** Everything the map page needs before it can draw: kinds, imagery, where to look. */
mapApi.get("/meta", (req, res) => {
  res.json({
    propertyName: config.propertyName,
    mapCentre: config.mapCentre,
    mapZoom: config.mapZoom,
    kinds: KINDS,
    tileSources: TILE_SOURCES.map(({ id, label, maxZoom, attribution, cache }) => ({
      id, label, maxZoom, attribution, cache,
    })),
    user: req.user ?? null,
    canEdit: !config.requireAuth || req.user?.role === "admin",
  });
});

/* -------------------------------- features ------------------------------- */

mapApi.get("/features", (_req, res) => {
  res.json({ type: "FeatureCollection", features: listFeatures().map(toFeature) });
});

mapApi.get("/features/deleted", (_req, res) => {
  res.json(listDeleted().map((r) => ({
    id: r.id, kind: r.kind, name: r.name, area_ha: r.area_ha, deleted_at: r.deleted_at,
  })));
});

mapApi.get("/features/:id/history", (req, res) => {
  const id = idParam(req);
  if (!id || !getFeature(id)) { res.status(404).json({ error: "No such feature" }); return; }
  res.json(listRevisions(id));
});

function inputFrom(body: unknown): FeatureInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    kind: String(b["kind"] ?? ""),
    name: typeof b["name"] === "string" ? b["name"] : "",
    subtype: typeof b["subtype"] === "string" ? b["subtype"] : null,
    props: (b["props"] as Record<string, unknown> | undefined) ?? {},
    geometry: b["geometry"],
  };
}

mapApi.post("/features", requireAdmin, (req, res) => {
  try {
    const id = createFeature(inputFrom(req.body), "drawn", who(req));
    res.json(toFeature(getFeature(id)!));
  } catch (e) { fail(res, e); }
});

mapApi.put("/features/:id", requireAdmin, (req, res) => {
  const id = idParam(req);
  const rev = Number((req.body as { rev?: unknown })?.rev);
  if (!id || !Number.isInteger(rev)) { res.status(400).json({ error: "Bad request" }); return; }
  try {
    res.json(toFeature(updateFeature(id, inputFrom(req.body), rev, who(req))));
  } catch (e) { fail(res, e); }
});

mapApi.delete("/features/:id", requireAdmin, (req, res) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Bad request" }); return; }
  try {
    const f = getFeature(id);
    deleteFeature(id, who(req));
    log.info(`${who(req)} deleted ${f?.kind} "${f?.name}" (#${id})`);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

mapApi.post("/features/:id/restore", requireAdmin, (req, res) => {
  const id = idParam(req);
  if (!id) { res.status(400).json({ error: "Bad request" }); return; }
  try {
    restoreFeature(id, who(req));
    res.json(toFeature(getFeature(id)!));
  } catch (e) { fail(res, e); }
});

mapApi.post("/features/:id/split", requireAdmin, (req, res) => {
  const id = idParam(req);
  const b = (req.body ?? {}) as { geometry?: unknown; name?: unknown; rev?: unknown };
  const rev = Number(b.rev);
  if (!id || !Number.isInteger(rev)) { res.status(400).json({ error: "Bad request" }); return; }
  try {
    const { parent, child } = splitFeature(
      id, b.geometry, typeof b.name === "string" ? b.name : "", rev, who(req)
    );
    log.info(`${who(req)} split "${parent.name}" — new paddock "${child.name}" ${child.area_ha} ha`);
    res.json({ parent: toFeature(parent), child: toFeature(child) });
  } catch (e) { fail(res, e); }
});

/* --------------------------------- import -------------------------------- */

interface ImportRow {
  id: number;
  filename: string;
  format: string;
  status: string;
  payload: string;
}

/**
 * Upload and parse a map file. Nothing is added to the map yet — the parsed
 * shapes are stored against an import id and sent back for review.
 */
mapApi.post(
  "/import/preview",
  requireAdmin,
  express.raw({ type: () => true, limit: "40mb" }),
  async (req, res) => {
    const filename = String(req.headers["x-filename"] ?? "").slice(0, 200);
    if (!filename || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No file received" });
      return;
    }
    try {
      const parsed = await parseMapFile(decodeURIComponent(filename), req.body);

      // Flag shapes that are already on the map, so importing the same export
      // twice — or a newer one after changes here — does not double everything.
      const existing = listFeatures();
      const byAgriWebb = new Map<string, number>();
      const byName = new Map<string, number>();
      for (const f of existing) {
        const p = JSON.parse(f.props) as Record<string, unknown>;
        if (typeof p["agriwebb_id"] === "string") byAgriWebb.set(p["agriwebb_id"], f.id);
        if (f.name) byName.set(`${f.kind}|${f.name.toLowerCase()}`, f.id);
      }
      const matches: Record<number, number> = {};
      for (const c of parsed.candidates) {
        const aw = typeof c.props["agriwebb_id"] === "string" ? byAgriWebb.get(c.props["agriwebb_id"]) : undefined;
        const m = aw ?? (c.name ? byName.get(`${c.kind}|${c.name.toLowerCase()}`) : undefined);
        if (m !== undefined) matches[c.i] = m;
      }

      // Old previews nobody acted on are just clutter.
      db.prepare("DELETE FROM imports WHERE status = 'preview' AND ts < ?").run(Date.now() - 86_400_000);

      const r = db.prepare(`
        INSERT INTO imports (ts, username, filename, format, status, payload)
        VALUES (?, ?, ?, ?, 'preview', ?)
      `).run(Date.now(), who(req), filename, parsed.format, JSON.stringify(parsed.candidates));

      res.json({
        importId: Number(r.lastInsertRowid),
        format: parsed.format,
        candidates: parsed.candidates,
        rejected: parsed.rejected,
        matches,
      });
    } catch (e) { fail(res, e); }
  }
);

/**
 * Adds the reviewed shapes to the map. The browser sends back only its
 * decisions — which to include, and any corrected kind, subtype or name — and
 * the shapes themselves come from the stored preview.
 */
mapApi.post("/import/:id/commit", requireAdmin, (req, res) => {
  const id = idParam(req);
  const row = id
    ? (db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as ImportRow | undefined)
    : undefined;
  if (!row || row.status !== "preview") {
    res.status(404).json({ error: "That import has expired or was already used. Upload the file again." });
    return;
  }

  const decisions = (req.body as { items?: unknown })?.items;
  if (!Array.isArray(decisions)) { res.status(400).json({ error: "Bad request" }); return; }

  const candidates = JSON.parse(row.payload) as Candidate[];
  const byIndex = new Map(candidates.map((c) => [c.i, c]));

  const inputs: FeatureInput[] = [];
  for (const d of decisions as Array<Record<string, unknown>>) {
    const c = byIndex.get(Number(d["i"]));
    if (!c) continue;
    inputs.push({
      kind: typeof d["kind"] === "string" ? d["kind"] : c.kind,
      name: typeof d["name"] === "string" ? d["name"] : c.name,
      subtype: typeof d["subtype"] === "string" ? d["subtype"] : c.subtype,
      props: { ...c.props, imported_from: row.filename },
      geometry: c.geometry,
    });
  }
  if (inputs.length === 0) { res.status(400).json({ error: "Nothing was selected to import" }); return; }

  try {
    const ids = createFeatures(inputs, `import:${row.id}`, who(req));
    db.prepare(
      "UPDATE imports SET status = 'committed', committed_at = ?, created_ids = ? WHERE id = ?"
    ).run(Date.now(), JSON.stringify(ids), row.id);
    addEvent({
      ts: Date.now(), source: "map", kind: "import", severity: "info",
      message: `${who(req)} imported ${ids.length} shapes from ${row.filename}`, value: null,
    });
    log.info(`${who(req)} imported ${ids.length} shapes from ${row.filename}`);
    res.json({ ok: true, created: ids.length });
  } catch (e) { fail(res, e); }
});

/* --------------------------------- export -------------------------------- */

const stamp = () => new Date().toISOString().slice(0, 10);
const fileBase = () => config.propertyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

mapApi.get("/export/map.geojson", (_req, res) => {
  res.setHeader("Content-Type", "application/geo+json");
  res.setHeader("Content-Disposition", `attachment; filename="${fileBase()}-map-${stamp()}.geojson"`);
  res.send(JSON.stringify(exportGeoJson(), null, 1));
});

mapApi.get("/export/map.kml", (_req, res) => {
  res.setHeader("Content-Type", "application/vnd.google-earth.kml+xml");
  res.setHeader("Content-Disposition", `attachment; filename="${fileBase()}-map-${stamp()}.kml"`);
  res.send(exportKml(config.propertyName));
});

/* --------------------------------- backup -------------------------------- */

mapApi.get("/backups", requireAdmin, (_req, res) => {
  res.json(listBackups());
});

/** A copy of the whole database, made now, to keep somewhere off the server. */
mapApi.get("/backup/download", requireAdmin, async (_req, res) => {
  const tmp = join(tmpdir(), `grazing-download-${process.pid}-${Date.now()}.db`);
  try {
    await backupTo(tmp);
    res.download(tmp, `${fileBase()}-grazing-${stamp()}.db`, () => { void unlink(tmp).catch(() => {}); });
  } catch (e) {
    log.error("backup download failed", e);
    void unlink(tmp).catch(() => {});
    res.status(500).json({ error: "Could not make a backup" });
  }
});
