/**
 * Google Business Profile for Social (owner, 2026-10-29: "every time I post to
 * Instagram and Facebook, I can also post there").
 *
 * - Connect: "Connect Google Business" signs the owner in to Google (OAuth web
 *   client GOOGLE_BUSINESS_CLIENT_ID / GOOGLE_BUSINESS_CLIENT_SECRET on the web
 *   app, redirect …/api/marketing/channels/google-business/callback, scope
 *   business.manage). The refresh token and the client keys are kept sealed in
 *   marketing_channels.secret, so the worker posts without its own env.
 * - Post: one photo update (localPosts, API v4) with a Shop button to the
 *   post's link. Google shows no hashtags and has no "link in bio".
 * - Search terms: what people typed to find the store, per month
 *   (Business Profile Performance API), for the AI to write with.
 *
 * Nothing works until Google approves the project for the Business Profile
 * APIs (asked 2026-10-29, case 3-5973000041638): until then Google answers
 * 403 / quota 0 and the error says so.
 */
import { PUBLIC_BASE } from "./store";
import { open } from "@/lib/server/secret-box";

export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

export class GoogleBusinessError extends Error {}

export function googleBusinessConfigured(): boolean {
  return Boolean(process.env.GOOGLE_BUSINESS_CLIENT_ID?.trim() && process.env.GOOGLE_BUSINESS_CLIENT_SECRET?.trim());
}

export function googleBusinessRedirectUri(): string {
  return `${PUBLIC_BASE}/api/marketing/channels/google-business/callback`;
}

export function googleBusinessAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID!.trim(),
    redirect_uri: googleBusinessRedirectUri(),
    response_type: "code",
    scope: GOOGLE_BUSINESS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** What is kept sealed for the channel. */
export type GoogleBusinessSecret = { refresh: string; clientId: string; clientSecret: string };

export async function googleBusinessExchangeCode(code: string): Promise<GoogleBusinessSecret & { access: string }> {
  const clientId = process.env.GOOGLE_BUSINESS_CLIENT_ID!.trim();
  const clientSecret = process.env.GOOGLE_BUSINESS_CLIENT_SECRET!.trim();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: googleBusinessRedirectUri(), grant_type: "authorization_code" }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error_description?: string; error?: string };
  if (!r.ok || !j.access_token) throw new GoogleBusinessError(j.error_description || j.error || `Google sign-in failed (HTTP ${r.status})`);
  if (!j.refresh_token) throw new GoogleBusinessError("Google gave no lasting access — press Connect Google Business again and allow access");
  if (!(j.scope ?? "").includes("business.manage")) throw new GoogleBusinessError("Allow managing the Business Profile on Google's screen");
  return { access: j.access_token, refresh: j.refresh_token, clientId, clientSecret };
}

async function accessToken(s: GoogleBusinessSecret): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: s.refresh, client_id: s.clientId, client_secret: s.clientSecret, grant_type: "refresh_token" }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!r.ok || !j.access_token) throw new GoogleBusinessError(`Google sign-in expired (${j.error_description || j.error || r.status}) — connect Google Business again`);
  return j.access_token;
}

/** A Google API call; turns Google's "not approved yet" answers into plain words. */
async function gapi<T>(access: string, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${access}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!r.ok) {
    const m = j.error?.message || `HTTP ${r.status}`;
    if (r.status === 429 || /quota|has not been used|is disabled|not been enabled/i.test(m))
      throw new GoogleBusinessError(`Google has not switched on the Business Profile API for this project yet (approval pending). Google said: ${m}`);
    throw new GoogleBusinessError(`Google Business: ${m}`);
  }
  return j;
}

export type GoogleLocation = { path: string; title: string; address: string; open: boolean };

/** Every location the signed-in account manages, open ones first ("accounts/A/locations/L"). */
export async function googleBusinessLocations(access: string): Promise<GoogleLocation[]> {
  const accounts = await gapi<{ accounts?: { name: string }[] }>(access, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
  const out: GoogleLocation[] = [];
  for (const a of accounts.accounts ?? []) {
    let page = "";
    do {
      const q = new URLSearchParams({ readMask: "name,title,storefrontAddress,openInfo", pageSize: "100", ...(page ? { pageToken: page } : {}) });
      const l = await gapi<{
        locations?: { name: string; title?: string; storefrontAddress?: { addressLines?: string[]; locality?: string }; openInfo?: { status?: string } }[];
        nextPageToken?: string;
      }>(access, `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?${q}`);
      for (const x of l.locations ?? []) {
        out.push({
          path: `${a.name}/${x.name}`, // accounts/A + locations/L
          title: x.title ?? x.name,
          address: [...(x.storefrontAddress?.addressLines ?? []), x.storefrontAddress?.locality].filter(Boolean).join(", "),
          open: (x.openInfo?.status ?? "OPEN") === "OPEN",
        });
      }
      page = l.nextPageToken ?? "";
    } while (page);
  }
  return out.sort((x, y) => Number(y.open) - Number(x.open));
}

/** The caption as Google shows it: no hashtags, no "link in bio" (the Shop button carries the link), ≤ 1,500 characters. */
export function googleBusinessText(caption: string): string {
  const t = caption
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
    .replace(/,?\s*(?:tap the |via the )?link in (?:our |the )?bio\.?/gi, ".")
    .replace(/\.\./g, ".")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > 1500 ? `${t.slice(0, 1497).replace(/\s+\S*$/, "")}…` : t;
}

/**
 * The button on a Google post, as Google's "Add post" screen lists them.
 * value = what is stored on the post (marketing_posts.google_button; NULL = BUY).
 */
export const GOOGLE_BUTTONS = [
  { value: "BUY", label: "Buy", api: "SHOP" },
  { value: "ORDER", label: "Order online", api: "ORDER" },
  { value: "LEARN_MORE", label: "Learn more", api: "LEARN_MORE" },
  { value: "BOOK", label: "Book", api: "BOOK" },
  { value: "SIGN_UP", label: "Sign up", api: "SIGN_UP" },
  { value: "CALL", label: "Call now", api: "CALL" },
  { value: "NONE", label: "None", api: null },
] as const;
export type GoogleButton = (typeof GOOGLE_BUTTONS)[number]["value"];

const SHOP_HOME = "https://shopcarbon.com/";

/** Publish one update with a photo and the post's button. */
export async function publishGoogleBusiness(
  sealedSecret: string,
  locationPath: string,
  caption: string,
  photoUrl: string | null,
  link: string | null,
  button: string | null,
): Promise<{ remoteId: string; permalink: string | null }> {
  if (!photoUrl) throw new GoogleBusinessError("A Google post needs a picture (a Reel needs its cover)");
  const b = GOOGLE_BUTTONS.find((x) => x.value === (button || "BUY")) ?? GOOGLE_BUTTONS[0];
  // "Call now" dials the store's phone on the profile, so it takes no link.
  const callToAction = !b.api ? undefined : b.api === "CALL" ? { actionType: "CALL" } : { actionType: b.api, url: link || SHOP_HOME };
  const access = await accessToken(JSON.parse(open(sealedSecret)) as GoogleBusinessSecret);
  const post = await gapi<{ name: string; searchUrl?: string }>(access, `https://mybusiness.googleapis.com/v4/${locationPath}/localPosts`, {
    method: "POST",
    body: {
      languageCode: "en-US",
      topicType: "STANDARD",
      summary: googleBusinessText(caption),
      ...(callToAction ? { callToAction } : {}),
      media: [{ mediaFormat: "PHOTO", sourceUrl: photoUrl }],
    },
  });
  return { remoteId: post.name, permalink: post.searchUrl ?? null };
}

export type SearchTerm = { term: string; count: number | null; below: number | null };

/**
 * What people typed on Google Search and Maps before the store showed up, for
 * the last `months` full months. Google hides small numbers: those come back
 * as "below N" (count null).
 */
export async function googleSearchTerms(sealedSecret: string, locationPath: string, months = 3): Promise<SearchTerm[]> {
  const access = await accessToken(JSON.parse(open(sealedSecret)) as GoogleBusinessSecret);
  const loc = locationPath.split("/").slice(-2).join("/"); // locations/L
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
  const out: SearchTerm[] = [];
  let page = "";
  do {
    const q = new URLSearchParams({
      "monthlyRange.startMonth.year": String(start.getUTCFullYear()),
      "monthlyRange.startMonth.month": String(start.getUTCMonth() + 1),
      "monthlyRange.endMonth.year": String(end.getUTCFullYear()),
      "monthlyRange.endMonth.month": String(end.getUTCMonth() + 1),
      pageSize: "100",
      ...(page ? { pageToken: page } : {}),
    });
    const j = await gapi<{
      searchKeywordsCounts?: { searchKeyword: string; insightsValue?: { value?: string; threshold?: string } }[];
      nextPageToken?: string;
    }>(access, `https://businessprofileperformance.googleapis.com/v1/${loc}/searchkeywords/impressions/monthly?${q}`);
    for (const k of j.searchKeywordsCounts ?? []) {
      out.push({
        term: k.searchKeyword,
        count: k.insightsValue?.value != null ? Number(k.insightsValue.value) : null,
        below: k.insightsValue?.threshold != null ? Number(k.insightsValue.threshold) : null,
      });
    }
    page = j.nextPageToken ?? "";
  } while (page);
  return out.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
}
