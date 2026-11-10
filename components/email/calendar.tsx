"use client";
/**
 * Email Marketing → Calendar (the owner's CARBON pack): the seasonal campaigns of the next 12 months,
 * each with its date worked out (Thanksgiving week, Mother's Day …), how long until it goes out, and
 * "Start it": a new email from the pack's template and a draft campaign, ready to swap in photos and
 * products. A phone/computer alert comes 14 days before each one (Settings › Alerts › Social & email).
 */
import { useMemo, useState } from "react";
import useSWR from "swr";
import { upcoming } from "@/lib/email-editor/calendar";
import { btn, card, fetcher, send } from "@/components/marketing/marketing-shared";

const nf = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });

export function EmailCalendar({ onCampaign }: { onCampaign: (id: string) => void }) {
  const list = useMemo(() => upcoming(new Date(), 366), []);
  const { data } = useSWR<{ campaigns: { id: string; name: string; status: string }[] }>("/api/email/campaigns", fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const months = new Map<string, typeof list>();
  for (const u of list) {
    const m = u.sendOn.slice(0, 7);
    months.set(m, [...(months.get(m) ?? []), u]);
  }
  async function start(u: (typeof list)[number]) {
    setBusy(`${u.template}:${u.sendOn}`);
    setErr(null);
    try {
      const title = `${u.name} ${u.day.slice(0, 4)}`;
      const e = await send<{ id: string }>("/api/email/editor", "POST", { starter: `pack-${u.template}`, title });
      const c = await send<{ id: string }>("/api/email/campaigns", "POST", { name: title, designId: e.id, audience: { who: "all" } });
      onCampaign(c.id);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-[var(--wms-muted)]">
        The seasonal campaigns from the CARBON pack, with this year&apos;s dates. “Start it” makes the email from its template and a draft campaign; nothing is sent until you approve it. You get an alert 14 days before each one. Birthdays are automatic: turn on the Happy birthday flow in Flows.
      </p>
      {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}
      {[...months.entries()].map(([m, items]) => (
        <section key={m} className={`${card} flex flex-col gap-1.5`}>
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">{nf(`${m}-01`, { month: "long", year: "numeric" })}</h3>
          {items.map((u) => {
            const k = `${u.template}:${u.sendOn}`;
            const made = data?.campaigns.find((c) => c.name === `${u.name} ${u.day.slice(0, 4)}`);
            const soon = u.daysLeft <= 14;
            return (
              <div key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-[var(--wms-border)] px-3 py-2">
                <span className="w-24 shrink-0 font-mono text-sm text-[var(--wms-fg)]">{nf(u.sendOn, { weekday: "short", month: "short", day: "numeric" })}</span>
                <span className="min-w-[200px] flex-1">
                  <span className="block text-sm font-semibold text-[var(--wms-fg)]">{u.name}</span>
                  <span className="block text-xs text-[var(--wms-muted)]">{u.rule}</span>
                </span>
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.68rem] uppercase ${soon ? "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300" : "border-[var(--wms-border)] text-[var(--wms-muted)]"}`}>
                  {u.daysLeft === 0 ? "today" : `in ${u.daysLeft} day${u.daysLeft === 1 ? "" : "s"}`}
                  {soon ? " · prepare now" : ""}
                </span>
                {made ? (
                  <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => onCampaign(made.id)}>
                    Open campaign ({made.status})
                  </button>
                ) : (
                  <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy} onClick={() => void start(u)}>
                    {busy === k ? "Starting…" : "Start it"}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
