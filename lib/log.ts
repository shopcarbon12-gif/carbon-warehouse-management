type Level = "info" | "warn" | "error";

/** Minimal structured logs for Coolify / Docker (`docker logs`). */
export function wmsLog(level: Level, event: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
