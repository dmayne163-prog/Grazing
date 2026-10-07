/**
 * The automatic rain gauge: a tipping bucket (RIMCO 7499-STD, 0.2 mm a tip)
 * wired to a digital input on a Cerbo GX set to "Pulse meter".
 *
 * The Cerbo counts the tips and publishes its running count over "MQTT on
 * LAN". Each rise in the count is kept in rain_tips with when it arrived, and
 * that rain day's reading for the gauge is summed again from them. Days run
 * 9am to 9am and are booked to the day they end, like the Bureau, SILO and a
 * manual gauge read at 9am — so the two gauges compare day for day.
 *
 * The count is the record, not the messages: if the app is down or the link
 * drops, the Cerbo keeps counting and the difference is booked when it's back
 * (to the rain day it's back in, the one thing an outage can shift).
 */
import mqtt, { type MqttClient } from "mqtt";
import { config } from "../config.js";
import { addEvent, db, getSetting, setSetting } from "../db/database.js";
import { logger } from "../logger.js";
import { addReading, ensureGauge } from "./store.js";

const log = logger("autogauge");

/** Venus stops publishing unless asked again within 60 s. */
const KEEPALIVE_MS = 30_000;
/** More than this many tips at once (500 mm) is a counter gone wrong, not rain. */
const MAX_TIPS = 2_500;
const HOUR = 3_600_000;

const status = {
  connected: false,
  error: null as string | null,
  portalId: null as string | null,
  /** Pulse meters the Cerbo reports, by instance. */
  meters: new Map<number, number>(),
  lastMessageAt: null as number | null,
};

interface Last { instance: number; count: number }
const lastCount = (): Last | null => {
  const s = getSetting("rain_auto_last");
  return s ? (JSON.parse(s) as Last) : null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The rain day a moment belongs to: the 24 hours to 9am, booked to that date. */
export function rainDayOf(ts: number): string {
  return ymd(new Date(ts + 15 * HOUR));
}

/** When a rain day starts and ends, in ms: 9am the day before to 9am on the day. */
function rainDayWindow(day: string): [number, number] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const end = new Date(y, m - 1, d, 9).getTime();
  return [end - 24 * HOUR, end];
}

/** The most rain in any 60 minutes of these tips, in mm per hour. */
function peakHour(tips: Array<{ ts: number; tips: number }>): number {
  let best = 0, sum = 0, i = 0;
  for (const t of tips) {
    sum += t.tips;
    while (tips[i]!.ts <= t.ts - HOUR) sum -= tips[i++]!.tips;
    best = Math.max(best, sum);
  }
  return best * config.rainMmPerTip;
}

/** Sum a rain day's tips into the gauge's reading for it. */
function rebuildDay(day: string) {
  const [from, to] = rainDayWindow(day);
  const tips = db.prepare("SELECT ts, tips FROM rain_tips WHERE ts >= ? AND ts < ? ORDER BY ts").all(from, to) as Array<{ ts: number; tips: number }>;
  const total = tips.reduce((t, x) => t + x.tips, 0);
  const mm = Math.round(total * config.rainMmPerTip * 10) / 10;
  const peak = peakHour(tips);
  const note = `${total} tip${total === 1 ? "" : "s"}${peak >= 1 ? `; heaviest ${Math.round(peak * 10) / 10} mm in an hour` : ""}`;
  const gauge = ensureGauge(config.rainGaugeName);
  const row = db.prepare("SELECT id FROM rain_readings WHERE gauge_id = ? AND date = ? AND source = 'cerbo'").get(gauge, day) as { id: number } | undefined;
  if (row) db.prepare("UPDATE rain_readings SET mm = ?, note = ? WHERE id = ?").run(mm, note, row.id);
  else if (total > 0) addReading(gauge, day, "09:00", mm, note, "cerbo", null);
}

/**
 * A count from the Cerbo. The first one only sets where counting starts; after
 * that each rise is rain. A fall means the counter was reset (the Cerbo was
 * restored, or the input reconfigured), and the new count is tips since then.
 */
export function recordCount(instance: number, count: number, ts = Date.now()) {
  count = Math.round(count);
  if (!Number.isFinite(count) || count < 0) return;
  const last = lastCount();
  const save = () => setSetting("rain_auto_last", JSON.stringify({ instance, count }));
  if (!last || last.instance !== instance) {
    save();
    log.info(`counting from ${count} on pulse meter ${instance}`);
    return;
  }
  if (count === last.count) return;
  let tips = count - last.count;
  if (tips < 0) {
    log.warn(`pulse count fell from ${last.count} to ${count}: taken as a reset`);
    tips = count;
  }
  if (tips > MAX_TIPS) {
    log.warn(`pulse count jumped by ${tips}: ignored, counting from ${count}`);
    addEvent({ ts, source: "rain", kind: "autogauge-jump", severity: "warn",
      message: `The automatic gauge's count jumped by ${tips} tips at once — ignored as a fault`, value: String(count) });
    save();
    return;
  }
  db.transaction(() => {
    if (tips > 0) db.prepare("INSERT INTO rain_tips (ts, tips, count) VALUES (?, ?, ?)").run(ts, tips, count);
    save();
    if (tips > 0) rebuildDay(rainDayOf(ts));
  })();
}

/** What the Rain tab shows about the automatic gauge. */
export function autoGaugeStatus() {
  const last = lastCount();
  const tip = db.prepare("SELECT MAX(ts) ts FROM rain_tips").get() as { ts: number | null };
  const today = rainDayOf(Date.now());
  const [from] = rainDayWindow(today);
  const sinceNine = (db.prepare("SELECT IFNULL(SUM(tips), 0) n FROM rain_tips WHERE ts >= ?").get(from) as { n: number }).n;
  return {
    configured: !!config.rainCerboHost,
    gauge: config.rainGaugeName,
    connected: status.connected,
    error: status.error,
    meters: [...status.meters.keys()].sort((a, b) => a - b),
    instance: last?.instance ?? null,
    count: last?.count ?? null,
    last_tip_at: tip.ts,
    since_9am_mm: Math.round(sinceNine * config.rainMmPerTip * 10) / 10,
    mm_per_tip: config.rainMmPerTip,
  };
}

/** Which pulse meter is the gauge: the configured one, else the lowest seen. */
function chosenMeter(): number | null {
  if (config.rainPulseInstance !== "") return Number(config.rainPulseInstance);
  const seen = [...status.meters.keys()].sort((a, b) => a - b);
  return seen[0] ?? null;
}

export function startAutoGauge(): MqttClient | null {
  if (!config.rainCerboHost) return null;
  const url = `mqtt://${config.rainCerboHost}:${config.rainCerboPort}`;
  const client = mqtt.connect(url, {
    reconnectPeriod: 10_000,
    connectTimeout: 10_000,
    clientId: `grazing-rain-${Math.random().toString(16).slice(2, 10)}`,
  });
  let keepalive: NodeJS.Timeout | null = null;
  let errors = 0;

  const subscribeMeters = () => {
    const pid = status.portalId;
    if (!pid) return;
    client.subscribe(`N/${pid}/pulsemeter/+/Count`);
    const ask = () => { if (client.connected) client.publish(`R/${pid}/keepalive`, ""); };
    ask();
    if (keepalive) clearInterval(keepalive);
    keepalive = setInterval(ask, KEEPALIVE_MS);
  };

  client.on("connect", () => {
    log.info(`connected to the Cerbo for the rain gauge`);
    status.connected = true;
    status.error = null;
    errors = 0;
    if (status.portalId) subscribeMeters();
    else client.subscribe("N/+/system/0/Serial");
  });
  client.on("close", () => {
    if (status.connected) log.warn("lost the Cerbo; the gauge keeps counting and is caught up on reconnect");
    status.connected = false;
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
  });
  client.on("error", (e) => {
    status.error = e.message;
    if (errors++ % 60 === 0) log.error(`cannot reach the rain gauge's Cerbo: ${e.message}`);
  });
  client.on("message", (topic, payload) => {
    const p = topic.split("/");
    status.lastMessageAt = Date.now();
    if (!status.portalId && p[2] === "system" && p[4] === "Serial") {
      status.portalId = p[1]!;
      client.unsubscribe("N/+/system/0/Serial");
      subscribeMeters();
      return;
    }
    if (p[1] !== status.portalId || p[2] !== "pulsemeter" || p[4] !== "Count") return;
    const instance = Number(p[3]);
    let value: unknown = null;
    try { value = (JSON.parse(String(payload)) as { value?: unknown }).value; } catch { return; }
    if (typeof value !== "number") return;
    if (!status.meters.has(instance)) log.info(`pulse meter ${instance} found, count ${value}`);
    status.meters.set(instance, value);
    if (instance === chosenMeter()) {
      try { recordCount(instance, value); } catch (e) { log.error("recording rain tips failed", e); }
    }
  });
  return client;
}
