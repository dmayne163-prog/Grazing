import { Router, type Request } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent } from "../db/database.js";
import { logger } from "../logger.js";
import {
  addReading, deleteReading, ensureGauge, listGauges, listReadings, RainError, renameGauge,
} from "../rain/store.js";

const log = logger("rain");
export const rainApi = Router();
rainApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;

/**
 * Every reading, plus monthly totals per gauge from the first reading to this
 * month — months with no reading included as zero, because "no rain recorded"
 * is itself the thing a dry spell looks like.
 */
rainApi.get("/rain", (_req, res) => {
  const gauges = listGauges();
  const readings = listReadings();
  const name = new Map(gauges.map((g) => [g.id, g.name]));

  const first = readings.length ? readings[readings.length - 1]!.date.slice(0, 7) : null;
  const months: string[] = [];
  if (first) {
    const now = new Date();
    let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
    const endY = now.getFullYear(), endM = now.getMonth() + 1;
    while (y < endY || (y === endY && m <= endM)) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }
  const monthly = months.map((month) => {
    const inMonth = readings.filter((r) => r.date.startsWith(month));
    const byGauge: Record<string, number> = {};
    for (const r of inMonth) byGauge[r.gauge_id] = (byGauge[r.gauge_id] ?? 0) + r.mm;
    return { month, readings: inMonth.length, by_gauge: byGauge };
  });

  res.json({
    gauges,
    readings: readings.map((r) => ({ ...r, gauge: name.get(r.gauge_id) ?? `#${r.gauge_id}` })),
    monthly,
  });
});

rainApi.post("/rain", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as { gauge?: unknown; gauge_id?: unknown; date?: unknown; mm?: unknown; note?: unknown };
  try {
    const gaugeId = typeof b.gauge_id === "number" ? b.gauge_id
      : typeof b.gauge === "string" ? ensureGauge(b.gauge)
      : (() => { throw new RainError("Choose a gauge"); })();
    const id = addReading(
      gaugeId, String(b.date ?? ""), null, Number(b.mm),
      typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null,
      "app", who(req)
    );
    res.json({ ok: true, id });
  } catch (e) {
    if (e instanceof RainError) { res.status(400).json({ error: e.message }); return; }
    log.error("adding a reading failed", e);
    res.status(500).json({ error: "Something went wrong saving the reading" });
  }
});

rainApi.delete("/rain/:id", requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const r = listReadings().find((x) => x.id === id);
  if (!r || !deleteReading(id)) { res.status(404).json({ error: "No such reading" }); return; }
  // A deleted reading is gone, so say what it was.
  addEvent({
    ts: Date.now(), source: "rain", kind: "reading-deleted", severity: "info",
    message: `${who(req)} deleted a rain reading: ${r.mm} mm on ${r.date}`, value: JSON.stringify(r),
  });
  res.json({ ok: true });
});

rainApi.patch("/rain/gauges/:id", requireAdmin, (req, res) => {
  try {
    renameGauge(Number(req.params["id"]), String((req.body as { name?: unknown })?.name ?? ""));
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof RainError) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: "Something went wrong" });
  }
});
