/**
 * Greenness from a paddock camera's picture: the green share of the light
 * (green / (red + green + blue), "GCC") averaged over an area of open grass
 * the user marks on that camera's view: four corners, so it can follow the
 * lie of the land and leave out trees, troughs and tracks. It's the measure
 * the PhenoCam network uses to follow green-up and drying off: steady from day
 * to day with a fixed camera, and comparable only within the same camera.
 *
 * Pictures that can't be trusted are kept but not scored: too dark or blown
 * out, or with next to no colour (the camera's infrared night mode, fog).
 */
import { spawn } from "node:child_process";

/** The area's corners, as fractions of the picture's width and height. */
export type Pt = [number, number];
export type Roi = Pt[];

export interface Greenness { gcc: number; bright: number; colour: number; ok: boolean; why: string | null }

const W = 200, H = 150; // the area's bounding box is read at this size: plenty for an average

/** A box from before areas had four corners: [left, top, right, bottom]. */
const fromBox = (a: number[]): Roi => [[a[0]!, a[1]!], [a[2]!, a[1]!], [a[2]!, a[3]!], [a[0]!, a[3]!]];

/** Reads a stored area: four corners, or an old box. */
export function asRoi(v: unknown): Roi | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 4 && v.every((x) => typeof x === "number")) return fromBox(v as number[]);
  if (v.length >= 3 && v.every((p) => Array.isArray(p) && p.length === 2)) return v as Roi;
  return null;
}

const area = (pts: Roi) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]!; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

/** Checks and tidies the corners sent: four points inside the picture, put in order around their middle so the edges never cross. */
export function cleanRoi(v: unknown): Roi | null {
  if (v === null || v === undefined || v === "") return null;
  const raw = asRoi(v);
  if (!raw || raw.length !== 4) throw new Error("The grass area needs four corners");
  const pts = raw.map((p) => p.map(Number) as Pt);
  if (pts.some((p) => p.some((x) => !Number.isFinite(x) || x < 0 || x > 1))) throw new Error("The grass area's corners must be on the picture");
  const cx = pts.reduce((t, p) => t + p[0], 0) / 4, cy = pts.reduce((t, p) => t + p[1], 0) / 4;
  pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  if (area(pts) < 0.002) throw new Error("The grass area is too small: spread the corners out");
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return pts.map(([x, y]) => [r4(x), r4(y)] as Pt);
}

function inside(x: number, y: number, pts: Roi): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Reads the area's bounding box out of a JPEG with ffmpeg, as raw RGB, and scores the pixels inside the area. */
export function measure(file: string, roi: Roi): Promise<Greenness> {
  const xs = roi.map((p) => p[0]), ys = roi.map((p) => p[1]);
  const l = Math.min(...xs), t = Math.min(...ys), r = Math.max(...xs), b = Math.max(...ys);
  const crop = `crop=iw*${Math.max(0.005, r - l).toFixed(4)}:ih*${Math.max(0.005, b - t).toFixed(4)}:iw*${l.toFixed(4)}:ih*${t.toFixed(4)},scale=${W}:${H}`;
  // Each pixel of the read box, back in the picture's fractions: is it inside the area?
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) mask[j * W + i] = inside(l + ((i + 0.5) / W) * (r - l), t + ((j + 0.5) / H) * (b - t), roi) ? 1 : 0;
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", crop, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const px = Buffer.concat(chunks);
      if (code !== 0 || px.length < W * H * 3) { reject(new Error(`couldn't read the picture${err ? `: ${err.trim().split("\n").pop()}` : ""}`)); return; }
      resolve(score(px, mask));
    });
  });
}

function score(px: Buffer, mask: Uint8Array): Greenness {
  let gccSum = 0, n = 0, bright = 0, colour = 0, count = 0;
  for (let k = 0; k < W * H; k++) {
    if (!mask[k]) continue;
    count++;
    const r = px[k * 3]!, g = px[k * 3 + 1]!, b = px[k * 3 + 2]!;
    const s = r + g + b;
    bright += s / 3;
    colour += Math.max(r, g, b) - Math.min(r, g, b);
    if (s < 30) continue; // black: no colour to read
    gccSum += g / s;
    n++;
  }
  if (!count) return { gcc: 0, bright: 0, colour: 0, ok: false, why: "the area has no pixels" };
  bright /= count; colour /= count;
  const gcc = n ? gccSum / n : 0;
  const why = bright < 35 ? "too dark" : bright > 235 ? "too bright" : colour < 8 ? "no colour (night or fog)" : n < count / 2 ? "mostly black" : null;
  return { gcc: Math.round(gcc * 10000) / 10000, bright: Math.round(bright), colour: Math.round(colour), ok: why === null, why };
}
