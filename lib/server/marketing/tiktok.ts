/**
 * Social → TikTok (owner, 2026-10-25: "lets connect tiktok").
 *
 * Needs a TikTok for Developers app with Login Kit + Content Posting API
 * (Direct Post): TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET on the web app AND
 * the worker (the worker publishes). Its redirect URI is
 *   <PUBLIC_BASE>/api/marketing/channels/tiktok/callback
 * and the URL prefix <PUBLIC_BASE>/api/public/marketing-media/ must be
 * verified with TikTok (TikTok pulls the pictures and videos from there). The
 * verification file is served from TIKTOK_VERIFY_FILENAME / TIKTOK_VERIFY_CONTENT.
 *
 * Until TikTok audits the app, it only allows SELF_ONLY (private) posts to a
 * private account — the creator-info query says which privacy levels are open
 * and we use the most public one allowed.
 *
 * Tokens (24 h access, 365 d refresh) are kept sealed in
 * marketing_channels.secret and refreshed before they run out.
 */
import type { Pool } from "pg";
import { open, seal } from "@/lib/server/secret-box";
import { PUBLIC_BASE } from "./store";

const API = "https://open.tiktokapis.com/v2";
export const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() && process.env.TIKTOK_CLIENT_SECRET?.trim());
}

export function tiktokRedirectUri(): string {
  return `${PUBLIC_BASE}/api/marketing/channels/tiktok/callback`;
}

export function tiktokAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
    scope: TIKTOK_SCOPES,
    response_type: "code",
    redirect_uri: tiktokRedirectUri(),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

type Tokens = { access: string; refresh: string; expiresAt: number; refreshExpiresAt: number; openId: string; scope: string };

async function tokenCall(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!.trim(), client_secret: process.env.TIKTOK_CLIENT_SECRET!.trim(), ...params }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; open_id?: string; scope?: string;
    error?: string; error_description?: string;
  };
  if (!res.ok || !j.access_token) throw new Error(`TikTok sign-in failed: ${j.error_description || j.error || res.status}`);
  const now = Date.now();
  return {
    access: j.access_token,
    refresh: j.refresh_token ?? "",
    expiresAt: now + (j.expires_in ?? 86400) * 1000,
    refreshExpiresAt: now + (j.refresh_expires_in ?? 31536000) * 1000,
    openId: j.open_id ?? "",
    scope: j.scope ?? "",
  };
}

export async function tiktokExchangeCode(code: string): Promise<Tokens> {
  return tokenCall({ code, grant_type: "authorization_code", redirect_uri: tiktokRedirectUri() });
}

async function api<T>(path: string, token: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  if (!res.ok || (j.error?.code && j.error.code !== "ok")) {
    const code = j.error?.code ?? String(res.status);
    const hint: Record<string, string> = {
      unaudited_client_can_only_post_to_private_accounts: "TikTok has not reviewed the app yet: until it does, posts can only go to a PRIVATE TikTok account",
      url_ownership_unverified: "TikTok has not verified the picture address yet (Social channels → TikTok shows how)",
      spam_risk_too_many_posts: "TikTok's daily posting limit for this account was reached",
    };
    throw new Error(`TikTok: ${hint[code] ?? j.error?.message ?? code}`);
  }
  return j;
}

/** The account's display name (user.info.basic only — the username needs user.info.profile, which we do not ask for). */
export async function tiktokUserInfo(token: string): Promise<{ openId: string; name: string }> {
  const j = await api<{ data?: { user?: { open_id?: string; display_name?: string } } }>(
    "/user/info/?fields=open_id,display_name", token, undefined, "GET",
  );
  const u = j.data?.user ?? {};
  return { openId: u.open_id ?? "", name: u.display_name || "TikTok" };
}

/** The account's tokens, refreshed when they are within an hour of running out. */
async function accessToken(pool: Pool, tenantId: string): Promise<{ token: string }> {
  const r = await pool.query<{ account_id: string; secret: string | null }>(
    `SELECT account_id, secret FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'tiktok' AND status = 'connected' LIMIT 1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row?.secret) throw new Error("TikTok is not connected");
  let t = JSON.parse(open(row.secret)) as Tokens;
  if (t.expiresAt - Date.now() < 3600_000) {
    if (t.refreshExpiresAt < Date.now()) throw new Error("TikTok's sign-in ran out — connect TikTok again in Social channels");
    t = { ...(await tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh })), openId: t.openId };
    await pool.query(`UPDATE marketing_channels SET secret = $3 WHERE tenant_id = $1::uuid AND provider = 'tiktok' AND account_id = $2`, [
      tenantId, row.account_id, seal(JSON.stringify(t)),
    ]);
  }
  return { token: t.access };
}

const PRIVACY_ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

/** Post a carousel / single picture (TikTok photo post) or a Reel (TikTok video), then wait for TikTok to finish it. */
export async function publishTikTok(
  pool: Pool,
  tenantId: string,
  format: string,
  caption: string,
  hashtags: string[],
  media: { kind: string; url: string }[],
): Promise<{ remoteId: string; permalink: string | null }> {
  const { token } = await accessToken(pool, tenantId);
  const info = await api<{ data?: { privacy_level_options?: string[]; creator_username?: string } }>("/post/publish/creator_info/query/", token, {});
  const options = info.data?.privacy_level_options ?? ["SELF_ONLY"];
  // A Sandbox (unaudited) app may only post privately, even when TikTok offers more.
  const privacy = process.env.TIKTOK_MODE === "sandbox" ? "SELF_ONLY" : PRIVACY_ORDER.find((p) => options.includes(p)) ?? options[0];
  const handle = info.data?.creator_username;
  const tags = hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ");
  const text = `${caption.trim()}${tags ? `\n\n${tags}` : ""}`;
  // Instagram's first line works as TikTok's photo title (90 characters).
  const title = [...caption.trim().split("\n")[0]].slice(0, 90).join("");
  let publishId: string;
  const video = media.find((m) => m.kind === "video");
  if (format === "reel" && video) {
    const j = await api<{ data?: { publish_id?: string } }>("/post/publish/video/init/", token, {
      post_info: { title: [...text].slice(0, 2200).join(""), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: "PULL_FROM_URL", video_url: video.url },
    });
    publishId = j.data?.publish_id ?? "";
  } else {
    const photos = media.filter((m) => m.kind === "image").slice(0, 35).map((m) => m.url);
    if (!photos.length) throw new Error("TikTok needs at least one picture");
    const j = await api<{ data?: { publish_id?: string } }>("/post/publish/content/init/", token, {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: { title, description: [...text].slice(0, 4000).join(""), privacy_level: privacy, disable_comment: false, auto_add_music: true, brand_organic_toggle: true },
      source_info: { source: "PULL_FROM_URL", photo_images: photos, photo_cover_index: 0 },
    });
    publishId = j.data?.publish_id ?? "";
  }
  if (!publishId) throw new Error("TikTok did not accept the post");
  // TikTok downloads and processes the media; wait for the outcome (up to ~5 minutes).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await api<{ data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] } }>(
      "/post/publish/status/fetch/", token, { publish_id: publishId },
    );
    const st = s.data?.status;
    if (st === "PUBLISH_COMPLETE") {
      const postId = s.data?.publicaly_available_post_id?.[0];
      return {
        remoteId: String(postId ?? publishId),
        permalink: postId && handle ? `https://www.tiktok.com/@${handle}/${format === "reel" ? "video" : "photo"}/${postId}` : null,
      };
    }
    if (st === "FAILED") throw new Error(`TikTok could not post it: ${s.data?.fail_reason ?? "unknown reason"}`);
  }
  return { remoteId: publishId, permalink: null };
}
