import { Router } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent } from "../db/database.js";
import { logger } from "../logger.js";
import { climateRain } from "../climate/rainstats.js";
import { climateStatus, syncClimate } from "../climate/silo.js";

const log = logger("climate");
export const climateApi = Router();
climateApi.use(requireAuth);

climateApi.get("/climate/status", (_req, res) => {
  res.json(climateStatus());
});

climateApi.get("/climate/rain", (_req, res) => {
  res.json(climateRain());
});

/** Fetches from SILO now rather than waiting for the morning top-up. */
climateApi.post("/climate/sync", requireAdmin, (req, res) => {
  const who = req.user?.username ?? null;
  addEvent({ ts: Date.now(), source: "climate", kind: "action", severity: "info", message: `${who} asked for a SILO update`, value: null });
  syncClimate()
    .then((r) => log.info(`SILO update: ${r.cells} grid points, ${r.days} days${r.errors.length ? `, ${r.errors.length} failed` : ""}`))
    .catch((e) => log.error("SILO update failed", e));
  res.json({ ok: true, started: true });
});
