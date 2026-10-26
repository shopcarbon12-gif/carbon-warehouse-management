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

export type TikTokCreator = {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number | null;
  /** Unaudited (Sandbox) app: TikTok only takes "Only me" posts. */
  sandbox: boolean;
};

/** What TikTok's posting rules make the person choose before every post (Content Sharing Guidelines). */
export type TikTokChoices = {
  privacy: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "Your brand" → labelled Promotional content. */
  yourBrand: boolean;
  /** "Branded content" (paid partnership) → labelled Paid partnership; never "Only me". */
  brandedContent: boolean;
};

async function creatorInfo(token: string): Promise<TikTokCreator> {
  const j = await api<{
    data?: {
      creator_nickname?: string; creator_username?: string; creator_avatar_url?: string; privacy_level_options?: string[];
      comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number;
    };
  }>("/post/publish/creator_info/query/", token, {});
  const d = j.data ?? {};
  return {
    nickname: d.creator_nickname ?? "",
    username: d.creator_username ?? "",
    avatarUrl: d.creator_avatar_url ?? null,
    privacyOptions: d.privacy_level_options ?? ["SELF_ONLY"],
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxVideoSeconds: d.max_video_post_duration_sec ?? null,
    sandbox: process.env.TIKTOK_MODE === "sandbox",
  };
}

export async function tiktokCreator(pool: Pool, tenantId: string): Promise<TikTokCreator> {
  return creatorInfo((await accessToken(pool, tenantId)).token);
}

/** Hand the post to TikTok (it then downloads and processes the media); returns TikTok's publish id. */
export async function startTikTokPost(
  pool: Pool,
  tenantId: string,
  format: string,
  caption: string,
  hashtags: string[],
  media: { kind: string; url: string }[],
  choices: TikTokChoices,
): Promise<{ publishId: string; creator: TikTokCreator }> {
  const { token } = await accessToken(pool, tenantId);
  const creator = await creatorInfo(token);
  if (!creator.privacyOptions.includes(choices.privacy)) throw new Error("TikTok does not offer that privacy setting for this account");
  if (creator.sandbox && choices.privacy !== "SELF_ONLY") throw new Error("Until TikTok reviews the app, posts can only be \"Only me\"");
  if (choices.brandedContent && choices.privacy === "SELF_ONLY") throw new Error("Branded content cannot be private");
  const tags = hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ");
  const text = `${caption.trim()}${tags ? `\n\n${tags}` : ""}`;
  const brand = { brand_organic_toggle: choices.yourBrand, brand_content_toggle: choices.brandedContent };
  const video = media.find((m) => m.kind === "video");
  let publishId: string;
  if (format === "reel" && video) {
    const j = await api<{ data?: { publish_id?: string } }>("/post/publish/video/init/", token, {
      post_info: {
        title: [...text].slice(0, 2200).join(""),
        privacy_level: choices.privacy,
        disable_comment: creator.commentDisabled || !choices.allowComment,
        disable_duet: creator.duetDisabled || !choices.allowDuet,
        disable_stitch: creator.stitchDisabled || !choices.allowStitch,
        ...brand,
      },
      source_info: { source: "PULL_FROM_URL", video_url: video.url },
    });
    publishId = j.data?.publish_id ?? "";
  } else {
    // TikTok refuses photos over 1080×1920 (picture_size_check_failed): use the shrunk copy.
    const photos = media.filter((m) => m.kind === "image").slice(0, 35)
      .map((m) => m.url.replace(/(\/marketing-media\/[0-9a-f-]{36})\.(jpe?g|png)(\?.*)?$/i, "$1-tiktok.jpg"));
    if (!photos.length) throw new Error("TikTok needs at least one picture");
    // Instagram's first line works as TikTok's photo title (90 characters).
    const title = [...caption.trim().split("\n")[0]].slice(0, 90).join("");
    const j = await api<{ data?: { publish_id?: string } }>("/post/publish/content/init/", token, {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        title,
        description: [...text].slice(0, 4000).join(""),
        privacy_level: choices.privacy,
        disable_comment: creator.commentDisabled || !choices.allowComment,
        auto_add_music: true,
        ...brand,
      },
      source_info: { source: "PULL_FROM_URL", photo_images: photos, photo_cover_index: 0 },
    });
    publishId = j.data?.publish_id ?? "";
  }
  if (!publishId) throw new Error("TikTok did not accept the post");
  return { publishId, creator };
}

/** Where TikTok is with a post: processing, done (with the post's link when public) or failed. */
export async function tiktokPostStatus(
  pool: Pool,
  tenantId: string,
  publishId: string,
  format: string,
  username: string,
): Promise<{ state: "processing" | "published" | "failed"; error: string | null; remoteId: string; permalink: string | null }> {
  const { token } = await accessToken(pool, tenantId);
  const s = await api<{ data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] } }>(
    "/post/publish/status/fetch/", token, { publish_id: publishId },
  );
  const st = s.data?.status;
  const postId = s.data?.publicaly_available_post_id?.[0];
  if (st === "FAILED") return { state: "failed", error: `TikTok could not post it: ${s.data?.fail_reason ?? "unknown reason"}`, remoteId: publishId, permalink: null };
  if (st === "PUBLISH_COMPLETE")
    return {
      state: "published",
      error: null,
      remoteId: String(postId ?? publishId),
      permalink: postId && username ? `https://www.tiktok.com/@${username}/${format === "reel" ? "video" : "photo"}/${postId}` : null,
    };
  return { state: "processing", error: null, remoteId: publishId, permalink: null };
}

/** Scheduled posts (the calendar): the most public setting TikTok allows, comments on; then wait for TikTok to finish it. */
export async function publishTikTok(
  pool: Pool,
  tenantId: string,
  format: string,
  caption: string,
  hashtags: string[],
  media: { kind: string; url: string }[],
): Promise<{ remoteId: string; permalink: string | null }> {
  const { token } = await accessToken(pool, tenantId);
  const info = await creatorInfo(token);
  // A Sandbox (unaudited) app may only post privately, even when TikTok offers more.
  const privacy = info.sandbox ? "SELF_ONLY" : PRIVACY_ORDER.find((p) => info.privacyOptions.includes(p)) ?? info.privacyOptions[0];
  const { publishId } = await startTikTokPost(pool, tenantId, format, caption, hashtags, media, {
    privacy, allowComment: true, allowDuet: true, allowStitch: true, yourBrand: true, brandedContent: false,
  });
  // TikTok downloads and processes the media; wait for the outcome (up to ~5 minutes).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await tiktokPostStatus(pool, tenantId, publishId, format, info.username);
    if (s.state === "published") return { remoteId: s.remoteId, permalink: s.permalink };
    if (s.state === "failed") throw new Error(s.error ?? "TikTok could not post it");
  }
  return { remoteId: publishId, permalink: null };
}
