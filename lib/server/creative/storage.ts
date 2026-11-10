/**
 * CarbonWMS Creative — files. Everything lives in R2 under creative/ (the bucket is private).
 *
 *   /api/creative/file?p=<path>          admin session only — Radar media (third-party ads are
 *                                        private research, spec §11) and CARBON work in the app.
 *   /api/public/creative/f/<token>       a signed, expiring link to ONE CARBON file, for the AI
 *                                        engines (fal.ai, OpenAI) and the render worker. Radar
 *                                        paths (creative/radar/) can never be signed.
 */
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";

export const WMS_BASE = (process.env.WMS_APP_PUBLIC_BASE_URL || "https://wms.shopcarbon.com").replace(/\/+$/, "");

function secret(): string {
  const s = (process.env.CREATIVE_LINK_SECRET || process.env.SESSION_SECRET || "").trim();
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

/** Tests / local dev only: CREATIVE_STORAGE_DIR keeps files in a local folder instead of R2. */
const LOCAL = (process.env.CREATIVE_STORAGE_DIR || "").trim();

export async function putFile(path: string, bytes: Buffer | Uint8Array, contentType: string): Promise<string> {
  const p = path.replace(/^\/+/, "");
  if (!p.startsWith("creative/") || p.includes("..")) throw new Error("creative files live under creative/");
  if (LOCAL) {
    const f = join(LOCAL, p);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, bytes);
    await writeFile(`${f}.type`, contentType);
    return p;
  }
  await uploadBytesToStorage({ path: p, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), contentType });
  return p;
}

export async function getFile(path: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (LOCAL && !path.includes("..")) {
    const f = join(LOCAL, path);
    return { bytes: await readFile(f), contentType: (await readFile(`${f}.type`, "utf8").catch(() => "")) || "application/octet-stream" };
  }
  const o = await downloadStorageObject(path);
  return { bytes: Buffer.from(o.body), contentType: o.contentType };
}

/** Link for the app (needs the admin session). */
export const appFileUrl = (path: string | null | undefined): string | null => (path ? `/api/creative/file?p=${encodeURIComponent(path)}` : null);

export function isRadarPath(path: string): boolean {
  return path.startsWith("creative/radar/");
}

/** Signed public link (default 6 h) for an engine or the render worker. */
export function signedUrl(path: string, ttlSeconds = 6 * 3600): string {
  if (isRadarPath(path)) throw new Error("Radar media is private and can't be shared");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ p: path, e: exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url").slice(0, 32);
  const ext = path.match(/\.(jpg|jpeg|png|webp|mp4|mp3|wav|m4a|woff2?|ttf|otf)$/i)?.[0] ?? "";
  return `${WMS_BASE}/api/public/creative/f/${body}.${sig}${ext}`;
}

export function verifySigned(token: string): string | null {
  const t = token.replace(/\.(jpg|jpeg|png|webp|mp4|mp3|wav|m4a|woff2?|ttf|otf)$/i, "");
  const parts = t.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret()).update(body).digest("base64url").slice(0, 32);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p: string; e: number };
    if (!v.p || v.e < Date.now() / 1000 || isRadarPath(v.p)) return null;
    if (!/^(creative|models)\//.test(v.p)) return null;
    return v.p;
  } catch {
    return null;
  }
}

/** Download a remote file (engine output, ad media) with a size cap. */
export async function fetchBytes(url: string, maxBytes = 200 * 1024 * 1024, timeoutMs = 120_000): Promise<{ bytes: Buffer; contentType: string }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "CarbonWMS-Creative/1.0" } });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error("file too large");
  const ab = await r.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error("file too large");
  return { bytes: Buffer.from(ab), contentType: r.headers.get("content-type") ?? "application/octet-stream" };
}

export function extFor(contentType: string, fallback = "bin"): string {
  const c = contentType.toLowerCase();
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("mp4")) return "mp4";
  if (c.includes("quicktime")) return "mov";
  if (c.includes("mpeg")) return "mp3";
  if (c.includes("wav")) return "wav";
  return fallback;
}
