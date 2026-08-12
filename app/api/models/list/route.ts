/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getStoragePublicUrl } from "@/lib/storageProvider";
import { listModelsForUser } from "@/lib/modelsRepository";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

const DEFAULT_SESSION_USER_ID = "00000000-0000-0000-0000-000000000001";
const MODELS_LIST_CACHE_TTL_MS = 8_000;
const modelsListCache = new Map<string, { expiresAt: number; models: any[] }>();

function sanitizeReferenceUrl(value: unknown) {
  if (typeof value !== "string") return "";
  let v = value.trim();
  if (!v) return "";
  v = v.replace(/%0d%0a/gi, "");
  v = v.replace(/%0d/gi, "");
  v = v.replace(/%0a/gi, "");
  v = v.replace(/[\r\n]+/g, "");
  return v.trim();
}

function isTemporaryReferenceUrl(raw: string) {
  const v = String(raw || "").toLowerCase();
  if (!v) return false;
  // Legacy signed object URLs
  if (v.includes("/storage/v1/object/sign/")) return true;
  // Typical signed query fragments
  if (v.includes("token=") || v.includes("x-amz-signature=") || v.includes("x-amz-security-token="))
    return true;
  // Dropbox temporary links
  if (v.includes("dl.dropboxusercontent.com")) return true;
  return false;
}

function extractPathFromStorageUrl(url: string) {
  try {
    const u = new URL(url);
    const markers = [
      "/storage/v1/object/public/",
      "/storage/v1/object/sign/",
      "/storage/v1/object/authenticated/",
    ];
    for (const marker of markers) {
      const idx = u.pathname.indexOf(marker);
      if (idx < 0) continue;
      const rest = u.pathname.slice(idx + marker.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      return decodeURIComponent(rest.slice(slash + 1));
    }
    return "";
  } catch {
    return "";
  }
}

function extractPathFromR2StorageUrl(url: string) {
  try {
    const u = new URL(url);
    const host = String(u.hostname || "").toLowerCase();
    const configuredBucket = String(process.env.R2_BUCKET || "").trim();
    const configuredPublicBase = String(process.env.R2_PUBLIC_URL_BASE || "").trim();
    const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));

    if (host.includes("r2.cloudflarestorage.com")) {
      if (parts.length >= 2) return parts.slice(1).join("/");
      if (configuredBucket && parts.length >= 1) return parts.join("/");
      return "";
    }
    if (host.endsWith(".r2.dev")) return parts.join("/");
    if (configuredPublicBase) {
      try {
        const base = new URL(configuredPublicBase);
        if (host !== String(base.hostname || "").toLowerCase()) return "";
        const baseParts = base.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
        let objectParts = parts;
        if (baseParts.length && parts.length >= baseParts.length) {
          const isPrefix = baseParts.every((seg, idx) => parts[idx] === seg);
          if (isPrefix) objectParts = parts.slice(baseParts.length);
        }
        return objectParts.join("/");
      } catch {
        return "";
      }
    }
    return "";
  } catch {
    return "";
  }
}

function normalizeReferenceUrl(raw: string) {
  const objectPath = extractPathFromStorageUrl(raw) || extractPathFromR2StorageUrl(raw);
  if (!objectPath) return sanitizeReferenceUrl(raw);
  try {
    return getStoragePublicUrl(objectPath);
  } catch {
    return sanitizeReferenceUrl(raw);
  }
}

export async function GET(req: NextRequest) {
  try {
    // WMS auth: authenticated admin session. Models are shared (single tenant),
    // stored under DEFAULT_SESSION_USER_ID.
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const pool = getPool();
    if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
    if (denied) return denied;
    const userId = DEFAULT_SESSION_USER_ID;

    const cached = modelsListCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ models: cached.models });
    }

    const rows = await listModelsForUser(userId);
    const cleaned: any[] = [];

    for (const row of rows) {
      const urls = Array.isArray(row?.ref_image_urls)
        ? row.ref_image_urls
            .map((v: unknown) => sanitizeReferenceUrl(v))
            .filter((v: string) => v.length > 0)
        : [];

      const normalizedUrls: string[] = Array.from(
        new Set<string>(
          urls
            .map((u: string) =>
              isTemporaryReferenceUrl(u) ? normalizeReferenceUrl(u) : sanitizeReferenceUrl(u)
            )
            .filter((value: unknown): value is string => Boolean(value))
        )
      );
      if (normalizedUrls.length < 1) continue;

      cleaned.push({
        ...row,
        ref_image_urls: normalizedUrls,
      });
    }

    modelsListCache.set(userId, { expiresAt: Date.now() + MODELS_LIST_CACHE_TTL_MS, models: cleaned });
    return NextResponse.json({ models: cleaned });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load models" }, { status: 500 });
  }
}
