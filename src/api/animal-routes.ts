import { Router, type Request, type Response } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent } from "../db/database.js";
import { logger } from "../logger.js";
import { animalDeath, animalsInMob, animalView, noteAnimal, searchAnimals, weighAnimal } from "../animals/store.js";
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
