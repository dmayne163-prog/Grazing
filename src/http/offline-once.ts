/**
 * Changes sent from a phone's offline queue carry an X-Offline-Id made on the
 * phone. The first time an id is seen the change is made and its answer kept;
 * any later request with the same id gets that answer back and changes
 * nothing. Out of signal, a request can reach the server and the reply be
 * lost — without this the phone would send it again and a move or a death
 * would be recorded twice.
 */
import type { NextFunction, Request, Response } from "express";
import { db } from "../db/database.js";

const ID = /^[A-Za-z0-9-]{8,64}$/;
const KEEP_DAYS = 120;

export function offlineOnce(req: Request, res: Response, next: NextFunction) {
  const id = req.get("X-Offline-Id");
  if (req.method === "GET" || !id || !ID.test(id)) return next();

  const seen = db.prepare("SELECT status, response FROM offline_requests WHERE id = ?").get(id) as
    { status: number; response: string | null } | undefined;
  if (seen) {
    res.status(seen.status);
    if (seen.response === null) { res.end(); return; }
    res.type("application/json").send(seen.response);
    return;
  }

  // Keep the answer as it goes out. Server errors aren't kept: those are
  // worth trying again.
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 500) {
      db.prepare(`INSERT OR IGNORE INTO offline_requests (id, method, path, status, response, username, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, req.method, req.originalUrl.slice(0, 300), res.statusCode,
        JSON.stringify(body ?? null), req.user?.username ?? null, Date.now());
    }
    return json(body);
  };
  next();
}

/** Drops answers old enough that no phone will still be sending them. */
export function pruneOfflineRequests() {
  db.prepare("DELETE FROM offline_requests WHERE created_at < ?").run(Date.now() - KEEP_DAYS * 86_400_000);
}
