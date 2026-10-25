"use client";

import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label, send } from "./marketing-shared";

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

export function SocialChannelsWorkspace() {
  const { data, error, mutate } = useSWR<Overview>("/api/marketing/overview", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

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
                const state = connected && p.publishing ? "Live" : connected || p.credentials ? "Credentials present" : `Coming in phase ${p.phase}`;
                const tone = connected && p.publishing ? "text-emerald-600 dark:text-emerald-400" : p.credentials || connected ? "text-sky-600 dark:text-sky-400" : "text-[var(--wms-muted)]";
                return (
                  <div key={p.id} className={card}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--wms-fg)]">{p.label}</span>
                      <span className={`font-mono text-[0.66rem] uppercase ${tone}`}>{state}</span>
                    </div>
                    {p.accounts.map((a) => (
                      <p key={a.accountId} className="mt-1 text-xs text-[var(--wms-fg)]">
                        {a.name} <span className="font-mono text-[0.62rem] text-[var(--wms-muted)]">({a.accountId})</span>
                        {a.lastError && <span className="block text-[var(--wms-status-danger-fg)]">Last error: {a.lastError}</span>}
                      </p>
                    ))}
                    {!p.accounts.length && p.credentials && !p.publishing && (
                      <p className="mt-1 text-xs text-[var(--wms-muted)]">The server has keys for this account; posting/campaign control arrives in phase {p.phase}.</p>
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
