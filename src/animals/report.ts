/**
 * Animal reports: filter the animals, list them with their weights and
 * carcass weights, and total them — what a consignment to the works needs.
 *
 * Kept deliberately small next to APS's: the rules David uses (seen in a
 * session, a data field such as "Sending to Hewitt Foods", sex), plus mob and
 * status, all ANDed together, each allowing several values (OR within a rule).
 */
import { db } from "../db/database.js";
import { StockError } from "../stock/actions.js";

export type Rule =
  | { kind: "session"; session_ids: number[]; seen: boolean }
  | { kind: "field"; field: string; values: string[]; session_id?: number | null }
  | { kind: "sex"; values: string[]; not?: boolean }
  | { kind: "mob"; mob_ids: number[] }
  | { kind: "status"; values: string[] };

export interface ReportSpec {
  rules: Rule[];
  /** Weights from: each animal's latest, or a given session. */
  weights_from: "latest" | number;
  dressing_pct: number;
  sort: "weight" | "tag";
}

export interface ReportRow {
  id: number; tag: string | null; eid: string | null; nlis: string | null; sex: string | null;
  status: string; mob: string | null; weight_kg: number | null; weighed: string | null; carcass_kg: number | null;
}

interface Ev { animal_id: number; date: string; kind: string; mob_id: number | null; weight_kg: number | null; session_id: number | null; id: number }

const SEX_LABEL: Record<string, string> = { female: "Female", steer: "Steer", male: "Male", stag: "Stag" };

export function runReport(spec: ReportSpec) {
  const pct = Number(spec.dressing_pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new StockError("Give the dressing percentage, e.g. 52");
  const animals = db.prepare("SELECT id, eid, tag, nlis, sex FROM animals").all() as Array<{ id: number; eid: string | null; tag: string | null; nlis: string | null; sex: string | null }>;
  const events = db.prepare("SELECT id, animal_id, date, kind, mob_id, weight_kg, session_id FROM animal_events ORDER BY date, id").all() as Ev[];
  const byAnimal = new Map<number, Ev[]>();
  for (const e of events) byAnimal.set(e.animal_id, [...(byAnimal.get(e.animal_id) ?? []), e]);
  const mobName = new Map((db.prepare("SELECT id, name FROM mobs").all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name]));
  // Which sessions each animal was seen in: a weighing, a score, a note or a data field.
  const seenIn = new Map<number, Set<number>>();
  for (const e of events) if (e.session_id !== null) seenIn.set(e.animal_id, (seenIn.get(e.animal_id) ?? new Set()).add(e.session_id));
  for (const r of db.prepare("SELECT DISTINCT animal_id, session_id FROM session_fields").all() as Array<{ animal_id: number; session_id: number }>) {
    seenIn.set(r.animal_id, (seenIn.get(r.animal_id) ?? new Set()).add(r.session_id));
  }
  const sessionDate = new Map((db.prepare("SELECT id, date FROM weigh_sessions").all() as Array<{ id: number; date: string }>).map((s) => [s.id, s.date]));

  const state = (evs: Ev[]) => {
    let mob: number | null = null, status = "alive";
    for (const e of evs) {
      if (e.kind === "join") mob = e.mob_id;
      if (e.kind === "leave" && e.mob_id === mob) mob = null;
      if (e.kind === "death") status = "dead";
      if (e.kind === "sale") status = "sold";
      if (e.kind === "gone") status = "gone";
    }
    return { mob, status };
  };
  // A data field's value for an animal: in the given session, or its latest.
  const fieldValue = (() => {
    const q = db.prepare("SELECT session_id, value FROM session_fields WHERE animal_id = ? AND field = ? COLLATE NOCASE");
    return (animalId: number, field: string, session: number | null | undefined) => {
      const rows = q.all(animalId, field) as Array<{ session_id: number; value: string }>;
      if (session) return rows.find((r) => r.session_id === session)?.value ?? null;
      rows.sort((a, b) => (sessionDate.get(a.session_id) ?? "").localeCompare(sessionDate.get(b.session_id) ?? "") || a.session_id - b.session_id);
      return rows.length ? rows[rows.length - 1]!.value : null;
    };
  })();
  const lc = (v: string) => v.trim().toLowerCase();

  const rows: ReportRow[] = [];
  for (const a of animals) {
    const evs = byAnimal.get(a.id) ?? [];
    const st = state(evs);
    let keep = true;
    for (const rule of spec.rules) {
      if (!keep) break;
      switch (rule.kind) {
        case "session": {
          const s = seenIn.get(a.id) ?? new Set<number>();
          const hit = rule.session_ids.some((id) => s.has(id));
          keep = rule.seen ? hit : !hit;
          break;
        }
        case "field": {
          const v = fieldValue(a.id, rule.field, rule.session_id);
          keep = v !== null && (rule.values.length === 0 || rule.values.map(lc).includes(lc(v)));
          break;
        }
        case "sex": {
          const hit = rule.values.includes(a.sex ?? "unknown");
          keep = rule.not ? !hit : hit;
          break;
        }
        case "mob": keep = st.mob !== null && rule.mob_ids.includes(st.mob); break;
        case "status": keep = rule.values.includes(st.status); break;
      }
    }
    if (!keep) continue;
    const weighings = evs.filter((e) => e.kind === "weigh" && e.weight_kg !== null);
    const w = spec.weights_from === "latest"
      ? weighings[weighings.length - 1]
      : [...weighings].reverse().find((e) => e.session_id === spec.weights_from);
    const kg = w?.weight_kg ?? null;
    rows.push({
      id: a.id, tag: a.tag, eid: a.eid, nlis: a.nlis, sex: a.sex ? SEX_LABEL[a.sex] ?? a.sex : null,
      status: st.status, mob: st.mob !== null ? mobName.get(st.mob) ?? null : null,
      weight_kg: kg, weighed: w?.date ?? null, carcass_kg: kg === null ? null : Math.round((kg * pct) / 100),
    });
  }
  rows.sort(spec.sort === "tag"
    ? (x, y) => (x.tag ?? x.eid ?? "").localeCompare(y.tag ?? y.eid ?? "", "en", { numeric: true })
    : (x, y) => (x.weight_kg ?? Infinity) - (y.weight_kg ?? Infinity));

  const stats = (xs: number[]) => xs.length
    ? { count: xs.length, total: Math.round(xs.reduce((t, x) => t + x, 0)), average: Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 100) / 100, min: Math.min(...xs), max: Math.max(...xs) }
    : { count: 0, total: 0, average: null, min: null, max: null };
  return {
    rows,
    stats: {
      head: rows.length,
      weight: stats(rows.map((r) => r.weight_kg).filter((x): x is number => x !== null)),
      carcass: stats(rows.map((r) => r.carcass_kg).filter((x): x is number => x !== null)),
      no_weight: rows.filter((r) => r.weight_kg === null).length,
    },
  };
}

/** What there is to filter on: sessions, data fields and their values, mobs. */
export function reportOptions() {
  const sessions = db.prepare(`
    SELECT s.id, s.name, s.date, s.animal_count, m.name AS mob
    FROM weigh_sessions s LEFT JOIN mobs m ON m.id = s.mob_id ORDER BY s.date DESC, s.id DESC
  `).all();
  const fields = (db.prepare("SELECT field, value, COUNT(*) n FROM session_fields GROUP BY field COLLATE NOCASE, value ORDER BY field, n DESC").all() as Array<{ field: string; value: string; n: number }>)
    .reduce((m, r) => { (m[r.field] ??= []).length < 40 && m[r.field]!.push(r.value); return m; }, {} as Record<string, string[]>);
  const mobs = db.prepare("SELECT id, name FROM mobs WHERE closed_at IS NULL ORDER BY name").all();
  return { sessions, fields, mobs };
}
