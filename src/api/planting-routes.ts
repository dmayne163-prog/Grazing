/** Plantings on the cultivation paddocks: list, record, change and remove. */
import { Router, type Request } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent } from "../db/database.js";
import { logger } from "../logger.js";
import { addPlanting, deletePlanting, getPlanting, listPlantings, PlantingError, updatePlanting } from "../pasture/plantings.js";

const log = logger("plantings");
export const plantingApi = Router();
plantingApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;
const logIt = (req: Request, msg: string) =>
  addEvent({ ts: Date.now(), source: "plantings", kind: "action", severity: "info", message: `${who(req)} ${msg}`, value: null });

function fail(res: import("express").Response, e: unknown, what: string) {
  if (e instanceof PlantingError) { res.status(400).json({ error: e.message }); return; }
  log.error(`${what} failed`, e);
  res.status(500).json({ error: `Something went wrong ${what}` });
}

/** Every planting, newest first, or one paddock's (?paddock=N). */
plantingApi.get("/plantings", (req, res) => {
  const id = Number(req.query["paddock"]);
  res.json(listPlantings(req.query["paddock"] !== undefined && Number.isInteger(id) ? id : undefined));
});

plantingApi.post("/plantings", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const id = addPlanting(Number(b["feature_id"]), b, who(req));
    const p = getPlanting(id)!;
    logIt(req, `recorded ${p.crop} planted on ${p.sown_on} in paddock #${p.feature_id}`);
    res.json({ ok: true, planting: p });
  } catch (e) { fail(res, e, "saving the planting"); }
});

plantingApi.patch("/plantings/:id", requireAdmin, (req, res) => {
  try {
    const p = updatePlanting(Number(req.params["id"]), (req.body ?? {}) as Record<string, unknown>);
    logIt(req, `changed the ${p.crop} planting of ${p.sown_on} in paddock #${p.feature_id}`);
    res.json({ ok: true, planting: p });
  } catch (e) { fail(res, e, "saving the planting"); }
});

plantingApi.delete("/plantings/:id", requireAdmin, (req, res) => {
  const p = getPlanting(Number(req.params["id"]));
  if (!p || !deletePlanting(p.id)) { res.status(404).json({ error: "No such planting" }); return; }
  logIt(req, `removed the ${p.crop} planting of ${p.sown_on} in paddock #${p.feature_id}`);
  res.json({ ok: true });
});
