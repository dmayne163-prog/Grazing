/**
 * Ruminati's Cattle page, worked out from the mob records: for each of its
 * cattle classes, the average head, average liveweight and average daily
 * gain in each season of a financial year.
 *
 * Done day by day. On every day of the year each mob on hand is put in a
 * class by its sex and its age that day — so a mob that turns two in January
 * counts as 1–2 years until then and 2+ after, as Ruminati intends — and its
 * head, weight and gain that day are added to that class. A season's average
 * head is the head-days over the days in the season; weight and gain are
 * averaged over the head.
 *
 * As decided with David (2026-10-09): agisted cattle are included (as in his
 * 2024/25 report); every steer is a Trade Steer; females are Cows (2+) when
 * the mob is a cow mob, otherwise Heifers by age; there are no bulls. A mob of
 * mixed sex is split by the sexes recorded on its animals, or half and half
 * until there are enough of them.
 *
 * Before the app's records begin (AgriWebb was set up in late September
 * 2025) a mob's head is its first count carried back, undoing the purchases
 * and sales David lists from his NVDs for those months.
 */
import { db, getSetting, setSetting } from "../db/database.js";
import { allSegments, voidedIds } from "../stock/store.js";
import { StockError } from "../stock/actions.js";

export const CLASSES = [
  "Bulls (1+ years)",
  "Steers (<1 year)", "Steers (1-2 years)", "Steers (2+ years)",
  "Cows (2+ years)",
  "Heifers (<1 year)", "Heifers (1-2 years)", "Heifers (2+ years - not calving)",
  "Trade Steers (2+ years)", "Trade Steers (1-2 years)", "Trade Steers (<1 year)",
] as const;

const SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;
type Season = (typeof SEASONS)[number];

/** A purchase (+) or sale (−) from before the records, from the NVDs. */
export interface PreRecord { date: string; mob_id: number; head_change: number; note: string }

const DAY = 86_400_000;
const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
const dateOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

function seasonOf(date: string): Season {
  const m = Number(date.slice(5, 7));
  return m >= 9 && m <= 11 ? "Spring" : m === 12 || m <= 2 ? "Summer" : m <= 5 ? "Autumn" : "Winter";
}

/** Without a birth date, the mob's age group stands in for its age. */
function ageYears(birth: string | null, ageClass: string | null, day: number): { age: number; guessed: boolean } {
  if (birth) return { age: (day - dayNo(birth)) / 365.25, guessed: false };
  const c = (ageClass ?? "").toLowerCase();
  if (c.includes("weaner") || c.includes("calf") || c.includes("calves")) return { age: 0.6, guessed: true };
  if (c.includes("cow") || c.includes("bull")) return { age: 4, guessed: true };
  return { age: 1.5, guessed: true };
}

function classFor(sex: "female" | "steer" | "male", cowMob: boolean, age: number): string {
  if (sex === "male") return "Bulls (1+ years)";
  if (sex === "steer") return age < 1 ? "Trade Steers (<1 year)" : age < 2 ? "Trade Steers (1-2 years)" : "Trade Steers (2+ years)";
  if (cowMob) return "Cows (2+ years)";
  return age < 1 ? "Heifers (<1 year)" : age < 2 ? "Heifers (1-2 years)" : "Heifers (2+ years - not calving)";
}

export function preRecords(): PreRecord[] {
  const s = getSetting("ruminati_pre_records");
  return s ? (JSON.parse(s) as PreRecord[]) : [];
}

export function savePreRecords(list: unknown): PreRecord[] {
  if (!Array.isArray(list)) throw new StockError("Expected a list");
  const mobs = new Set((db.prepare("SELECT id FROM mobs").all() as Array<{ id: number }>).map((m) => m.id));
  const clean = list.map((r: Partial<PreRecord>) => {
    const date = String(r.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new StockError("Each line needs a date");
    if (!mobs.has(Number(r.mob_id))) throw new StockError("Each line needs a mob");
    const n = Math.round(Number(r.head_change));
    if (!Number.isFinite(n) || n === 0) throw new StockError("Each line needs a head count: + for bought, − for sold");
    return { date, mob_id: Number(r.mob_id), head_change: n, note: String(r.note ?? "").slice(0, 200) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  setSetting("ruminati_pre_records", JSON.stringify(clean));
  return clean;
}

interface MobInfo {
  id: number; name: string; sex: string | null; age_class: string | null; birth_date: string | null; owner: string | null; data: string;
}

/**
 * Sets the birth date on every mob of a name that has none. AgriWebb split one
 * line of cattle into many mob records as it was drafted and sold, all with
 * the same name, so this is how their age is given once.
 */
export function setBirthByName(name: string, birth: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) throw new StockError("Give the birth date as YYYY-MM-DD");
  return db.prepare("UPDATE mobs SET birth_date = ?, updated_at = ? WHERE name = ? AND birth_date IS NULL").run(birth, Date.now(), name).changes;
}

export function ruminatiCattle(fyEnd: number) {
  if (!Number.isInteger(fyEnd) || fyEnd < 2000 || fyEnd > 2100) throw new StockError("Give the financial year, e.g. 2026");
  const from = dayNo(`${fyEnd - 1}-07-01`), to = dayNo(`${fyEnd}-06-30`);
  const mobs = new Map((db.prepare("SELECT id, name, sex, age_class, birth_date, owner, data FROM mobs").all() as MobInfo[]).map((m) => [m.id, m]));
  const pre = preRecords();

  // Head on each day, from the steady runs the stock history is made of.
  const head = new Map<number, Map<number, number>>();
  const put = (mob: number, day: number, n: number) => {
    if (day < from || day > to || n <= 0) return;
    const m = head.get(mob) ?? new Map<number, number>();
    m.set(day, n);
    head.set(mob, m);
  };
  const segs = allSegments();
  const firstSeg = new Map<number, (typeof segs)[number]>();
  for (const s of segs) {
    if (!firstSeg.has(s.mob_id) || s.from < firstSeg.get(s.mob_id)!.from) firstSeg.set(s.mob_id, s);
    const end = s.to ? dayNo(s.to) - 1 : to;
    for (let d = Math.max(from, dayNo(s.from)); d <= Math.min(to, end); d++) put(s.mob_id, d, s.head);
  }
  // Carried back before the records: only mobs that start with AgriWebb's
  // opening snapshot, not mobs drafted, bought or merged into being later.
  const opening = new Map((db.prepare(
    "SELECT mob_id, MIN(date) d FROM mob_events WHERE kind = 'opening' GROUP BY mob_id"
  ).all() as Array<{ mob_id: number; d: string }>).map((r) => [r.mob_id, r.d]));
  const recordsBegin = (db.prepare("SELECT MIN(date) d FROM mob_events WHERE kind = 'opening'").get() as { d: string | null }).d;
  const carried: string[] = [];
  for (const [mobId, s] of firstSeg) {
    const open = opening.get(mobId);
    if (!open || !recordsBegin || open !== s.from || dayNo(open) - dayNo(recordsBegin) > 14) continue;
    const start = dayNo(s.from);
    if (start <= from) continue;
    let n = s.head;
    const mine = pre.filter((p) => p.mob_id === mobId && dayNo(p.date) <= start).sort((a, b) => b.date.localeCompare(a.date));
    let i = 0;
    for (let d = start - 1; d >= from; d--) {
      while (i < mine.length && dayNo(mine[i]!.date) > d) n -= mine[i++]!.head_change;
      put(mobId, d, n);
    }
    carried.push(mobs.get(mobId)?.name ?? `#${mobId}`);
  }

  // Weights: each mob's weighings, straight lines between, flat beyond.
  const voided = voidedIds();
  const weighings = new Map<number, Array<{ day: number; kg: number }>>();
  for (const r of db.prepare(
    "SELECT id, mob_id, date, weight_kg FROM mob_events WHERE kind = 'weigh' AND weight_kg IS NOT NULL ORDER BY mob_id, date, id"
  ).all() as Array<{ id: number; mob_id: number; date: string; weight_kg: number }>) {
    if (voided.has(r.id)) continue;
    const list = weighings.get(r.mob_id) ?? [];
    const day = dayNo(r.date);
    if (list.length && list[list.length - 1]!.day === day) list[list.length - 1]!.kg = r.weight_kg;
    else list.push({ day, kg: r.weight_kg });
    weighings.set(r.mob_id, list);
  }
  /** Weight that day, its daily gain (null outside two weighings), and whether weighed that season. */
  // Never weighed here: AgriWebb's mob-list weight, held flat, if it had one.
  const listed = new Map<number, number>();
  for (const m of mobs.values()) {
    const kg = (JSON.parse(m.data) as Record<string, unknown>)["weight_kg"];
    if (typeof kg === "number" && kg > 0) listed.set(m.id, kg);
  }
  const weightOn = (mobId: number, day: number): { kg: number | null; gain: number | null } => {
    const list = weighings.get(mobId);
    if (!list?.length) return { kg: listed.get(mobId) ?? null, gain: null };
    if (day <= list[0]!.day) return { kg: list[0]!.kg, gain: null };
    if (day >= list[list.length - 1]!.day) return { kg: list[list.length - 1]!.kg, gain: null };
    let i = 1;
    while (list[i]!.day < day) i++;
    const a = list[i - 1]!, b = list[i]!;
    const gain = (b.kg - a.kg) / (b.day - a.day);
    return { kg: a.kg + gain * (day - a.day), gain };
  };

  // A mob of one sex that once held some of another: cattle of the other sex
  // drafted out of it (AgriWebb's No.5s held 257 steers until February), or
  // drafted into it. Before such a draft out, and after such a draft in, those
  // head are counted as their own sex, not the mob's.
  type Adj = { day: number; sex: "female" | "steer" | "male"; head: number; before: boolean };
  const adjust = new Map<number, Adj[]>();
  const sexOf = (id: number) => {
    const x = mobs.get(id)?.sex;
    return x === "female" || x === "steer" || x === "male" ? x : null;
  };
  const seenDraft = new Set<string>();
  const voidedEarly = voidedIds();
  const addAdj = (mob: number, other: number, a: Adj) => {
    const k = `${mob}|${other}|${a.day}|${a.before}`;
    if (seenDraft.has(k)) return;
    seenDraft.add(k);
    adjust.set(mob, [...(adjust.get(mob) ?? []), a]);
  };
  for (const e of db.prepare("SELECT id, mob_id, date, kind, head, head_change, data FROM mob_events WHERE kind IN ('transfer', 'opening')").all() as Array<{ id: number; mob_id: number; date: string; kind: string; head: number | null; head_change: number | null; data: string }>) {
    if (voidedEarly.has(e.id)) continue;
    const d = JSON.parse(e.data) as Record<string, unknown>;
    if (e.kind === "transfer" && e.head_change !== null && e.head_change < 0 && typeof d["to_mob"] === "number") {
      const p = sexOf(e.mob_id), c = sexOf(d["to_mob"]);
      if (p && c && p !== c) addAdj(e.mob_id, d["to_mob"], { day: dayNo(e.date), sex: c, head: -e.head_change, before: true });
    } else if (e.kind === "transfer" && e.head_change !== null && e.head_change > 0 && typeof d["from_mob"] === "number") {
      const p = sexOf(d["from_mob"]), c = sexOf(e.mob_id);
      if (p && c && p !== c) addAdj(e.mob_id, d["from_mob"], { day: dayNo(e.date), sex: p, head: e.head_change, before: false });
    } else if (e.kind === "opening" && e.head && (typeof d["from_mob"] === "number" || typeof d["drafted_from"] === "number")) {
      const parent = Number(d["from_mob"] ?? d["drafted_from"]);
      const p = sexOf(parent), c = sexOf(e.mob_id);
      if (p && c && p !== c) addAdj(parent, e.mob_id, { day: dayNo(e.date), sex: c, head: e.head, before: true });
    }
  }
  /** That day's head by sex, for a mob whose sex is set but which held others. */
  const daySplit = (mob: MobInfo, day: number, n: number): Record<"female" | "steer" | "male", number> | null => {
    const list = adjust.get(mob.id);
    const own = sexOf(mob.id);
    if (!list || !own) return null;
    const out = { female: 0, steer: 0, male: 0 };
    for (const a of list) if (a.before ? day < a.day : day >= a.day) out[a.sex] += a.head;
    const other = out.female + out.steer + out.male - out[own];
    if (other <= 0) return null;
    const scale = other > n ? n / other : 1;
    for (const k of ["female", "steer", "male"] as const) if (k !== own) out[k] *= scale;
    out[own] = n - (other * scale);
    return out;
  };

  // How a mob of mixed sex splits: its animals' recorded sexes, else halves.
  const sexSplit = new Map<number, { female: number; steer: number; male: number; basis: string }>();
  const splitOf = (m: MobInfo) => {
    const hit = sexSplit.get(m.id);
    if (hit) return hit;
    let out: { female: number; steer: number; male: number; basis: string };
    if (m.sex === "female" || m.sex === "steer" || m.sex === "male") {
      out = { female: 0, steer: 0, male: 0, basis: "mob" };
      out[m.sex] = 1;
    } else {
      const rows = db.prepare(`
        SELECT a.sex, COUNT(DISTINCT a.id) n FROM animals a JOIN animal_events e ON e.animal_id = a.id
        WHERE e.mob_id = ? AND a.sex IS NOT NULL GROUP BY a.sex
      `).all(m.id) as Array<{ sex: string; n: number }>;
      const c = { female: 0, steer: 0, male: 0 };
      for (const r of rows) {
        if (r.sex === "female") c.female += r.n;
        else if (r.sex === "male") c.male += r.n;
        else c.steer += r.n; // steers and stags: neither breeds here
      }
      const known = c.female + c.steer + c.male;
      out = known >= 10
        ? { female: c.female / known, steer: c.steer / known, male: c.male / known, basis: `${known} tagged animals` }
        : { female: 0.5, steer: 0.5, male: 0, basis: "half and half (too few tagged animals)" };
    }
    sexSplit.set(m.id, out);
    return out;
  };

  type Acc = { headDays: number; kgHead: number; kgN: number; gainHead: number; gainN: number; weighed: boolean };
  const acc = new Map<string, Acc>();
  const daysIn = new Map<Season, number>();
  const seasonWeighed = new Set<string>(); // mob|season with a weighing in it
  for (const [mobId, list] of weighings) for (const w of list) if (w.day >= from && w.day <= to) seasonWeighed.add(`${mobId}|${seasonOf(dateOf(w.day))}`);
  const mobRows = new Map<number, { mob: MobInfo; split: ReturnType<typeof splitOf>; headDays: number; guessedAge: boolean; noWeight: boolean; listedOnly: boolean }>();

  for (let d = from; d <= to; d++) {
    const season = seasonOf(dateOf(d));
    daysIn.set(season, (daysIn.get(season) ?? 0) + 1);
  }
  for (const [mobId, days] of head) {
    const mob = mobs.get(mobId);
    if (!mob) continue;
    const split = splitOf(mob);
    const cowMob = /cow/i.test(mob.age_class ?? "") || /\bcows?\b/i.test(mob.name);
    let headDays = 0, guessedAge = false;
    for (const [d, n] of days) {
      const season = seasonOf(dateOf(d));
      const { age, guessed } = ageYears(mob.birth_date, mob.age_class, d);
      guessedAge ||= guessed;
      const w = weightOn(mobId, d);
      headDays += n;
      const heads = daySplit(mob, d, n);
      for (const sex of ["female", "steer", "male"] as const) {
        const share = heads ? heads[sex] : n * split[sex];
        if (share <= 0) continue;
        const key = `${classFor(sex, cowMob, age)}|${season}`;
        const a = acc.get(key) ?? { headDays: 0, kgHead: 0, kgN: 0, gainHead: 0, gainN: 0, weighed: false };
        a.headDays += share;
        if (w.kg !== null) { a.kgHead += w.kg * share; a.kgN += share; }
        if (w.gain !== null) { a.gainHead += w.gain * share; a.gainN += share; }
        if (seasonWeighed.has(`${mobId}|${season}`)) a.weighed = true;
        acc.set(key, a);
      }
    }
    mobRows.set(mobId, { mob, split, headDays, guessedAge, noWeight: !weighings.has(mobId) && !listed.has(mobId), listedOnly: !weighings.has(mobId) && listed.has(mobId) });
  }

  const classes = CLASSES.map((cls) => ({
    class: cls,
    seasons: SEASONS.map((season) => {
      const a = acc.get(`${cls}|${season}`);
      const days = daysIn.get(season) ?? 1;
      if (!a || a.headDays <= 0) return { season, head: 0, liveweight: null, adg: null, weight_cover: 0, gain_cover: 0, weighed: false };
      return {
        season,
        head: Math.round(a.headDays / days),
        liveweight: a.kgN ? Math.round(a.kgHead / a.kgN) : null,
        adg: a.gainN ? Math.round((a.gainHead / a.gainN) * 100) / 100 : null,
        /** Share of the head-days with a weight, and with a gain between two weighings. */
        weight_cover: Math.round((a.kgN / a.headDays) * 100),
        gain_cover: Math.round((a.gainN / a.headDays) * 100),
        weighed: a.weighed,
      };
    }),
  })).filter((c) => c.seasons.some((s) => s.head > 0));

  // One line per mob name: AgriWebb's many records of one line of cattle together.
  const byName = new Map<string, { name: string; records: number; head_days: number; owner: string | null; sexes: Set<string>;
    births: Set<string>; missing_birth: number; split: string; no_weight: number; listed_only: number }>();
  for (const r of mobRows.values()) {
    if (r.headDays <= 0) continue;
    const g = byName.get(r.mob.name) ?? { name: r.mob.name, records: 0, head_days: 0, owner: r.mob.owner, sexes: new Set<string>(),
      births: new Set<string>(), missing_birth: 0, split: r.split.basis, no_weight: 0, listed_only: 0 };
    g.records++;
    g.head_days += r.headDays;
    g.sexes.add(r.mob.sex ?? "mixed");
    if (r.mob.birth_date) g.births.add(r.mob.birth_date); else g.missing_birth++;
    if (r.split.basis !== "mob") g.split = r.split.basis.startsWith("half") ? r.split.basis : `${Math.round(r.split.female * 100)}% female, from ${r.split.basis}`;
    if (r.noWeight) g.no_weight++;
    if (r.listedOnly) g.listed_only++;
    byName.set(r.mob.name, g);
  }
  const mobList = [...byName.values()].map((g) => ({
    name: g.name, records: g.records, avg_head: Math.round(g.head_days / (to - from + 1)), owner: g.owner,
    sex: [...g.sexes].join(", "), births: [...g.births].sort(), missing_birth: g.missing_birth,
    split: g.split === "mob" ? null : g.split, no_weight: g.no_weight, listed_only: g.listed_only,
  })).sort((a, b) => b.avg_head - a.avg_head);

  return {
    fy: fyEnd, from: dateOf(from), to: dateOf(to),
    season_days: Object.fromEntries(daysIn),
    records_begin: recordsBegin, carried_back: carried, pre_records: pre,
    /** Mobs that can take a before-the-records line: those on hand when the records began. */
    all_mobs: [...firstSeg.values()].filter((s) => recordsBegin && dayNo(s.from) - dayNo(recordsBegin) <= 14 && opening.get(s.mob_id) === s.from)
      .map((s) => ({ id: s.mob_id, name: mobs.get(s.mob_id)?.name ?? `#${s.mob_id}`, head: s.head, from: s.from }))
      .sort((a, b) => a.name.localeCompare(b.name) || b.head - a.head),
    classes, mobs: mobList,
  };
}
