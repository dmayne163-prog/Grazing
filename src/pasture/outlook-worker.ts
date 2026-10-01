/**
 * Works out the pasture outlook off the main thread: fitting the model takes
 * several seconds, and the server shouldn't stop answering while it does.
 * The worker has its own read of the database (SQLite in WAL mode allows it).
 */
import { parentPort } from "node:worker_threads";
import { buildOutlook } from "./model.js";

parentPort!.once("message", () => {
  try {
    parentPort!.postMessage({ ok: true, outlook: buildOutlook() });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
