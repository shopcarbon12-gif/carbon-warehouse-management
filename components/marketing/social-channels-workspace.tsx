"use client";

import { useState } from "react";
import useSWR from "swr";
import { useUrlParam } from "@/lib/use-url-param";
import { btn, card, fetcher, field, label, send } from "./marketing-shared";

/**
 * Integrations → Social channels. Every channel Social covers:
 * social networks, ad platforms and shopping catalogs. Meta (Instagram +
 * Facebook) is live; the others show what they need and which phase brings them.
 */

type Provider = {
  id: string;
  label: string;
  kind: "social" | "ads" | "shop";
  phase: number;
  publishing: boolean;
  credentials: boolean;
  accounts: { accountId: string; name: string; status: string; lastOkAt: string | null; lastError: string | null }[];
};
type Overview = { providers: Provider[] };
const KIND_LABEL = { social: "Social networks", ads: "Ad platforms", shop: "Shopping catalogs" } as const;

/** What each channel still needs from the owner before Social can post there (2026-10-25). */
const NEEDS: Record<string, string> = {
  tiktok: "Waiting for the TikTok app keys. Until TikTok reviews the app, posts can only go to a private TikTok account.",
  youtube: "Sign in to Google once more with YouTube upload allowed (same Google login as Ads and Merchant Center), for Shorts.",
  pinterest: "A Pinterest business account and a Pinterest developer app (Standard access).",
  snapchat: "A Snapchat Public Profile and access to Snap's Public Profile API (granted by Snap on request).",
  google_business: "Google's approval for the Business Profile API (an application form), then one Google sign-in.",
  linkedin: "A LinkedIn company page and a LinkedIn developer app with Community Management access.",
  x: "An X developer account (the paid Basic plan allows posting) and its keys.",
  threads: "Add the Threads use case to the Meta app, then sign in to Threads once.",
  twitch: "Twitch has no API for posting pictures; skipped.",
  meta_ads: "Live: Social → Ads.",
  google_ads: "Live: Social → Ads.",
  merchant_center: "Live: Social → Merchant Center.",
  meta_catalog: "Live: Instagram product tags use it.",
};

export function SocialChannelsWorkspace() {
  const { data, error, mutate } = useSWR<Overview>("/api/marketing/overview", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [bsky, setBsky] = useState({ handle: "", appPassword: "" });
  // Back from TikTok's sign-in: ?tiktok=connected or the reason it failed.
  const [tiktokNote] = useUrlParam("tiktok");

  async function disconnect(provider: string, accountId: string, name: string) {
    if (!window.confirm(`Disconnect ${name}? Social stops posting there until you connect it again.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await send("/api/marketing/channels/disconnect", "POST", { provider, accountId });
      setMsg({ text: `${name} disconnected.${provider === "instagram" || provider === "facebook" ? " Press “Sync Meta accounts” to connect it again." : ""}` });
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  async function bluesky(connect: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      if (connect) {
        const r = await send<{ handle: string }>("/api/marketing/channels/bluesky", "POST", bsky);
        setMsg({ text: `Bluesky connected as @${r.handle}.` });
        setBsky({ handle: "", appPassword: "" });
      } else {
        const res = await fetch("/api/marketing/channels/bluesky", { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setMsg({ text: "Bluesky disconnected." });
      }
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  async function syncMeta() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await send<{ accounts: { pageName: string; igUsername: string | null }[] }>("/api/marketing/channels/sync", "POST");
      setMsg({ text: `Found ${r.accounts.map((a) => `${a.pageName}${a.igUsername ? ` + @${a.igUsername}` : ""}`).join(", ") || "no pages"}.` });
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Social channels</h1>
          <p className="text-xs text-[var(--wms-muted)]">Accounts Social publishes to. Posts only go out after approval in Social → Calendar.</p>
        </div>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={syncMeta}>
          {busy ? "Reading Meta…" : "Sync Meta accounts"}
        </button>
      </header>
      {tiktokNote && (
        <p className={`text-xs ${tiktokNote === "connected" ? "text-emerald-700 dark:text-emerald-300" : "text-[var(--wms-status-danger-fg)]"}`}>
          {tiktokNote === "connected" ? "TikTok connected." : `TikTok: ${tiktokNote}`}
        </p>
      )}
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}

      {(["social", "ads", "shop"] as const).map((kind) => (
        <section key={kind} className="flex flex-col gap-2">
          <h2 className={label}>{KIND_LABEL[kind]}</h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {(data?.providers ?? [])
              .filter((p) => p.kind === kind)
              .map((p) => {
                const connected = p.accounts.some((a) => a.status === "connected");
                const live = (connected && p.publishing) || ["meta_ads", "google_ads", "merchant_center", "meta_catalog"].includes(p.id) && p.credentials;
                const state = live ? "Live" : connected || p.credentials ? "Keys present" : "Needs your account";
                const tone = live ? "text-emerald-600 dark:text-emerald-400" : p.credentials || connected ? "text-sky-600 dark:text-sky-400" : "text-[var(--wms-muted)]";
                return (
                  <div key={p.id} className={card}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--wms-fg)]">{p.label}</span>
                      <span className={`font-mono text-[0.66rem] uppercase ${tone}`}>{state}</span>
                    </div>
                    {p.accounts.map((a) => (
                      <div key={a.accountId} className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--wms-fg)]">
                        <p className={a.status === "connected" ? "" : "text-[var(--wms-muted)] line-through"}>
                          {a.name} <span className="font-mono text-[0.62rem] text-[var(--wms-muted)]">({a.accountId})</span>
                          {a.lastError && <span className="block text-[var(--wms-status-danger-fg)] no-underline">Last error: {a.lastError}</span>}
                        </p>
                        {a.status === "connected" && p.id !== "bluesky" ? (
                          <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={() => void disconnect(p.id, a.accountId, a.name)}>
                            Disconnect
                          </button>
                        ) : a.status !== "connected" ? (
                          <span className="text-[0.66rem] text-[var(--wms-muted)]">Disconnected</span>
                        ) : null}
                      </div>
                    ))}
                    {p.id === "tiktok" && !connected && p.credentials && (
                      <a href="/api/marketing/channels/tiktok/start" className={`${btn} mt-2 inline-block border-sky-600 text-sky-700 dark:text-sky-300`}>
                        Connect TikTok
                      </a>
                    )}
                    {p.id === "tiktok" && connected && (
                      <p className="mt-1 text-xs text-[var(--wms-muted)]">Reconnect any time with Connect TikTok after disconnecting. Until TikTok reviews the app, posts go out private.</p>
                    )}
                    {p.id === "bluesky" &&
                      (connected ? (
                        <button type="button" className={`${btn} mt-2 border-[var(--wms-border)]`} disabled={busy} onClick={() => void bluesky(false)}>
                          Disconnect
                        </button>
                      ) : (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <input className={field} placeholder="handle, e.g. shopcarbon.bsky.social" autoComplete="off" value={bsky.handle} onChange={(e) => setBsky({ ...bsky, handle: e.target.value })} />
                          <input className={field} type="password" placeholder="App password (Bluesky › Settings › App passwords)" autoComplete="new-password" value={bsky.appPassword} onChange={(e) => setBsky({ ...bsky, appPassword: e.target.value })} />
                          <button type="button" className={`${btn} self-start border-sky-600 text-sky-700 dark:text-sky-300`} disabled={busy || !bsky.handle || !bsky.appPassword} onClick={() => void bluesky(true)}>
                            Connect Bluesky
                          </button>
                        </div>
                      ))}
                    {!connected && NEEDS[p.id] && !(p.id === "tiktok" && p.credentials) && <p className="mt-1 text-xs text-[var(--wms-muted)]">{NEEDS[p.id]}</p>}
                    {!connected && p.id === "tiktok" && p.credentials && (
                      <p className="mt-1 text-xs text-[var(--wms-muted)]">Sign in with a TikTok account added as a target user in the app&apos;s Sandbox. Until TikTok reviews the app, posts can only go to a private account.</p>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
