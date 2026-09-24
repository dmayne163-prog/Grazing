/**
 * AgriWebb's Movement records report, replayed into mob histories.
 *
 * The report has no mob ids and reuses names freely ("Purple Tag UltraBlack X
 * Steers" is five different mobs over the year), so mobs are traced the way a
 * stockman would: each record says which mob, which paddock and how many head
 * it had before, and exactly one live mob fits that description. Replaying
 * every record in time order rebuilds each mob from its creation or purchase
 * through its moves, drafts, merges, sales and deaths.
 *
 * The replay proves itself: the mobs still alive at the end must be exactly
 * the mob list already imported for that day, head for head and paddock for
 * paddock. If they are not, nothing is written.
 *
 * Quirks of the report, learnt from the real thing:
 *  - A merge is two rows at one moment: a Draft/Split on the mob giving the
 *    cattle and a Merge on the mob receiving them.
 *  - A weighing at a sale repeats the sale's head change. Weigh and Stock load
 *    rows therefore never change head; they are attached for the record only.
 *  - Several records often share one timestamp (a mob drafted five ways, then
 *    moved), and their order within it is not given. Records at one moment are
 *    retried until each finds the mob it describes.
 *  - Weights are not in the report at all, only that a weighing happened.
 */
import { db } from "../db/database.js";
import { ImportError } from "../map/importers.js";
import type { MovementRow } from "./agriwebb-xlsx.js";

export interface Lineage {
  key: number;
  name: string;
  breed: string | null;
  tag_colour: string | null;
  age_class: string | null;
  start_at: string;
  start_how: string;
  head: number;
  paddock: string;
  closed: { at: string; why: string } | null;
  events: Array<{ row: MovementRow; to_key?: number; from_key?: number }>;
}

export interface Replay {
  lineages: Lineage[];
  notes: string[];
  first: string | null;
  last: string | null;
}

const ORDERED_EVENTS = new Set([
  "Move", "Death", "Sale", "Purchased", "Draft/Split", "Created from draft/split", "Merge",
  "Recount", "Created", "Transfer off farm", "Weigh", "Stock load",
]);

export function replayMovements(rows: MovementRow[]): Replay {
  const notes: string[] = [];
  const unknown = [...new Set(rows.map((r) => r.event).filter((e) => !ORDERED_EVENTS.has(e)))];
  if (unknown.length) {
    throw new ImportError(`The report has record types this app does not know yet: ${unknown.join(", ")}`);
  }

  // The file is newest first; within one timestamp its order is reversed too.
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : b.i - a.i));

  let nextKey = 1;
  const live: Lineage[] = [];
  const all: Lineage[] = [];
  const same = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

  const start = (r: MovementRow, head: number, paddock: string, how: string): Lineage => {
    const l: Lineage = {
      key: nextKey++, name: r.mob, breed: r.breed, tag_colour: r.tag_colour, age_class: r.age_class,
      start_at: r.at, start_how: how, head, paddock, closed: null, events: [{ row: r }],
    };
    live.push(l);
    all.push(l);
    return l;
  };

  const find = (r: MovementRow, paddock: string, head: number): Lineage | null => {
    const named = live.filter((l) => l.name === r.mob);
    const exact = named.find((l) => same(l.paddock, paddock) && l.head === head);
    if (exact) return exact;
    const byHead = named.filter((l) => l.head === head);
    if (byHead.length === 1) {
      notes.push(`${r.at} ${r.event} for ${r.mob} (${head} hd) names ${paddock}, but that mob was in ${byHead[0]!.paddock}.`);
      return byHead[0]!;
    }
    return null;
  };

  let lastPass = false;
  const apply = (r: MovementRow): boolean => {
    const from = r.event === "Move" || r.event === "Draft/Split" ? r.moved_from ?? r.paddock ?? "" : r.paddock ?? "";

    if (r.event === "Created" || (r.event === "Purchased" && r.head_before === 0)) {
      start(r, r.head_after, r.paddock ?? "", r.event);
      return true;
    }
    if (r.event === "Created from draft/split") {
      start(r, r.head_after, r.moved_to ?? r.paddock ?? "", "split");
      return true;
    }
    if (r.event === "Weigh" || r.event === "Stock load") {
      const named = [...live, ...all.filter((l) => l.closed?.at === r.at)].filter((l) => l.name === r.mob);
      const l = named.find((x) => x.head === r.head_before || x.head === r.head_after)
        ?? named.find((x) => same(x.paddock, r.paddock));
      if (l) { l.events.push({ row: r }); return true; }
      if (lastPass) { notes.push(`${r.at} ${r.event} for ${r.mob}: no mob to attach it to, left out.`); return true; }
      return false;
    }

    const l = find(r, from, r.head_before);
    if (!l) return false;
    l.events.push({ row: r });
    if (r.event === "Move") l.paddock = r.moved_to ?? l.paddock;
    l.head = r.head_after;
    if (l.head === 0) {
      l.closed = { at: r.at, why: r.event };
      live.splice(live.indexOf(l), 1);
    }
    return true;
  };

  const groups = new Map<string, MovementRow[]>();
  for (const r of sorted) groups.set(r.at, [...(groups.get(r.at) ?? []), r]);

  for (const [at, group] of groups) {
    let pending = group;
    lastPass = false;
    while (pending.length) {
      const before = pending.length;
      pending = pending.filter((r) => !apply(r));
      if (pending.length === before) {
        if (lastPass) break;
        lastPass = true;
      }
    }
    for (const r of pending) {
      // Nothing fits: the mob existed before the records begin.
      const paddock = r.event === "Move" || r.event === "Draft/Split" ? r.moved_from ?? r.paddock ?? "" : r.paddock ?? "";
      notes.push(`${at}: ${r.mob}, ${r.head_before} hd in ${paddock}, first appears on a ${r.event} — treated as already on hand.`);
      const l = start({ ...r, event: "Existing" }, r.head_before, paddock, "existing");
      l.events = [];
      apply(r);
    }
    pairTransfers(group, all);
  }

  return {
    lineages: all,
    notes,
    first: sorted[0]?.at ?? null,
    last: sorted[sorted.length - 1]?.at ?? null,
  };
}

/**
 * Links each Draft/Split to where its cattle went — a new mob or a merge into
 * an existing one — so a history can say "drafted 56 hd to the Yards mob".
 */
function pairTransfers(group: MovementRow[], all: Lineage[]) {
  const owner = new Map<MovementRow, Lineage>();
  for (const l of all) for (const e of l.events) if (group.includes(e.row)) owner.set(e.row, l);

  const receivers = group.filter((r) => r.event === "Created from draft/split" || r.event === "Merge");
  const taken = new Set<MovementRow>();
  for (const d of group.filter((r) => r.event === "Draft/Split")) {
    const n = -d.change;
    const to = (d.moved_to ?? "").toLowerCase();
    const rec = receivers.find((r) => !taken.has(r) && r.change === n &&
      ((r.moved_to ?? r.paddock ?? "").toLowerCase() === to || (r.paddock ?? "").toLowerCase() === to));
    if (!rec) continue;
    taken.add(rec);
    const dl = owner.get(d), rl = owner.get(rec);
    if (!dl || !rl) continue;
    const de = dl.events.find((e) => e.row === d);
    const re = rl.events.find((e) => e.row === rec);
    if (de) de.to_key = rl.key;
    if (re) re.from_key = dl.key;
  }
}

/* ------------------------------ writing it -------------------------------- */

interface ExistingMob {
  id: number;
  name: string;
  owner: string | null;
  agriwebb_name: string | null;
  opening_date: string;
  opening_head: number;
  opening_first_paddock: number | null;
}

/** Mobs brought in from the mob list, and where the list put them. */
function snapshotMobs(): ExistingMob[] {
  const rows = db.prepare(`
    SELECT m.id, m.name, m.owner, m.data, e.date, e.head, e.paddock_ids
    FROM mobs m JOIN mob_events e ON e.mob_id = m.id AND e.kind = 'opening' AND e.source LIKE 'import:%'
    WHERE m.closed_at IS NULL
  `).all() as Array<{ id: number; name: string; owner: string | null; data: string; date: string; head: number; paddock_ids: string }>;
  return rows.map((r) => {
    const data = JSON.parse(r.data) as Record<string, unknown>;
    const ids = JSON.parse(r.paddock_ids) as number[];
    return {
      id: r.id, name: r.name, owner: r.owner,
      agriwebb_name: typeof data["agriwebb_name"] === "string" ? data["agriwebb_name"] : null,
      opening_date: r.date, opening_head: r.head, opening_first_paddock: ids[0] ?? null,
    };
  });
}

export function historyAlreadyImported(): boolean {
  return !!db.prepare("SELECT 1 FROM mob_events WHERE source LIKE 'agriwebb-history:%' LIMIT 1").get();
}

export interface HistoryPlan {
  /** Live lineage key → existing mob id. */
  matched: Array<{ key: number; mob_id: number; mob_name: string }>;
  unmatched_live: string[];
  unmatched_mobs: string[];
  unknown_paddocks: string[];
  closed: number;
  ok: boolean;
}

export function planHistory(replay: Replay, paddockIdByName: (n: string) => number | null): HistoryPlan {
  const names = new Set<string>();
  for (const l of replay.lineages) {
    names.add(l.paddock);
    for (const e of l.events) {
      for (const n of [e.row.paddock, e.row.moved_from, e.row.moved_to]) if (n) names.add(n);
    }
  }
  const unknown_paddocks = [...names].filter((n) => n && paddockIdByName(n) === null);

  const snaps = snapshotMobs();
  const free = [...snaps];
  const matched: HistoryPlan["matched"] = [];
  const unmatched_live: string[] = [];
  for (const l of replay.lineages.filter((x) => !x.closed)) {
    const pid = paddockIdByName(l.paddock);
    const i = free.findIndex((m) =>
      (m.agriwebb_name ?? m.name) === l.name && m.opening_head === l.head && m.opening_first_paddock === pid);
    if (i < 0) {
      unmatched_live.push(`${l.name}, ${l.head} hd in ${l.paddock}`);
      continue;
    }
    matched.push({ key: l.key, mob_id: free[i]!.id, mob_name: free[i]!.name });
    free.splice(i, 1);
  }
  return {
    matched,
    unmatched_live,
    unmatched_mobs: free.map((m) => `${m.name}, ${m.opening_head} hd`),
    unknown_paddocks,
    closed: replay.lineages.filter((l) => l.closed).length,
    ok: unknown_paddocks.length === 0 && unmatched_live.length === 0 && free.length === 0,
  };
}

function sexFromClass(ageClass: string | null, name: string): string | null {
  const text = `${ageClass ?? ""} ${name}`.toLowerCase();
  const female = /heifer|\bcows?\b/.test(text);
  const steer = /steer/.test(text);
  const bull = /\bbulls?\b/.test(text);
  if ([female, steer, bull].filter(Boolean).length !== 1) return null;
  return female ? "female" : steer ? "steer" : "male";
}

/**
 * Owners for mobs that no longer exist, inferred from the mobs they split
 * from or merged with. A family of mobs whose surviving members all belong to
 * one owner is taken to be that owner's; anything mixed or entirely gone is
 * left as own stock.
 */
function inferOwners(replay: Replay, ownerOfLive: Map<number, string | null>): Map<number, string | null> {
  const parent = new Map<number, number>();
  const root = (k: number): number => {
    let r = k;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  for (const l of replay.lineages) {
    for (const e of l.events) {
      const other = e.to_key ?? e.from_key;
      if (other === undefined) continue;
      const a = root(l.key), b = root(other);
      if (a !== b) parent.set(a, b);
    }
  }
  const owners = new Map<number, Set<string | null>>();
  for (const [key, owner] of ownerOfLive) {
    const r = root(key);
    if (!owners.has(r)) owners.set(r, new Set());
    owners.get(r)!.add(owner);
  }
  const out = new Map<number, string | null>();
  for (const l of replay.lineages) {
    const set = owners.get(root(l.key));
    out.set(l.key, set && set.size === 1 ? [...set][0]! : null);
  }
  return out;
}

const DATE = (at: string) => at.slice(0, 10);

export function commitHistory(
  replay: Replay, plan: HistoryPlan, importId: number,
  paddockIdByName: (n: string) => number, username: string | null
): { mobsCreated: number; eventsWritten: number } {
  if (!plan.ok) throw new ImportError("The history does not line up with the current mobs; see the review.");
  if (historyAlreadyImported()) throw new ImportError("Movement history has already been imported.");

  const source = `agriwebb-history:${importId}`;
  const now = Date.now();
  const keyToMob = new Map<number, number>(plan.matched.map((m) => [m.key, m.mob_id]));
  const liveOwner = new Map<number, string | null>();
  for (const m of plan.matched) {
    const row = db.prepare("SELECT owner FROM mobs WHERE id = ?").get(m.mob_id) as { owner: string | null };
    liveOwner.set(m.key, row.owner);
  }
  const owners = inferOwners(replay, liveOwner);

  return db.transaction(() => {
    let mobsCreated = 0;
    let eventsWritten = 0;

    // Mobs that ended during the period get rows of their own, closed.
    const insMob = db.prepare(`
      INSERT INTO mobs (name, species, breed, age_class, sex, tag_colour, origin, owner, data, source,
        created_at, updated_at, closed_at)
      VALUES (?, 'Cattle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of replay.lineages) {
      if (keyToMob.has(l.key)) continue;
      const closedAt = l.closed ? Date.parse(`${l.closed.at.replace(" ", "T")}:00`) : now;
      const r = insMob.run(
        l.name, l.breed, l.age_class, sexFromClass(l.age_class, l.name), l.tag_colour,
        l.start_how === "Purchased" ? "Purchased" : null, owners.get(l.key) ?? null,
        JSON.stringify({
          agriwebb_name: l.name,
          history: `${DATE(l.start_at)} to ${l.closed ? DATE(l.closed.at) : "now"}`,
          ended_by: l.closed?.why ?? null,
        }),
        source, now, now, closedAt
      );
      keyToMob.set(l.key, Number(r.lastInsertRowid));
      mobsCreated++;
    }

    const insEvent = db.prepare(`
      INSERT INTO mob_events (mob_id, date, kind, head, head_change, weight_kg, adg_kg, paddock_ids,
        data, source, username, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    `);
    const pid = (n: string | null) => (n ? paddockIdByName(n) : null);

    for (const l of replay.lineages) {
      const mobId = keyToMob.get(l.key)!;
      for (const [idx, e] of l.events.entries()) {
        const r = e.row;
        const base: Record<string, unknown> = { agriwebb_event: r.event, at: r.at };
        if (r.user) base["recorded_by"] = r.user;
        if (e.to_key) base["to_mob"] = keyToMob.get(e.to_key);
        if (e.from_key) base["from_mob"] = keyToMob.get(e.from_key);

        let kind: string, head: number | null = null, change: number | null = null;
        let paddocks: number[] | null = null;
        const isStart = idx === 0 && l.start_how !== "existing";

        if (isStart) {
          kind = "opening";
          head = r.head_after;
          const p = pid(r.event === "Created from draft/split" ? r.moved_to ?? r.paddock : r.paddock);
          paddocks = p ? [p] : null;
          if (r.event === "Purchased") base["purchased"] = true;
        } else {
          switch (r.event) {
            case "Move": {
              kind = "move";
              const p = pid(r.moved_to);
              paddocks = p ? [p] : null;
              break;
            }
            case "Draft/Split":
              kind = "transfer";
              change = r.change;
              base["to_paddock"] = r.moved_to;
              break;
            case "Merge":
              kind = "transfer";
              change = r.change;
              break;
            case "Purchased": kind = "purchase"; change = r.change; break;
            case "Sale": kind = "sale"; change = r.change; break;
            case "Death": kind = "death"; change = r.change; break;
            case "Transfer off farm": kind = "transfer"; change = r.change; base["off_farm"] = true; break;
            case "Recount": kind = "count"; head = r.head_after; break;
            case "Weigh": kind = "weigh"; base["note"] = "Weighed; the weight is not in AgriWebb's movement report"; break;
            default: continue; // Stock load: nothing to keep
          }
        }
        insEvent.run(
          mobId, DATE(r.at), kind, head, change, paddocks ? JSON.stringify(paddocks) : null,
          JSON.stringify(base), source, username, now
        );
        eventsWritten++;
      }
      // A mob that was already on hand when records began needs an opening.
      if (l.start_how === "existing") {
        const p = pid(l.events[0]?.row.moved_from ?? l.events[0]?.row.paddock ?? null);
        insEvent.run(
          mobId, DATE(l.start_at), "opening", l.events[0]?.row.head_before ?? 0, null,
          p ? JSON.stringify([p]) : null, JSON.stringify({ agriwebb_event: "on hand when records began" }),
          source, username, now
        );
        eventsWritten++;
      }
    }
    return { mobsCreated, eventsWritten };
  })();
}
