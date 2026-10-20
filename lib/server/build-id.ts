import { readFileSync } from "node:fs";
import path from "node:path";

/** The running build's id (Next writes .next/BUILD_ID), so an open page can
    tell it is older than the server (owner 2026-10-20: a stale tab kept old
    Bulk Studio code running after a fix went live). "" when unknown. */
let cached: string | null = null;
export function getBuildId(): string {
  if (cached !== null) return cached;
  try {
    cached = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    cached = "";
  }
  return cached;
}
