/**
 * The pasture model's slow jobs, off the main thread: fitting the model takes
 * several seconds, and the server shouldn't stop answering while it does.
 * The worker has its own read of the database (SQLite in WAL mode allows it).
 *
 *   "outlook"  the outlook for every paddock and the property
 *   "gates"    gates that were probably open but never recorded, before a date
 */
import { parentPort } from "node:worker_threads";
import { gateStateAt, listGates } from "../map/gates.js";
import { buildOutlook, findOpenGates } from "./model.js";

parentPort!.once("message", (m: { job: "outlook" } | { job: "gates"; before: string }) => {
  try {
    if (m.job === "gates") {
      const gates = listGates().filter((g) => g.paddocks.length === 2)
        .map((g) => ({ id: g.gate_id, name: g.name, a: g.paddocks[0]!, b: g.paddocks[1]! }));
      const found = findOpenGates(gates, m.before, (id, date) => gateStateAt(id, date, null)?.state === "open");
      parentPort!.postMessage({ ok: true, result: found });
    } else {
      parentPort!.postMessage({ ok: true, result: buildOutlook() });
    }
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
