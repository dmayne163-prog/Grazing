/**
 * AgriWebb's spreadsheet exports: the mob list, the paddock list, the
 * Movement records report and the rainfall report.
 *
 * The mob and paddock lists are snapshots of *now*, not history. The mob list becomes each mob's
 * opening position — head, paddocks, last weight — dated the day of the
 * export; movements recorded here afterwards build on it.
 *
 * Columns are found by their heading, not their position, so a column added
 * or reordered in a later export does not shift everything by one.
 */
import ExcelJS from "exceljs";
import { ImportError } from "../map/importers.js";

type Cell = string | number | Date | null;
type Row = Map<string, Cell>;

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
  }
  return null;
}

async function readRows(data: Buffer): Promise<{ headers: string[]; rows: Row[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new ImportError("That file could not be read as an Excel workbook (.xlsx)");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportError("The workbook has no sheets");

  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, n) => {
    headers[n] = key(String(cellValue(c.value) ?? ""));
  });

  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const r: Row = new Map();
    row.eachCell({ includeEmpty: false }, (c, col) => {
      const h = headers[col];
      if (h) r.set(h, cellValue(c.value));
    });
    if ([...r.values()].some((v) => v !== null && v !== "")) rows.push(r);
  });
  return { headers: headers.filter(Boolean), rows };
}

const str = (r: Row, k: string): string | null => {
  const v = r.get(k);
  if (v === null || v === undefined) return null;
  const s = (v instanceof Date ? isoDate(v) : String(v)).trim();
  return s === "" ? null : s;
};

const num = (r: Row, k: string): number | null => {
  const v = r.get(k);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Excel stores a date as a day number with no zone, and ExcelJS hands it back
 * as that moment in UTC — so the UTC fields *are* the date that was typed.
 * Reading local fields instead would shift some dates a day in Queensland.
 */
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function date(r: Row, k: string): string | null {
  const v = r.get(k);
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "string") {
    const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim()); // dd/mm/yyyy
    if (au) return `${au[3]}-${au[2]!.padStart(2, "0")}-${au[1]!.padStart(2, "0")}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
    if (iso) return iso[0];
  }
  return null;
}

/* ---------------------------------- mobs --------------------------------- */

export interface MobCandidate {
  i: number;
  /** As exported. Several mobs can share one, so it is not an identity. */
  source_name: string;
  name: string;
  species: string;
  breed: string | null;
  age_class: string | null;
  sex: string | null;
  tag_colour: string | null;
  management_tag: string | null;
  origin: string | null;
  birth_date: string | null;
  description: string | null;
  owner: string | null;
  head: number;
  agriwebb_ae_head: number | null;
  weight_kg: number | null;
  last_weighed: string | null;
  adg_kg: number | null;
  agriwebb_est_weight_kg: number | null;
  score: number | null;
  cell: string | null;
  paddock_names: string[];
  /** Filled in by the caller, which knows the map. */
  paddock_ids: number[];
  unmatched_paddocks: string[];
  warnings: string[];
}

export interface PaddockRowCandidate {
  i: number;
  name: string;
  total_ha: number | null;
  arable_ha: number | null;
  land_use: string | null;
  cattle: number | null;
  sheep: number | null;
  ae: number | null;
  ae_per_ha: number | null;
  description: string | null;
  colour: string | null;
}

/** One line of AgriWebb's Movement records report. */
export interface MovementRow {
  /** Position in the file. The file is newest first. */
  i: number;
  /** Local date and time of the observation, "YYYY-MM-DD HH:MM". */
  at: string;
  event: string;
  mob: string;
  breed: string | null;
  tag_colour: string | null;
  age_class: string | null;
  paddock: string | null;
  moved_from: string | null;
  moved_to: string | null;
  head_before: number;
  change: number;
  head_after: number;
  recorded_at: string | null;
  user: string | null;
}

/** One rain gauge reading from AgriWebb's rainfall report. */
export interface RainRow {
  i: number;
  date: string;
  /** "HH:MM" as recorded; null where AgriWebb has midnight, i.e. no time given. */
  time: string | null;
  gauge: string;
  mm: number;
}

export type ParsedSheet =
  | { type: "mobs"; mobs: MobCandidate[] }
  | { type: "paddocks"; paddocks: PaddockRowCandidate[] }
  | { type: "movements"; movements: MovementRow[] }
  | { type: "rainfall"; readings: RainRow[] };

export async function parseAgriWebbSheet(data: Buffer): Promise<ParsedSheet> {
  counter = 0;
  const { headers, rows } = await readRows(data);
  const has = (...ks: string[]) => ks.every((k) => headers.includes(k));

  if (has("name", "head", "reportedpaddock")) return { type: "mobs", mobs: rows.map(toMob) };
  if (has("name", "totalareaha", "landuse")) return { type: "paddocks", paddocks: rows.map(toPaddockRow) };
  if (has("date", "gauge", "rainfallmm")) {
    return {
      type: "rainfall",
      readings: rows.map((r) => {
        const at = dateTime(r, "date");
        const mm = num(r, "rainfallmm");
        if (!at || mm === null) throw new ImportError("A rainfall row is missing its date or amount");
        const time = at.slice(11);
        return { i: counter++, date: at.slice(0, 10), time: time === "00:00" ? null : time, gauge: str(r, "gauge") ?? "Unknown", mm };
      }),
    };
  }
  if (has("observationdate", "event", "mob", "headbefore", "headafter")) {
    return { type: "movements", movements: rows.map(toMovement) };
  }

  throw new ImportError(
    "This spreadsheet is not one this app knows. It reads AgriWebb's mob list, paddock list, Movement records and rainfall exports."
  );
}

function sexFromClass(ageClass: string | null, name: string): string | null {
  const text = `${ageClass ?? ""} ${name}`.toLowerCase();
  const female = /heifer|\bcows?\b/.test(text);
  const steer = /steer/.test(text);
  const bull = /\bbulls?\b/.test(text);
  // "Steers and Heifers" is a mixed mob — no single answer.
  if ([female, steer, bull].filter(Boolean).length !== 1) return null;
  return female ? "female" : steer ? "steer" : "male";
}

/** "Burnside Grazing Agistment" → "Burnside Grazing"; "Hewitts No.4 Agistment Steers" → "Hewitts". */
function ownerFromDescription(desc: string | null): string | null {
  if (!desc || !/agist/i.test(desc)) return null;
  const before = desc.split(/agist/i)[0]!
    .replace(/\b(no\.?|number)\s*\d+\s*$/i, "")
    .trim();
  return before || "Agistment (owner not recorded)";
}

let counter = 0;

function toMob(r: Row): MobCandidate {
  const sourceName = str(r, "name") ?? "(unnamed mob)";
  const ageClass = str(r, "ageclass");
  const paddockList = (str(r, "paddocks") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const reported = str(r, "reportedpaddock");
  // The reported paddock goes first: it is where the mob's head is counted.
  const paddock_names = reported
    ? [reported, ...paddockList.filter((p) => p.toLowerCase() !== reported.toLowerCase())]
    : paddockList;

  const score = num(r, "score");
  return {
    i: counter++,
    source_name: sourceName,
    name: sourceName,
    species: str(r, "species") ?? "Cattle",
    breed: str(r, "breed"),
    age_class: ageClass,
    sex: sexFromClass(ageClass, sourceName),
    tag_colour: str(r, "tagcolour"),
    management_tag: str(r, "managementtag"),
    origin: str(r, "origin"),
    birth_date: date(r, "dateofbirth"),
    description: str(r, "description"),
    owner: ownerFromDescription(str(r, "description")),
    head: Math.round(num(r, "head") ?? 0),
    agriwebb_ae_head: num(r, "loadaehead"),
    weight_kg: num(r, "weightkghead"),
    last_weighed: date(r, "datelastweighed"),
    adg_kg: num(r, "assumedadgkgday"),
    agriwebb_est_weight_kg: num(r, "estimatedweightkghead"),
    // AgriWebb writes 0 for "no score recorded"; a real condition score is 1–5.
    score: score && score > 0 ? score : null,
    cell: str(r, "cell"),
    paddock_names,
    paddock_ids: [],
    unmatched_paddocks: [],
    warnings: [],
  };
}

/** Date and time as typed, read from the UTC fields for the same reason as isoDate. */
function dateTime(r: Row, k: string): string | null {
  const v = r.get(k);
  if (v instanceof Date) {
    return `${isoDate(v)} ${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}`;
  }
  const d = date(r, k);
  if (!d) return null;
  const t = typeof v === "string" ? /(d{1,2}):(d{2})/.exec(v) : null;
  return `${d} ${t ? `${t[1]!.padStart(2, "0")}:${t[2]}` : "00:00"}`;
}

function toMovement(r: Row): MovementRow {
  const at = dateTime(r, "observationdate");
  if (!at) throw new ImportError("A movement record has no observation date");
  return {
    i: counter++,
    at,
    event: str(r, "event") ?? "",
    mob: str(r, "mob") ?? "(unnamed mob)",
    breed: str(r, "breed"),
    tag_colour: str(r, "tagcolour"),
    age_class: str(r, "ageclass"),
    paddock: str(r, "paddock"),
    moved_from: str(r, "movedfrom"),
    moved_to: str(r, "movedto"),
    head_before: Math.round(num(r, "headbefore") ?? 0),
    change: Math.round(num(r, "change") ?? 0),
    head_after: Math.round(num(r, "headafter") ?? 0),
    recorded_at: dateTime(r, "recordcreationdate"),
    user: str(r, "user"),
  };
}

function toPaddockRow(r: Row): PaddockRowCandidate {
  return {
    i: counter++,
    name: str(r, "name") ?? "",
    total_ha: num(r, "totalareaha"),
    arable_ha: num(r, "arableareaha"),
    land_use: str(r, "landuse"),
    cattle: num(r, "cattlehead"),
    sheep: num(r, "sheephead"),
    ae: num(r, "ae"),
    ae_per_ha: num(r, "stockingrateaeha"),
    description: str(r, "description"),
    colour: str(r, "colour"),
  };
}

/* -------------------------------- reviewing ------------------------------ */

const monthsBetween = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (30.44 * 86_400_000);

/**
 * Looks over the mob list as a whole: names that collide, owners spelt two
 * ways, weights too old or too light to trust. Nothing is changed silently —
 * every adjustment is a suggestion shown in the review, where it can be undone.
 */
export function reviewMobs(mobs: MobCandidate[], asOf: string) {
  // Owners spelt with and without a trailing "s" are taken to be one owner.
  const owners = new Set(mobs.map((m) => m.owner).filter((o): o is string => !!o));
  for (const m of mobs) {
    if (m.owner && m.owner.endsWith("s") && owners.has(m.owner.slice(0, -1))) {
      m.owner = m.owner.slice(0, -1);
    }
  }
  // Agistment is rarely labelled consistently. A description naming an owner
  // ("Hewitt Number 5 Heifers") or a mob sharing its name with an agisted one
  // is far more often agistment than not, so the owner is filled in — and
  // flagged — rather than left for someone to notice. Leaving it blank
  // silently counted 580 of Hewitt's head as the property's own.
  const ownerNames = [...new Set(mobs.map((m) => m.owner).filter((o): o is string => !!o))];
  const agistedNames = new Map(
    mobs.filter((m) => m.owner).map((m) => [m.source_name.toLowerCase(), m.owner!])
  );
  for (const m of mobs) {
    if (m.owner) continue;
    const hit = m.description
      ? ownerNames.find((o) => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(m.description!))
      : undefined;
    if (hit) {
      m.owner = hit;
      m.warnings.push(`Set as ${hit}'s agistment because the description names ${hit}. Clear the owner if these are your own.`);
      continue;
    }
    const sibling = agistedNames.get(m.source_name.toLowerCase());
    if (sibling) {
      m.owner = sibling;
      m.warnings.push(`Set as ${sibling}'s agistment because another mob with this name is. Clear the owner if these are your own.`);
    }
  }

  // Duplicate names: distinguish by paddock, then by year of birth, then by head.
  const byName = new Map<string, MobCandidate[]>();
  for (const m of mobs) {
    const k = m.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), m]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const suffixes: Array<(m: MobCandidate) => string | null> = [
      (m) => m.paddock_names[0] ?? null,
      (m) => (m.birth_date ? `born ${m.birth_date.slice(0, 4)}` : null),
      (m) => `${m.head} hd`,
    ];
    const parts = new Map<MobCandidate, string[]>(group.map((m) => [m, []]));
    for (const f of suffixes) {
      const names = group.map((m) => [m.name, ...parts.get(m)!].join(" · "));
      if (new Set(names).size === group.length) break;
      // Only mobs still colliding get another detail, and only a detail that
      // actually differs between them — three weaner mobs all in Tablelands
      // are not told apart by adding "Tablelands" to each.
      const colliding = group.filter((_, idx) => names.filter((n) => n === names[idx]).length > 1);
      const values = colliding.map(f);
      if (new Set(values).size < 2) continue;
      colliding.forEach((m, idx) => {
        const v = values[idx];
        if (v) parts.get(m)!.push(v);
      });
    }
    for (const m of group) {
      const extra = parts.get(m)!;
      if (extra.length) {
        m.name = `${m.name} · ${extra.join(" · ")}`;
        m.warnings.push(`${group.length} mobs are called "${m.source_name}", so this one has been given a distinguishing name.`);
      }
    }
  }

  for (const m of mobs) {
    if (m.last_weighed) {
      const months = monthsBetween(m.last_weighed, asOf);
      if (months >= 6) {
        m.warnings.push(`Last weighed ${Math.round(months)} months ago (${m.last_weighed}); stocking rates will use that weight until it is updated.`);
      }
    } else {
      m.warnings.push("No weight recorded.");
    }
    if (m.birth_date && m.weight_kg !== null) {
      const age = monthsBetween(m.birth_date, asOf);
      // A rough floor: a calf gains well over half a kilo a day to weaning.
      const floor = 35 + Math.max(0, age) * 15;
      if (age >= 4 && m.weight_kg < floor * 0.6) {
        m.warnings.push(`${m.weight_kg} kg at about ${Math.round(age)} months old — that weight looks out of date.`);
      }
    }
    // AgriWebb's estimate is not simply last weight plus daily gain — for some
    // mobs it is well below the last weighing. Report the gap; don't guess why.
    if (m.weight_kg !== null && m.agriwebb_est_weight_kg !== null && (m.adg_kg ?? 0) === 0 &&
        Math.abs(m.agriwebb_est_weight_kg - m.weight_kg) > 5) {
      m.warnings.push(`AgriWebb's estimated weight is ${Math.round(m.agriwebb_est_weight_kg)} kg against a last weighing of ${m.weight_kg} kg, with no daily gain set; this app uses the weighed ${m.weight_kg} kg.`);
    }
  }
}

export function asOfFromFilename(filename: string, fallback: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m ? m[1]! : fallback;
}
