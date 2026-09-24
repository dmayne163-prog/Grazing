import { config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

export function logger(scope: string) {
  return {
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
  };
}
