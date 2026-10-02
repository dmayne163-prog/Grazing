import { Router, type Request, type Response } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { assignSession, lastSync, listSessions, optiweighConfigured, syncOptiweigh, syncRunning } from "../animals/optiweigh-sync.js";
import { logger } from "../logger.js";
import {
  animalDeath, animalSale, animalsInMob, animalView, listAnimals, noteAnimal, searchAnimals, setSexForMob, updateAnimal, weighAnimal,
} from "../animals/store.js";
import { parseWhen, StockError } from "../stock/actions.js";

const log = logger("animals");
export const animalApi = Router();
animalApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;
const text = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function act(req: Request, res: Response, what: string, fn: () => unknown) {
  try {
    const r = fn() as object;
    log.info(`${who(req)} ${what}`);
    addEvent({ ts: Date.now(), source: "animals", kind: "action", severity: "info", message: `${who(req)} ${what}`, value: null });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof StockError) { res.status(400).json({ error: e.message }); return; }
    log.error("animal action failed", e);
    res.status(500).json({ error: "Something went wrong recording that" });
  }
}

animalApi.get("/animals", (req, res) => {
  const mob = req.query["mob"] ? Number(req.query["mob"]) : null;
  res.json(listAnimals({
    q: typeof req.query["q"] === "string" ? req.query["q"] : "",
    status: typeof req.query["status"] === "string" ? req.query["status"] : "alive",
    mob: Number.isInteger(mob) ? mob : null,
  }));
});

animalApi.patch("/animals/:id", requireAdmin, (req, res) => {
  act(req, res, `edited the details of animal #${req.params["id"]}`, () => {
    updateAnimal(Number(req.params["id"]), (req.body ?? {}) as Record<string, unknown>);
    return {};
  });
});

animalApi.post("/mobs/:id/animals/sex", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(req, res, `set the sex of mob #${req.params["id"]}'s animals to ${String(b["sex"])}`, () =>
    setSexForMob(Number(req.params["id"]), String(b["sex"]), b["only_missing"] !== false));
});

animalApi.post("/animals/:id/sale", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(req, res, `recorded the sale of animal #${req.params["id"]}`, () =>
    animalSale(Number(req.params["id"]), parseWhen(b["date"], b["time"]), b, who(req)));
});

animalApi.get("/animals/search", (req, res) => {
  res.json(searchAnimals(String(req.query["q"] ?? "")));
});

animalApi.get("/animals/:id", (req, res) => {
  const v = animalView(Number(req.params["id"]));
  if (!v) { res.status(404).json({ error: "No such animal" }); return; }
  res.json(v);
});

animalApi.get("/mobs/:id/animals", (req, res) => {
  res.json(animalsInMob(Number(req.params["id"])));
});

animalApi.post("/animals/:id/weigh", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(req, res, `weighed animal #${req.params["id"]} at ${String(b["weight_kg"])} kg`, () =>
    weighAnimal(Number(req.params["id"]), b["weight_kg"], parseWhen(b["date"], b["time"]), text(b["note"]), who(req)));
});

animalApi.post("/animals/:id/note", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(req, res, `added a note to animal #${req.params["id"]}`, () =>
    noteAnimal(Number(req.params["id"]), text(b["text"], 2000), parseWhen(b["date"], b["time"]), who(req)));
});

animalApi.post("/animals/:id/death", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(req, res, `recorded the death of animal #${req.params["id"]}`, () =>
    animalDeath(Number(req.params["id"]), parseWhen(b["date"], b["time"]), text(b["cause"]), b["also_mob"] !== false, who(req)));
});

/* -------------------------------- Optiweigh -------------------------------- */

animalApi.get("/optiweigh", (_req, res) => {
  const mobName = new Map((db.prepare("SELECT id, name FROM mobs").all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name]));
  res.json({
    configured: optiweighConfigured(),
    running: syncRunning(),
    last: lastSync(),
    sessions: listSessions().map((s) => ({ ...s, mob_name: s.mob_id === null ? null : mobName.get(s.mob_id) ?? `#${s.mob_id}` })),
  });
});

/** Which mob a session is with, or a record only. Its days are fetched again under the new assignment. */
animalApi.put("/optiweigh/sessions/:id", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const mob = b["mob_id"] === null || b["mob_id"] === undefined || b["mob_id"] === "" ? null : Number(b["mob_id"]);
  act(req, res, `assigned Optiweigh session ${req.params["id"]} to ${mob === null ? (b["record_only"] ? "records only" : "nothing") : `mob #${mob}`}`, () => {
    assignSession(Number(req.params["id"]), { mob_id: mob, record_only: mob === null && b["record_only"] === true }, req.user?.username ?? null);
    void syncOptiweigh(req.user?.username ?? null);
    return {};
  });
});

animalApi.post("/optiweigh/sync", requireAdmin, (req, res) => {
  void syncOptiweigh(req.user?.username ?? null);
  res.json({ ok: true, started: true });
});
