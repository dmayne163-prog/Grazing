// Scores how well paddock averages from free Sentinel-2 imagery can reproduce
// the PastureKey figures. Used by sentinel-test.mjs ("analyse").
//
// Three tests, from easiest to hardest:
//   mixed    - readings held out at random (how Cibo reports its own accuracy)
//   paddock  - whole paddocks held out (a paddock the model has never seen)
//   forward  - trained on the first part of the record, tested on the rest
//
// Note what this does and does not show: it measures agreement with Cibo's
// figure, not with cut-and-weighed pasture.

import fs from "node:fs";
import path from "node:path";

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

export function features(b, pg) {
  const r = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v / 10000]));
  const nd = (x, y) => (x - y) / (x + y);
  const idx = {
    ndvi: nd(r.nir, r.red), ndti: nd(r.swir16, r.swir22), ndii: nd(r.nir08, r.swir16), ndre: nd(r.nir, r.rededge1),
    gndvi: nd(r.nir, r.green), bright: mean(Object.values(r)), swir: r.swir22 / r.swir16, rg: r.red / r.green,
  };
  const base = [...Object.values(r), ...Object.values(idx)];
  return [...base, ...base.map((v) => v * v), pg, pg * idx.ndvi, pg * idx.ndti, idx.ndvi * idx.ndti, idx.ndvi * idx.bright];
}

/** Ridge regression on standardised features; returns a predict function. */
export function ridge(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const mu = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const sd = Array.from({ length: p }, (_, j) => Math.sqrt(mean(X.map((r) => (r[j] - mu[j]) ** 2))) || 1);
  const ym = mean(y);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const A = Array.from({ length: p }, () => new Float64Array(p + 1));
  for (let i = 0; i < n; i++) {
    const z = Z[i], d = y[i] - ym;
    for (let j = 0; j < p; j++) { const zj = z[j], row = A[j]; for (let k = j; k < p; k++) row[k] += zj * z[k]; row[p] += zj * d; }
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) A[j][k] = A[k][j]; A[j][j] += lambda; }
  for (let c = 0; c < p; c++) { // Gaussian elimination with partial pivoting
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = c + 1; r < p; r++) { const f = A[r][c] / A[c][c]; if (f) for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  const beta = new Float64Array(p);
  for (let c = p - 1; c >= 0; c--) { let s = A[c][p]; for (let k = c + 1; k < p; k++) s -= A[c][k] * beta[k]; beta[c] = s / A[c][c]; }
  return (x) => ym + x.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * beta[j], 0);
}

function score(pairs) {
  const err = pairs.map(([a, p]) => p - a), act = pairs.map(([a]) => a), am = mean(act);
  const ssr = err.reduce((s, e) => s + e * e, 0), sst = act.reduce((s, a) => s + (a - am) ** 2, 0);
  return { n: pairs.length, medAE: Math.round(median(err.map(Math.abs))), meanAE: Math.round(mean(err.map(Math.abs))), bias: Math.round(mean(err)), r2: Math.round((1 - ssr / sst) * 100) / 100,
    within200: Math.round((100 * err.filter((e) => Math.abs(e) <= 200).length) / err.length), within400: Math.round((100 * err.filter((e) => Math.abs(e) <= 400).length) / err.length) };
}
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };

export async function analyse({ loadPaddocks, CACHE, OUT }) {
  const { paddocks, obs } = loadPaddocks();
  const name = new Map(paddocks.map((p) => [p.id, p.name]));
  const sat = new Map();
  for (const f of fs.readdirSync(CACHE)) {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    for (const [id, p] of Object.entries(j.paddocks)) sat.set(`${id}|${j.date}`, p);
  }
  const all = [];
  for (const o of obs) {
    const s = sat.get(`${o.id}|${o.date}`);
    if (!s || !s.bands || s.clear < 0.9 * s.pixels) continue;
    all.push({ ...o, bands: s.bands, clearShare: s.clear / s.pixels });
  }
  const dates = [...new Set(all.map((r) => r.date))].sort();
  console.log(`PastureKey readings: ${obs.length}; with a clear Sentinel-2 view of the paddock on the same day: ${all.length} (${dates.length} dates, ${new Set(all.map((r) => r.id)).size} paddocks)`);
  // Cibo's own "captured" flag: where it is low the PastureKey figure is carried forward, not measured.
  const rows = all.filter((r) => r.captured == null || r.captured >= 90);
  console.log(`of those, PastureKey itself had a clear capture (>= 90%): ${rows.length}`);

  const ndvi = (b) => (b.nir - b.red) / (b.nir + b.red);
  /** "Persistent green": each paddock's low-point greenness, a stand-in for tree cover. */
  const persistent = (train) => {
    const by = new Map();
    for (const r of train) (by.get(r.id) ?? by.set(r.id, []).get(r.id)).push(ndvi(r.bands));
    const m = new Map([...by].map(([id, v]) => [id, quantile(v, 0.1)]));
    const fallback = median([...m.values()]);
    return (id) => m.get(id) ?? fallback;
  };
  // Persistent green needs imagery only, so a held-out paddock can still use its own.
  const pgAll = persistent(all);

  function run(target, split, pgFor) {
    const pairs = [], preds = new Map();
    for (const { train, test } of split) {
      const pg = pgFor ? pgFor(train) : pgAll;
      const X = train.map((r) => features(r.bands, pg(r.id))), y = train.map((r) => r[target]);
      // pick the penalty on an inner split of the training rows
      let best = { lambda: 1, e: Infinity };
      for (const lambda of [0.1, 1, 10, 100]) {
        let e = 0;
        for (let k = 0; k < 3; k++) {
          const f = ridge(X.filter((_, i) => i % 3 !== k), y.filter((_, i) => i % 3 !== k), lambda);
          X.forEach((x, i) => { if (i % 3 === k) e += Math.abs(f(x) - y[i]); });
        }
        if (e < best.e) best = { lambda, e };
      }
      const f = ridge(X, y, best.lambda);
      for (const r of test) { const p = f(features(r.bands, pg(r.id))); pairs.push([r[target], p]); preds.set(`${r.id}|${r.date}`, p); }
    }
    return { pairs, preds };
  }
  const shuffled = rows.map((r, i) => ({ r, k: (i * 7919) % 10 }));
  const ids = [...new Set(rows.map((r) => r.id))];
  const cut = dates[Math.floor(dates.length * 0.65)];
  const splits = {
    mixed: Array.from({ length: 10 }, (_, k) => ({ train: shuffled.filter((s) => s.k !== k).map((s) => s.r), test: shuffled.filter((s) => s.k === k).map((s) => s.r) })),
    paddock: Array.from({ length: 10 }, (_, k) => ({ train: rows.filter((r) => ids.indexOf(r.id) % 10 !== k), test: rows.filter((r) => ids.indexOf(r.id) % 10 === k) })),
    forward: [{ train: rows.filter((r) => r.date < cut), test: rows.filter((r) => r.date >= cut) }],
  };
  console.log(`forward test: trained on readings before ${cut}, tested from then on`);

  const report = {};
  for (const target of ["tsdm", "green"]) {
    console.log(`\n=== ${target === "tsdm" ? "Total standing dry matter" : "Green dry matter"} (kg/ha) ===`);
    const vals = rows.map((r) => r[target]);
    console.log(`PastureKey range ${Math.min(...vals)} to ${Math.max(...vals)}, middle ${Math.round(median(vals))}`);
    for (const [label, split] of Object.entries(splits)) {
      const res = run(target, split, label === "forward" ? persistent : null);
      const naive = split.flatMap(({ train, test }) => { const m = mean(train.map((r) => r[target])); return test.map((r) => [r[target], m]); });
      report[`${target}:${label}`] = res;
      console.log(label.padEnd(8), JSON.stringify(score(res.pairs)), " | guessing the average:", JSON.stringify(score(naive)));
      // PastureKey figures are themselves steadied from pass to pass, so also score
      // the satellite estimate averaged over each paddock's last three clear passes.
      const steady = [];
      for (const id of ids) {
        const rs = rows.filter((r) => r.id === id && res.preds.has(`${r.id}|${r.date}`)).sort((a, b) => a.date.localeCompare(b.date));
        rs.forEach((r, i) => steady.push([r[target], mean(rs.slice(Math.max(0, i - 2), i + 1).map((q) => res.preds.get(`${q.id}|${q.date}`)))]));
      }
      console.log("  steadied over 3 passes:", JSON.stringify(score(steady)));
    }
  }

  // Does the satellite figure rise and fall with PastureKey inside each paddock?
  for (const target of ["tsdm", "green"]) {
    const preds = report[`${target}:mixed`].preds, cs = [];
    for (const id of ids) {
      const rs = rows.filter((r) => r.id === id && preds.has(`${r.id}|${r.date}`));
      if (rs.length >= 15) cs.push({ id, c: corr(rs.map((r) => r[target]), rs.map((r) => preds.get(`${r.id}|${r.date}`))) });
    }
    cs.sort((a, b) => a.c - b.c);
    console.log(`\n${target}: tracking over time within a paddock (correlation): middle ${median(cs.map((c) => c.c)).toFixed(2)}, worst ${cs.slice(0, 3).map((c) => `${name.get(c.id)} ${c.c.toFixed(2)}`).join(", ")}, best ${cs.slice(-3).map((c) => `${name.get(c.id)} ${c.c.toFixed(2)}`).join(", ")}`);
  }

  // Per-paddock error on unseen paddocks.
  const pp = report["tsdm:paddock"].preds, per = [];
  for (const id of ids) {
    const rs = rows.filter((r) => r.id === id && pp.has(`${r.id}|${r.date}`));
    if (rs.length) per.push({ name: name.get(id), n: rs.length, bias: Math.round(mean(rs.map((r) => pp.get(`${r.id}|${r.date}`) - r.tsdm))), medAE: Math.round(median(rs.map((r) => Math.abs(pp.get(`${r.id}|${r.date}`) - r.tsdm)))) });
  }
  per.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
  console.log("\nunseen-paddock test, largest average misses:", per.slice(0, 8).map((p) => `${p.name} ${p.bias > 0 ? "+" : ""}${p.bias}`).join(", "));
  console.log("paddocks within 200 kg/ha on average:", per.filter((p) => Math.abs(p.bias) <= 200).length, "of", per.length);

  const lines = ["date,paddock,area_ha,pasturekey_tsdm,sentinel_tsdm_mixed,sentinel_tsdm_unseen_paddock,sentinel_tsdm_forward,pasturekey_green,sentinel_green_mixed,pasturekey_captured_pct,sentinel_clear_pct"];
  const area = new Map(paddocks.map((p) => [p.id, p.area_ha]));
  const v = (m, r) => { const p = m.get(`${r.id}|${r.date}`); return p == null ? "" : Math.round(p); };
  for (const r of rows) lines.push([r.date, `"${name.get(r.id)}"`, Math.round(area.get(r.id)), r.tsdm, v(report["tsdm:mixed"].preds, r), v(report["tsdm:paddock"].preds, r), v(report["tsdm:forward"].preds, r), r.green, v(report["green:mixed"].preds, r), r.captured ?? "", Math.round(r.clearShare * 100)].join(","));
  const file = path.join(OUT, "sentinel-vs-pasturekey.csv");
  fs.writeFileSync(file, lines.join("\n"));
  console.log(`\nwrote ${file} (${rows.length} rows)`);
}
