/**
 * Greenness from a paddock camera's picture: the green share of the light
 * (green / (red + green + blue), "GCC") averaged over a box of open grass the
 * user marks on that camera's view. It's the measure the PhenoCam network uses
 * to follow green-up and drying off: steady from day to day with a fixed
 * camera, and comparable only within the same camera and box.
 *
 * Pictures that can't be trusted are kept but not scored: too dark or blown
 * out, or with next to no colour (the camera's infrared night mode, fog).
 */
import { spawn } from "node:child_process";

/** The box, as fractions of the picture's width and height: [left, top, right, bottom]. */
export type Roi = [number, number, number, number];

export interface Greenness { gcc: number; bright: number; colour: number; ok: boolean; why: string | null }

const W = 160, H = 120; // the box is read at this size: plenty for an average

export function cleanRoi(v: unknown): Roi | null {
  if (v === null || v === undefined || v === "") return null;
  const a = Array.isArray(v) ? v.map(Number) : [];
  if (a.length !== 4 || a.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error("The grass area should be four fractions between 0 and 1");
  const [l, t, r, b] = [Math.min(a[0]!, a[2]!), Math.min(a[1]!, a[3]!), Math.max(a[0]!, a[2]!), Math.max(a[1]!, a[3]!)];
  if (r - l < 0.03 || b - t < 0.03) throw new Error("The grass area is too small: drag a bigger box");
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return [r4(l), r4(t), r4(r), r4(b)];
}

/** Reads the box out of a JPEG with ffmpeg, as raw RGB, and scores it. */
export function measure(file: string, roi: Roi): Promise<Greenness> {
  const [l, t, r, b] = roi;
  const crop = `crop=iw*${(r - l).toFixed(4)}:ih*${(b - t).toFixed(4)}:iw*${l.toFixed(4)}:ih*${t.toFixed(4)},scale=${W}:${H}`;
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
      resolve(score(px));
    });
  });
}

function score(px: Buffer): Greenness {
  let gccSum = 0, n = 0, bright = 0, colour = 0;
  for (let i = 0; i < W * H * 3; i += 3) {
    const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
    const s = r + g + b;
    bright += s / 3;
    colour += Math.max(r, g, b) - Math.min(r, g, b);
    if (s < 30) continue; // black: no colour to read
    gccSum += g / s;
    n++;
  }
  const count = W * H;
  bright /= count; colour /= count;
  const gcc = n ? gccSum / n : 0;
  const why = bright < 35 ? "too dark" : bright > 235 ? "too bright" : colour < 8 ? "no colour (night or fog)" : n < count / 2 ? "mostly black" : null;
  return { gcc: Math.round(gcc * 10000) / 10000, bright: Math.round(bright), colour: Math.round(colour), ok: why === null, why };
}
