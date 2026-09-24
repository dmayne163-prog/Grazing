// Parses a map file with the real importer and prints what it would create.
// Usage: npm run test:import -- <path-to-file>
// Nothing is written to the database.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

process.env.DATA_DIR ??= new URL("../data-test", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const { parseMapFile } = await import("../dist/map/importers.js");

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run test:import -- <file.kml|.kmz|.zip|.json>");
  process.exit(2);
}

const parsed = await parseMapFile(basename(file), readFileSync(file));
const tally = {};
let area = 0;
for (const c of parsed.candidates) {
  const key = `${c.kind}${c.subtype ? "/" + c.subtype : ""} (${c.geometry.type})`;
  tally[key] = (tally[key] ?? 0) + 1;
  if (c.kind === "paddock") area += c.area_ha;
}
console.log(`format: ${parsed.format}`);
console.log(`${parsed.candidates.length} shapes, ${parsed.rejected.length} rejected`);
console.table(tally);
console.log(`paddock area: ${area.toFixed(1)} ha`);
const drift = parsed.candidates
  .filter((c) => c.props.agriwebb_area_ha)
  .map((c) => ({ name: c.name, ha: c.area_ha, agriwebb: c.props.agriwebb_area_ha,
    pct: +((c.area_ha - c.props.agriwebb_area_ha) / c.props.agriwebb_area_ha * 100).toFixed(2) }))
  .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  .slice(0, 5);
if (drift.length) { console.log("largest area differences vs the source:"); console.table(drift); }
for (const r of parsed.rejected.slice(0, 20)) console.log(`rejected: ${r.name} — ${r.reason}`);
