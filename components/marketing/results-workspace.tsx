"use client";

import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label, send } from "./marketing-shared";

/**
 * Social → Results. The Instagram account by day (followers, reach, views,
 * profile visits, link taps) and what each published post did on each channel.
 * The worker refreshes the numbers every 3 hours.
 */

type Day = { day: string; followers: number | null; reach: number | null; views: number | null; profile_views: number | null; website_clicks: number | null };
type Row = { id: string; title: string; format: string; thumb: string | null; provider: string; published_at: string; permalink: string | null; metrics: Record<string, number> | null; metrics_at: string | null };
type Results = { days: Day[]; posts: Row[] };

const nf = new Intl.NumberFormat("en-US");
const sum = (days: Day[], k: keyof Day) => days.reduce((a, d) => a + (Number(d[k]) || 0), 0);

export function MarketingResultsWorkspace() {
  const { data, error, mutate } = useSWR<Results>("/api/marketing/results", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const days = data?.days ?? [];
  const last7 = days.slice(-7);
  const followers = [...days].reverse().find((d) => d.followers != null)?.followers ?? null;
  const firstFollowers = days.find((d) => d.followers != null)?.followers ?? null;
  const maxReach = Math.max(1, ...days.map((d) => d.reach ?? 0));

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await send<{ posts: number; days: number; errors: number }>("/api/marketing/results", "POST");
      setMsg({ text: `Updated ${r.posts} post result(s) and ${r.days} account day(s)${r.errors ? ` — ${r.errors} could not be read` : ""}.`, err: r.errors > 0 });
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  const tiles: [string, string][] = [
    ["Followers", followers == null ? "—" : `${nf.format(followers)}${firstFollowers != null && followers !== firstFollowers ? ` (${followers > firstFollowers ? "+" : ""}${nf.format(followers - firstFollowers)})` : ""}`],
    ["Reach, 7 days", nf.format(sum(last7, "reach"))],
    ["Views, 7 days", nf.format(sum(last7, "views"))],
    ["Profile visits, 7 days", nf.format(sum(last7, "profile_views"))],
    ["Link taps, 7 days", nf.format(sum(last7, "website_clicks"))],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Social · Results</h1>
          <p className="text-xs text-[var(--wms-muted)]">@shopcarbon by day, and what each published post did. Refreshed every 3 hours.</p>
        </div>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={refresh}>
          {busy ? "Reading…" : "Refresh now"}
        </button>
      </header>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {tiles.map(([k, v]) => (
          <div key={k} className={card}>
            <span className={`${label} block`}>{k}</span>
            <span className="text-lg font-semibold text-[var(--wms-fg)]">{v}</span>
          </div>
        ))}
      </div>

      <div className={card}>
        <span className={`${label} mb-2 block`}>Accounts reached per day (30 days)</span>
        {days.length ? (
          <div className="flex h-28 items-end gap-0.5">
            {days.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${nf.format(d.reach ?? 0)} reached, ${nf.format(d.views ?? 0)} views`}
                className="min-w-0 flex-1 rounded-t bg-sky-500/70"
                style={{ height: `${Math.max(2, ((d.reach ?? 0) / maxReach) * 100)}%` }}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--wms-muted)]">No days yet — press Refresh now.</p>
        )}
      </div>

      <div className={`${card} overflow-x-auto`}>
        <span className={`${label} mb-2 block`}>Published posts</span>
        {data?.posts.length ? (
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="text-[var(--wms-muted)]">
                <th className="py-1 pr-2" />
                <th className="py-1 pr-2">Post</th>
                <th className="py-1 pr-2">Channel</th>
                <th className="py-1 pr-2 text-right">Reach</th>
                <th className="py-1 pr-2 text-right">Views</th>
                <th className="py-1 pr-2 text-right">Likes</th>
                <th className="py-1 pr-2 text-right">Comments</th>
                <th className="py-1 pr-2 text-right">Saves</th>
                <th className="py-1 text-right">Shares</th>
              </tr>
            </thead>
            <tbody>
              {data.posts.map((r) => {
                const m = r.metrics ?? {};
                const cell = (k: string) => (m[k] == null ? "—" : nf.format(m[k]));
                return (
                  <tr key={`${r.id}:${r.provider}`} className="border-t border-[var(--wms-border)] text-[var(--wms-fg)]">
                    <td className="py-1 pr-2">
                      {r.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumb} alt="" className="h-10 w-8 rounded-sm object-cover" loading="lazy" />
                      ) : null}
                    </td>
                    <td className="py-1 pr-2">
                      {r.permalink ? (
                        <a className="underline" href={r.permalink} target="_blank" rel="noreferrer">
                          {r.title || r.format}
                        </a>
                      ) : (
                        r.title || r.format
                      )}
                      <span className="block text-[0.66rem] text-[var(--wms-muted)]">
                        {new Date(r.published_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </td>
                    <td className="py-1 pr-2">{r.provider === "instagram" ? "Instagram" : "Facebook"}</td>
                    <td className="py-1 pr-2 text-right">{cell("reach")}</td>
                    <td className="py-1 pr-2 text-right">{cell("views")}</td>
                    <td className="py-1 pr-2 text-right">{r.provider === "facebook" ? cell("reactions") : cell("likes")}</td>
                    <td className="py-1 pr-2 text-right">{cell("comments")}</td>
                    <td className="py-1 pr-2 text-right">{cell("saved")}</td>
                    <td className="py-1 text-right">{cell("shares")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-[var(--wms-muted)]">Nothing published from Social yet. Results appear here a few hours after a post goes out.</p>
        )}
      </div>
    </div>
  );
}
