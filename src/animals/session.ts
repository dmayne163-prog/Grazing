/**
 * Weighing sessions from Gallagher's scales and software (TSi, TWR-5, APS),
 * exported as CSV: one row per animal, with its EID, management tag, NLIS
 * number, date, weight and any traits.
 *
 * Columns are found by heading, not position. The devices and APS export
 * slightly different sets ("Tag Number" or "VID", "Live Weight (kg)" or
 * "Weight"), and a heading-driven reader takes all of them.
 */
import { ImportError } from "../map/importers.js";

export interface SessionRow {
  i: number;
  eid: string | null;
  tag: string | null;
  nlis: string | null;
  date: string | null;
  weight_kg: number | null;
  score: number | null;
  draft: string | null;
  notes: string | null;
}

export interface ParsedSession {
  name: string;
  date: string | null;
  rows: SessionRow[];
}

/** Splits CSV text into rows of fields, honouring quotes and quoted commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMNS: Record<keyof Omit<SessionRow, "i">, string[]> = {
  eid: ["electronicid", "eid", "rfid", "electronicidnumber"],
  tag: ["tagnumber", "vid", "visualid", "managementtag", "tag", "visualtag"],
  nlis: ["nlis", "nlisid", "nlisnumber"],
  date: ["date", "datetime", "weighdate", "sessiondate"],
  weight_kg: ["liveweightkg", "weightkg", "liveweight", "weight"],
  score: ["conditionscore", "cs", "bodyconditionscore", "score"],
  draft: ["draft", "draftgroup"],
  notes: ["notes", "note", "comments", "comment"],
};

/** An EID as its digits only: "982 123798726941" → "982123798726941". */
export function normaliseEid(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

/** "2026/07/22 00:00:03", "22/07/2026", "2026-07-22" → "2026-07-22". */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

export function parseSession(filename: string, text: string): ParsedSession {
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (table.length < 2) throw new ImportError("That file has no animals in it");
  const headers = table[0]!.map(key);
  const col = (k: keyof typeof COLUMNS) => headers.findIndex((h) => COLUMNS[k].includes(h));
  const at = Object.fromEntries((Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).map((k) => [k, col(k)])) as Record<keyof typeof COLUMNS, number>;
  if (at.eid < 0 && at.tag < 0 && at.nlis < 0) {
    throw new ImportError("This file has no EID, tag or NLIS column, so its animals can't be identified");
  }

  const cell = (r: string[], k: keyof typeof COLUMNS) => {
    const v = at[k] >= 0 ? (r[at[k]] ?? "").trim() : "";
    return v === "" ? null : v;
  };
  const rows: SessionRow[] = table.slice(1).map((r, i) => {
    const w = cell(r, "weight_kg");
    const sc = cell(r, "score");
    const d = cell(r, "date");
    const weight = w !== null && Number.isFinite(Number(w)) && Number(w) > 0 ? Number(w) : null;
    const score = sc !== null && Number.isFinite(Number(sc)) && Number(sc) > 0 ? Number(sc) : null;
    return {
      i,
      eid: normaliseEid(cell(r, "eid")),
      tag: cell(r, "tag"),
      nlis: cell(r, "nlis"),
      date: d ? parseDate(d) : null,
      weight_kg: weight,
      score,
      draft: cell(r, "draft"),
      notes: cell(r, "notes"),
    };
  }).filter((r) => r.eid || r.tag || r.nlis);
  if (rows.length === 0) throw new ImportError("No animal in the file has an EID, tag or NLIS number");

  // The session's date: the one most rows carry.
  const counts = new Map<string, number>();
  for (const r of rows) if (r.date) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  const date = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // "2026-07-22 Penjobe Weaners Purchased - Session Info.csv" → "Penjobe Weaners Purchased".
  const name = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\s*-\s*session info$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
    .trim() || "Session";

  return { name, date, rows };
}
