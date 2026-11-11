/**
 * Notes from the paddock, with a photo if one was taken: on a paddock, a
 * water point or anything else on the map, or on a mob. Written on the phone,
 * often out of signal, and sent when it's back.
 *
 * Photos arrive as a JPEG data URL (the phone shrinks them first, so a note
 * is a few hundred KB at most) and are kept as files in DATA_DIR/photos,
 * inside the volume the nightly appdata backup already covers.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import { parseWhen, StockError } from "../stock/actions.js";

const log = logger("notes");
export const notesApi = Router();
notesApi.use(requireAuth);

const photoDir = resolve(config.dataDir, "photos");
const MAX_PHOTO = 3 * 1024 * 1024;
const who = (req: Request) => req.user?.username ?? null;

class NoteError extends Error {}

interface NoteRow {
  id: number; target: string; target_id: number; date: string; time: string | null;
  text: string; photo: string | null; username: string | null; created_at: number;
}

const view = (n: NoteRow) => ({
  id: n.id, target: n.target, target_id: n.target_id, date: n.date, time: n.time,
  text: n.text, photo: n.photo ? `/api/notes/${n.id}/photo` : null, username: n.username,
});

/** Notes on one thing (?target=feature|mob&id=N), or every note when neither is given. */
notesApi.get("/notes", (req, res) => {
  const target = typeof req.query["target"] === "string" ? req.query["target"] : null;
  const id = Number(req.query["id"]);
  const rows = target && Number.isInteger(id)
    ? db.prepare("SELECT * FROM field_notes WHERE deleted_at IS NULL AND target = ? AND target_id = ? ORDER BY date DESC, time DESC, id DESC").all(target, id)
    : db.prepare("SELECT * FROM field_notes WHERE deleted_at IS NULL ORDER BY date DESC, time DESC, id DESC").all();
  res.json((rows as NoteRow[]).map(view));
});

notesApi.get("/notes/:id/photo", (req, res) => {
  const n = db.prepare("SELECT photo FROM field_notes WHERE id = ? AND deleted_at IS NULL").get(Number(req.params["id"])) as { photo: string | null } | undefined;
  const file = n?.photo ? join(photoDir, n.photo) : null;
  if (!file || !existsSync(file)) { res.status(404).json({ error: "No photo" }); return; }
  // A note's photo never changes, so the phone may keep it.
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.type("image/jpeg").sendFile(file);
});

notesApi.post("/notes", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const target = b["target"] === "mob" ? "mob" : b["target"] === "feature" ? "feature" : null;
    if (!target) throw new NoteError("A note goes on a paddock, a map feature or a mob");
    const targetId = Number(b["target_id"]);
    const exists = target === "mob"
      ? db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(targetId)
      : db.prepare("SELECT 1 FROM features WHERE id = ?").get(targetId);
    if (!Number.isInteger(targetId) || !exists) throw new NoteError(`That ${target === "mob" ? "mob" : "map feature"} doesn't exist any more`);
    const text = typeof b["text"] === "string" ? b["text"].trim().slice(0, 4000) : "";
    const when = parseWhen(b["date"], b["time"]);

    let photo: string | null = null;
    if (typeof b["photo"] === "string" && b["photo"]) {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b["photo"]);
      if (!m) throw new NoteError("The photo has to be a JPEG");
      const buf = Buffer.from(m[1]!, "base64");
      if (buf.length > MAX_PHOTO) throw new NoteError("That photo is too big");
      if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new NoteError("The photo has to be a JPEG");
      mkdirSync(photoDir, { recursive: true });
      photo = `${randomUUID()}.jpg`;
      writeFileSync(join(photoDir, photo), buf);
    }
    if (!text && !photo) throw new NoteError("Write something or add a photo");

    const r = db.prepare(`INSERT INTO field_notes (target, target_id, date, time, text, photo, username, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(target, targetId, when.date, when.time, text, photo, who(req), Date.now());
    addEvent({ ts: Date.now(), source: "notes", kind: "action", severity: "info", message: `${who(req)} added a note${photo ? " with a photo" : ""} to ${target} #${targetId}`, value: null });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (e instanceof NoteError || e instanceof StockError) { res.status(400).json({ error: e.message }); return; }
    log.error("saving a note failed", e);
    res.status(500).json({ error: "Something went wrong saving the note" });
  }
});

/** Removes a note from view; the row and photo are kept. */
notesApi.delete("/notes/:id", requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE field_notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), Number(req.params["id"]));
  if (!r.changes) { res.status(404).json({ error: "No such note" }); return; }
  res.json({ ok: true });
});
