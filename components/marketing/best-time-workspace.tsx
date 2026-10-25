"use client";

import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label, send } from "./marketing-shared";

/**
 * CarbonMarketing → Best time. When the audience is online, per weekday and
 * hour (Eastern), read from the channel itself (Instagram: followers online,
 * last 30 days). Darker = more people online. The best hour per day between
 * 8 AM and 10 PM is listed for scheduling.
 */

type BestTimes = { providers: Record<string, { grid: number[][]; computedAt: string; top: { weekday: number; hour: number; score: number }[] }> };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

export function MarketingBestTimeWorkspace() {
  const { data, error, mutate } = useSWR<BestTimes>("/api/marketing/best-times", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const ig = data?.providers.instagram;
  const max = ig ? Math.max(1, ...ig.grid.flat()) : 1;

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await send<{ points: number }>("/api/marketing/best-times", "POST");
      setMsg({ text: `Updated from Instagram (${r.points} data points).` });
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
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">CarbonMarketing · Best time</h1>
          <p className="text-xs text-[var(--wms-muted)]">
            When @shopcarbon followers are online, Eastern time. {ig ? `Updated ${new Date(ig.computedAt).toLocaleString("en-US", { timeZone: "America/New_York" })}.` : ""}
          </p>
        </div>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={refresh}>
          {busy ? "Reading Instagram…" : "Refresh from Instagram"}
        </button>
      </header>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}

      {!ig ? (
        <p className={`${card} text-xs text-[var(--wms-muted)]`}>No audience data yet. Press “Refresh from Instagram”.</p>
      ) : (
        <>
          <div className={`${card} flex flex-wrap gap-2`}>
            <span className={`${label} w-full`}>Best hour each day</span>
            {ig.top.map((t) => (
              <span key={t.weekday} className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] text-[var(--wms-fg)]">
                {DAYS[t.weekday]} {hourLabel(t.hour)}
              </span>
            ))}
          </div>
          <div className={`${card} overflow-x-auto`}>
            <table className="border-separate border-spacing-0.5">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="px-0.5 font-mono text-[0.58rem] font-normal text-[var(--wms-muted)]">
                      {h % 3 === 0 ? hourLabel(h) : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ig.grid.map((hours, wd) => (
                  <tr key={wd}>
                    <td className="pr-1 font-mono text-[0.66rem] text-[var(--wms-muted)]">{DAYS[wd]}</td>
                    {hours.map((v, h) => (
                      <td
                        key={h}
                        title={`${DAYS[wd]} ${hourLabel(h)}: ${Math.round(v)} followers online`}
                        className="h-6 w-6 rounded-sm"
                        style={{ background: `rgba(14,165,233,${0.08 + 0.92 * (v / max)})` }}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
