/**
 * Upload files to the owner's Dropbox.
 *
 * Uses the same Dropbox app as carbon-gen (DROPBOX_APP_KEY / DROPBOX_APP_SECRET)
 * with a long-lived refresh token for the owner's account (DROPBOX_REFRESH_TOKEN).
 * Paths are relative to the account's home folder ("/elior perez" in the team
 * space), so "/Carbon/Elior/CarbonGradingAI" is the folder the owner made for
 * CarbonGradingAI scan photos (2026-10-13).
 *
 * Nothing here is on the save path's critical line: a scan is safe in R2 and
 * the database before its Dropbox copy is attempted, and a failed copy is
 * retried on the next save.
 */

let cached: { token: string; until: number } | null = null;

export function isDropboxConfigured(): boolean {
  return Boolean(
    (process.env.DROPBOX_APP_KEY || "").trim() &&
      (process.env.DROPBOX_APP_SECRET || "").trim() &&
      (process.env.DROPBOX_REFRESH_TOKEN || "").trim(),
  );
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: (process.env.DROPBOX_REFRESH_TOKEN || "").trim(),
    client_id: (process.env.DROPBOX_APP_KEY || "").trim(),
    client_secret: (process.env.DROPBOX_APP_SECRET || "").trim(),
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`Dropbox sign-in failed: ${j.error_description || j.error || res.status}`);
  cached = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** Dropbox refuses a few characters in names; keep names readable. */
export function dropboxSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "item";
}

/** Upload bytes to `path` (overwrites). Returns the stored path. */
export async function dropboxUpload(path: string, bytes: Buffer | Uint8Array): Promise<string> {
  const token = await accessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      // Non-ASCII in the header must be escaped (Dropbox's documented rule).
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }).replace(
        /[\u007f-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const j = (await res.json().catch(() => ({}))) as { path_display?: string };
  return j.path_display || path;
}

export function gradingDropboxRoot(): string {
  return ((process.env.CARBONGRADINGAI_DROPBOX_DIR || "/Carbon/Elior/CarbonGradingAI").trim().replace(/\/+$/, "")) || "/Carbon/Elior/CarbonGradingAI";
}
