/** Feed checks on a paddock: list, record and remove. */
import { Router, type Request } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import { addCheck, deleteCheck, FeedCheckError, floorOf, getCheck, listChecks, RATINGS, scaleFor } from "../pasture/feedchecks.js";

const log = logger("feedchecks");
export const feedCheckApi = Router();
feedCheckApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;
const nameOf = (id: number) => (db.prepare("SELECT name FROM features WHERE id = ?").get(id) as { name: string | null } | undefined)?.name ?? `paddock #${id}`;
const logIt = (req: Request, msg: string) =>
  addEvent({ ts: Date.now(), source: "feedchecks", kind: "action", severity: "info", message: `${who(req)} ${msg}`, value: null });

/** A paddock's checks, newest first, with what each rating stands for there. */
feedCheckApi.get("/feed-checks", (req, res) => {
  const id = Number(req.query["paddock"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Which paddock?" }); return; }
  const scale = scaleFor(id);
  res.json({
    checks: listChecks(id),
    floor: floorOf(id),
    ratings: Object.entries(RATINGS).map(([key, v]) => ({ key, label: v.label, kg_ha: scale[key as keyof typeof scale] })),
  });
});

feedCheckApi.post("/feed-checks", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const c = addCheck(Number(b["feature_id"]), b, who(req));
    logIt(req, `checked the feed in ${nameOf(c.feature_id)} on ${c.checked_on}: ${c.rating ? RATINGS[c.rating].label.toLowerCase() + ", " : ""}about ${c.kg_ha} kg/ha`);
    res.json({ ok: true, check: c });
  } catch (e) {
    if (e instanceof FeedCheckError) { res.status(400).json({ error: e.message }); return; }
    log.error("saving a feed check failed", e);
    res.status(500).json({ error: "Something went wrong saving the feed check" });
  }
});

feedCheckApi.delete("/feed-checks/:id", requireAdmin, (req, res) => {
  const c = getCheck(Number(req.params["id"]));
  if (!c || !deleteCheck(c.id)) { res.status(404).json({ error: "No such feed check" }); return; }
  logIt(req, `removed the feed check of ${c.checked_on} in ${nameOf(c.feature_id)}`);
  res.json({ ok: true });
});
