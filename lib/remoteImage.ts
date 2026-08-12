/* eslint-disable @typescript-eslint/no-explicit-any */
import net from "node:net";
// Allow-list the R2 host so Carbon Studio can read model reference images.
// The account's S3 endpoint (needs auth — the caller falls back to the S3
// client) plus any configured public base.
function getR2AllowedHost(): string {
  const acct = (process.env.R2_ACCOUNT_ID || "").trim();
  if (acct) return `${acct}.r2.cloudflarestorage.com`;
  return (process.env.R2_PUBLIC_URL_BASE || "").trim().replace(/^https?:\/\//, "").split("/")[0] || "";
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 12000;

function parseNumericEnv(value: string | undefined, fallback: number) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getImageFetchMaxBytes() {
  return parseNumericEnv(process.env.IMAGE_FETCH_MAX_BYTES, DEFAULT_MAX_BYTES);
}

export function getImageFetchTimeoutMs() {
  return parseNumericEnv(process.env.IMAGE_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function getAllowedHosts() {
  const raw =
    process.env.ALLOWED_IMAGE_HOSTS ||
    process.env.IMAGE_ALLOWED_HOSTS ||
    process.env.IMAGE_FETCH_ALLOWED_HOSTS ||
    "";
  const entries = raw
    .split(/[,\s]+/g)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  // Always allow standard Shopify CDN hosts for catalog media and alt-generation flows.
  for (const host of ["cdn.shopify.com", "cdn.shopifycdn.net"]) {
    if (!entries.includes(host)) entries.push(host);
  }
  const allowAny = entries.includes("*");
  const r2Host = getR2AllowedHost();
  if (r2Host && !entries.includes(r2Host.toLowerCase())) {
    entries.push(r2Host.toLowerCase());
  }
  return { entries, allowAny };
}

function isLocalHostname(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  );
}

function isPrivateIp(hostname: string) {
  const ipType = net.isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (ipType === 6) {
    const lower = hostname.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:127.")) return true;
    return false;
  }
  return false;
}

function isHostAllowed(hostname: string) {
  const isProd = process.env.NODE_ENV === "production";
  const host = hostname.toLowerCase();
  if (isLocalHostname(host)) return false;
  if (isPrivateIp(host)) return false;

  const { entries, allowAny } = getAllowedHosts();
  if (allowAny) return true;
  if (!entries.length) return !isProd;

  for (const entry of entries) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === entry) return true;
  }
  return false;
}

export function assertDataUrlSize(dataUrl: string, maxBytes = getImageFetchMaxBytes()) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid data URL.");
  }
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const size = Math.floor((b64.length * 3) / 4) - padding;
  if (size > maxBytes) {
    throw new Error(`Data URL too large (${size} bytes).`);
  }
}

export function normalizeRemoteImageUrl(
  raw: string,
  options?: { allowDataUrl?: boolean }
) {
  const cleaned = String(raw || "")
    .replace(/%0d%0a/gi, "")
    .replace(/%0d/gi, "")
    .replace(/%0a/gi, "")
    .replace(/[\r\n]+/g, "")
    .trim();
  if (!cleaned) throw new Error("Missing image URL.");

  if (cleaned.startsWith("data:image/")) {
    if (!options?.allowDataUrl) {
      throw new Error("Data URLs are not allowed.");
    }
    assertDataUrlSize(cleaned);
    return cleaned;
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials are not allowed in URLs.");
  }

  const host = parsed.hostname || "";
  if (!isHostAllowed(host)) {
    throw new Error(`Image host not allowed (${host}).`);
  }

  return parsed.toString();
}

async function readResponseBytes(resp: Response, maxBytes: number) {
  if (!resp.body) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`Image too large (${buf.length} bytes).`);
    }
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`Image too large (${total} bytes).`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks, total);
}

export async function fetchRemoteImageBytes(
  url: string,
  options?: { timeoutMs?: number; maxBytes?: number; headers?: HeadersInit }
) {
  const timeoutMs = options?.timeoutMs ?? getImageFetchTimeoutMs();
  const maxBytes = options?.maxBytes ?? getImageFetchMaxBytes();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0",
        ...options?.headers,
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Image fetch failed (${resp.status}).`);
    }

    const length = Number(resp.headers.get("content-length") || 0);
    if (length && length > maxBytes) {
      throw new Error(`Image too large (${length} bytes).`);
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const bytes = await readResponseBytes(resp, maxBytes);
    return { bytes, contentType };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Image fetch timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
