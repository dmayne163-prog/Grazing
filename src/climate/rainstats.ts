/**
 * How this season's rain compares with the long record, from SILO.
 *
 * Every comparison is SILO against SILO, so it's like with like. The gauges
 * are shown beside these figures, never folded into them.
 */
import { climateStatus, propertyDaily, type ClimateStatus } from "./silo.js";

export interface WindowStat {
  days: number;
  from: string;
  to: string;
  mm: number;
  median: number;
  decile: number;     // 1 = driest tenth of years, 10 = wettest tenth
  rank_note: string;  // the Bureau's words for the decile
  years: number;      // how many past years it is compared with
}

export interface ClimateRain {
  status: ClimateStatus;
  monthly: Array<{ month: string; mm: number }>;
  median_by_month: number[];     // January first
  annual: Array<{ year: number; mm: number; complete: boolean }>;
  median_annual: number | null;
  windows: WindowStat[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The Bureau of Meteorology's wording for rainfall deciles. */
export function decileNote(d: number): string {
  if (d <= 1) return "very much below average";
  if (d <= 3) return "below average";
  if (d <= 7) return "average";
  if (d <= 9) return "above average";
  return "very much above average";
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function climateRain(): ClimateRain {
  const status = climateStatus();
  const days = propertyDaily();
  if (!days.length) return { status, monthly: [], median_by_month: [], annual: [], median_annual: null, windows: [] };

  const byMonth = new Map<string, number>();
  const byYear = new Map<number, number>();
  for (const d of days) {
    const m = d.date.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + (d.rain ?? 0));
    const y = Number(d.date.slice(0, 4));
    byYear.set(y, (byYear.get(y) ?? 0) + (d.rain ?? 0));
  }
  const last = days[days.length - 1]!.date;
  const lastYear = Number(last.slice(0, 4));
  const lastMonth = last.slice(0, 7);
  const monthComplete = (m: string) => m < lastMonth || last === endOfMonth(m);

  const medianByMonth = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, "0");
    return r1(median([...byMonth].filter(([m]) => m.endsWith(`-${mm}`) && monthComplete(m)).map(([, v]) => v)));
  });
  const annual = [...byYear].map(([year, mm]) => ({ year, mm: r1(mm), complete: year < lastYear || last.endsWith("-12-31") }));
  const completeYears = annual.filter((a) => a.complete).map((a) => a.mm);

  // Rolling windows ending on the latest day, against the same window in every past year.
  const index = new Map(days.map((d, i) => [d.date, i]));
  const cum: number[] = [0];
  for (const d of days) cum.push(cum[cum.length - 1]! + (d.rain ?? 0));
  const sumTo = (end: string, n: number) => {
    const i = index.get(end);
    if (i === undefined || i + 1 - n < 0) return null;
    return cum[i + 1]! - cum[i + 1 - n]!;
  };
  const windows = [90, 365].map((n): WindowStat => {
    const mm = sumTo(last, n)!;
    const past: number[] = [];
    for (let y = lastYear - 1; y >= 1889; y--) {
      let end = `${y}${last.slice(4)}`;
      if (end.endsWith("-02-29") && !index.has(end)) end = `${y}-02-28`;
      const s = sumTo(end, n);
      if (s !== null) past.push(s);
    }
    const below = past.filter((p) => p < mm).length;
    const decile = past.length ? Math.min(10, Math.floor((below / past.length) * 10) + 1) : 0;
    const from = days[index.get(last)! + 1 - n]!.date;
    return { days: n, from, to: last, mm: r1(mm), median: r1(median(past)), decile, rank_note: decileNote(decile), years: past.length };
  });

  return {
    status,
    monthly: [...byMonth].map(([month, mm]) => ({ month, mm: r1(mm) })),
    median_by_month: medianByMonth,
    annual,
    median_annual: completeYears.length ? r1(median(completeYears)) : null,
    windows,
  };
}

function endOfMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}
