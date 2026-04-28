type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let CURRENT: Level = "info";

export function setLogLevel(level: string): void {
  const lvl = level.toLowerCase() as Level;
  if (lvl in ORDER) CURRENT = lvl;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[CURRENT]) return;
  const ts = new Date().toISOString();
  const head = `${ts} [${level.toUpperCase()}]`;
  if (extra && Object.keys(extra).length > 0) {
    console.log(`${head} ${msg}`, JSON.stringify(extra));
  } else {
    console.log(`${head} ${msg}`);
  }
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
};
