#!/usr/bin/env node
/**
 * Spawns `next dev` on the canonical WMS local port and applies default public URLs
 * when unset, so OAuth / callbacks / absolute links match production layout on localhost.
 *
 * Production parity: set the same keys in Coolify to https://wms.shopcarbon.com (no trailing slash).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

const PORT = 3040;
const LOCAL_ORIGIN = `http://localhost:${PORT}`;

const env = { ...process.env };
if (!String(env.WMS_APP_PUBLIC_BASE_URL ?? "").trim()) {
  env.WMS_APP_PUBLIC_BASE_URL = LOCAL_ORIGIN;
}
if (!String(env.NEXT_PUBLIC_BASE_URL ?? "").trim()) {
  env.NEXT_PUBLIC_BASE_URL = env.WMS_APP_PUBLIC_BASE_URL;
}

const useTurbo = process.argv.includes("--turbo");
const nextArgs = ["dev", "-p", String(PORT), ...(useTurbo ? [] : ["--webpack"])];

const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
