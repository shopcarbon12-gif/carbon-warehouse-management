"use client";

import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label, send } from "@/components/marketing/marketing-shared";

type Summary = {
  total: number;
  mailable: number;
  subscribed: number;
  excluded: { fake: number; staff: number; typo: number };
  unsubscribed: number;
  bounced: number;
  complained: number;
  rewards: number;
  shopify: number;
  syncedAt: string | null;
  byYear: { year: number | null; count: number }[];
};

const nf = new Intl.NumberFormat("en-US");

export function EmailContacts() {
  const { data, error, mutate } = useSWR<{ summary: Summary }>("/api/email/contacts", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const s = data?.summary;

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await send<{ result: { total: number; added: number }; summary: Summary }>("/api/email/contacts", "POST");
      setMsg({ text: `Synced: ${nf.format(r.result.total)} addresses (${nf.format(r.result.added)} new).` });
      await mutate({ summary: r.summary }, false);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Sync failed", err: true });
    } finally {
      setBusy(false);
    }
  }

  const tiles: [string, number | undefined, string][] = [
    ["Can be emailed", s?.mailable, "Not unsubscribed, bounced, complained or excluded"],
    ["Subscribed in Shopify", s?.subscribed, "Said yes to marketing on the website"],
    ["Store customers (Rewards)", s?.rewards, "Have an email in Rewards"],
    ["Online customers (Shopify)", s?.shopify, "Have an email in Shopify"],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--wms-muted)]">
          {s?.syncedAt ? `Last synced ${new Date(s.syncedAt).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}.` : "Not synced yet."}{" "}
          Sync joins Rewards and Shopify customers into one list. Unsubscribes, bounces and spam complaints are never mailed again.
        </p>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={sync}>
          {busy ? "Syncing…" : "Sync contacts"}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map(([k, v, hint]) => (
          <div key={k} className={card}>
            <span className={`${label} block`}>{k}</span>
            <span className="text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">{v == null ? "—" : nf.format(v)}</span>
            <span className="block text-[0.7rem] text-[var(--wms-muted)]">{hint}</span>
          </div>
        ))}
      </div>
      {s && (
        <div className="grid gap-2 md:grid-cols-2">
          <div className={card}>
            <span className={`${label} block pb-2`}>Can be emailed, by when they became a customer</span>
            <table className="w-full text-xs tabular-nums">
              <tbody>
                {s.byYear.map((y) => (
                  <tr key={String(y.year)} className="border-t border-[var(--wms-border)]">
                    <td className="py-1.5 text-[var(--wms-fg)]">{y.year ?? "Unknown"}</td>
                    <td className="py-1.5 text-right text-[var(--wms-fg)]">{nf.format(y.count)}</td>
                    <td className="py-1.5 pl-3 text-[var(--wms-muted)]">{y.year && y.year <= 2022 ? "Older addresses: more may bounce" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={card}>
            <span className={`${label} block pb-2`}>Never emailed</span>
            <table className="w-full text-xs tabular-nums">
              <tbody>
                {(
                  [
                    ["Fake or test addresses (e.g. @example.com)", s.excluded.fake],
                    ["Staff addresses", s.excluded.staff],
                    ["Typos (e.g. @gmial.com)", s.excluded.typo],
                    ["Unsubscribed", s.unsubscribed],
                    ["Bounced (address doesn't exist)", s.bounced],
                    ["Marked an email as spam", s.complained],
                  ] as [string, number][]
                ).map(([k, v]) => (
                  <tr key={k} className="border-t border-[var(--wms-border)]">
                    <td className="py-1.5 text-[var(--wms-fg)]">{k}</td>
                    <td className="py-1.5 text-right text-[var(--wms-fg)]">{nf.format(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
