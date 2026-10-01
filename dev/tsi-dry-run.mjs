// Dry run of a TSi backup import against a copy of the database.
//   DATA_DIR=<folder holding a COPY of grazing.db> node dev/tsi-dry-run.mjs <WeighScaleCE.db>
// Plans the import, applies it to that copy, and reports what changed. Never
// point DATA_DIR at the live data folder.
const file = process.argv[2];
if (!file || !process.env.DATA_DIR) {
  console.error("usage: DATA_DIR=<copy> node dev/tsi-dry-run.mjs <WeighScaleCE.db>");
  process.exit(1);
}
const { readTsiBackup, planTsi, commitTsi } = await import("../dist/animals/tsi.js");
const { listAnimals } = await import("../dist/animals/store.js");
const { mobViews } = await import("../dist/stock/store.js");
const { db } = await import("../dist/db/database.js");

let t = Date.now();
const b = readTsiBackup(file);
console.log(`read in ${Date.now() - t} ms: ${b.animals.length} animals, ${b.sessions.length} sessions, ${b.events.length} events, backup to ${b.backup_date}`);
t = Date.now();
const plan = planTsi(b);
console.log(`planned in ${Date.now() - t} ms`);
console.log(JSON.stringify({ ...plan, unplaced: undefined, matched_by_mob: undefined, conflicts: undefined }, null, 1));
console.log("\nMobs on hand: head | records before | TSi matched (TSi status)");
for (const m of plan.matched_by_mob) console.log(`${String(m.head).padStart(5)} ${String(m.records_before).padStart(5)} ${String(m.tsi_matched).padStart(5)}  ${m.name} #${m.mob_id} ${JSON.stringify(m.tsi_status)}`);
console.log(`\nIn a mob here but marked dead in TSi: ${plan.conflicts.length}`);
for (const c of plan.conflicts.slice(0, 10)) console.log(`  ${c.tag ?? c.eid} in ${c.mob}: ${c.tsi}`);
console.log(`\nTSi current, not in any mob here (${plan.unplaced_total}), by session last scanned:`);
for (const c of plan.unplaced) console.log(`${String(c.head).padStart(5)}  ${c.date} ${c.name}  ${c.mean_kg ?? "-"} kg  ${JSON.stringify(c.sexes)}  ${c.in_app.map((x) => `${x.count} of that session in ${x.name}`).join("; ")}`);

const before = { mobs: mobViews().map((v) => [v.mob.id, v.state.head]), events: db.prepare("SELECT COUNT(*) n FROM mob_events").get().n };
t = Date.now();
const r = commitTsi(b, { filename: file.split(/[\\/]/).pop() }, "dry-run");
console.log(`\ncommitted in ${Date.now() - t} ms:`, r);
const after = { mobs: mobViews().map((v) => [v.mob.id, v.state.head]), events: db.prepare("SELECT COUNT(*) n FROM mob_events").get().n };
console.log("mob head counts unchanged:", JSON.stringify(before) === JSON.stringify(after));

t = Date.now();
const counts = {};
for (const s of ["onhand", "unplaced", "sold", "dead", "gone", "all"]) counts[s] = listAnimals({ status: s, limit: 1 }).total;
console.log(`animal list (${Date.now() - t} ms for 6 lists):`, counts);
console.log("events by kind:", db.prepare("SELECT kind, COUNT(*) n FROM animal_events WHERE source = 'tsi' GROUP BY 1").all());
