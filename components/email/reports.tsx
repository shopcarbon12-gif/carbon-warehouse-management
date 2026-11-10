"use client";
/**
 * Email Marketing → Reports (phase 5): campaigns and automatic emails together — sent, opens,
 * clicks, unsubscribes, bounces, and the orders and sales that followed (online and in the store,
 * within 5 days of the email). One chart (sales from email per week), then the table.
 */
import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label } from "@/components/marketing/marketing-shared";

type Row = { kind: "campaign" | "flow"; id: string; name: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsub: number; orders: number; revenue: number; when: string | null };
type Report = { days: number; totals: Omit<Row, "kind" | "id" | "name" | "when">; weeks: { week: string; sent: number; revenue: number; orders: number }[]; rows: Row[] };

const nf = new Intl.NumberFormat("en-US");
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

export function EmailReports() {
  const [days, setDays] = useState(30);
  const { data, error } = useSWR<Report>(`/api/email/reports?days=${days}`, fetcher, { refreshInterval: 120_000 });
  const t = data?.totals;
  const tiles: [string, string, string][] = t
    ? [
        ["Emails sent", nf.format(t.sent), `${pct(t.delivered, t.sent)} delivered`],
        ["Opened", pct(t.opened, t.sent), `${nf.format(t.opened)} people`],
        ["Clicked", pct(t.clicked, t.sent), `${nf.format(t.clicked)} people`],
        ["Orders after an email", nf.format(t.orders), "within 5 days, online or in the store"],
        ["Sales from email", money(t.revenue), t.sent ? `${money(t.revenue / t.sent)} per email sent` : ""],
        ["Unsubscribed", pct(t.unsub, t.sent), `${nf.format(t.unsub)} · bounced ${nf.format(t.bounced)} · spam ${nf.format(t.complained)}`],
      ]
    : [];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--wms-muted)]">Campaigns and automatic emails together. An order counts once, for the latest email the person got in the 5 days before it.</p>
        <div className="flex gap-1.5" role="group" aria-label="Period">
          {[30, 90, 365].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={`${btn} ${days === d ? "border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]" : "border-[var(--wms-border)]"}`}>
              {d === 365 ? "1 year" : `${d} days`}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {!data && !error && <p className="text-xs text-[var(--wms-muted)]">Loading…</p>}
      {data && (
        <>
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map(([k, v, sub]) => (
              <div key={k} className={`${card} flex flex-col gap-0.5`}>
                <span className={label}>{k}</span>
                <span className="text-2xl font-semibold text-[var(--wms-fg)]">{v}</span>
                <span className="text-[0.72rem] text-[var(--wms-muted)]">{sub}</span>
              </div>
            ))}
          </div>
          <WeeklySales weeks={data.weeks} />
          <section className={`${card} overflow-x-auto`}>
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className={label}>
                <tr>
                  <th className="py-1.5 pr-3">Email</th>
                  <th className="py-1.5 pr-3 text-right">Sent</th>
                  <th className="py-1.5 pr-3 text-right">Opened</th>
                  <th className="py-1.5 pr-3 text-right">Clicked</th>
                  <th className="py-1.5 pr-3 text-right">Unsub.</th>
                  <th className="py-1.5 pr-3 text-right">Bounced</th>
                  <th className="py-1.5 pr-3 text-right">Orders</th>
                  <th className="py-1.5 text-right">Sales</th>
                </tr>
              </thead>
              <tbody className="text-[var(--wms-fg)]">
                {!data.rows.length && (
                  <tr>
                    <td colSpan={8} className="py-3 text-[var(--wms-muted)]">
                      Nothing sent in this period yet.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={`${r.kind}:${r.id}`} className="border-t border-[var(--wms-border)]">
                    <td className="py-1.5 pr-3">
                      <span className="font-semibold">{r.name}</span>
                      <span className="ml-2 rounded border border-[var(--wms-border)] px-1 text-[0.62rem] uppercase text-[var(--wms-muted)]">{r.kind === "flow" ? "automatic" : "campaign"}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">{nf.format(r.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(r.opened, r.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(r.clicked, r.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(r.unsub, r.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(r.bounced, r.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{nf.format(r.orders)}</td>
                    <td className="py-1.5 text-right font-mono">{money(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

/** One series: sales from email per week (bars from the baseline, 4 px rounded tops, 2 px gaps, hover for the numbers). */
function WeeklySales({ weeks }: { weeks: Report["weeks"] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!weeks.length) return null;
  const max = Math.max(1, ...weeks.map((w) => w.revenue));
  const h = hover != null ? weeks[hover] : null;
  return (
    <section className={`${card} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Sales from email, per week</h3>
        <span className="text-xs text-[var(--wms-muted)]" aria-live="polite">
          {h ? `Week of ${new Date(`${h.week}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${money(h.revenue)} · ${h.orders} orders · ${nf.format(h.sent)} emails` : `Top week ${money(max)}`}
        </span>
      </div>
      <div className="relative flex h-40 items-end gap-[2px] border-b border-[var(--wms-border)]" onMouseLeave={() => setHover(null)}>
        {weeks.map((w, i) => (
          <button
            key={w.week}
            type="button"
            aria-label={`Week of ${w.week}: ${money(w.revenue)}, ${w.orders} orders`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            className="group flex h-full min-w-0 flex-1 items-end"
          >
            <span
              className={`block w-full rounded-t-[4px] ${hover === i ? "bg-[var(--wms-fg)]" : "bg-[var(--wms-accent)]"}`}
              style={{ height: `${Math.max(w.revenue > 0 ? 2 : 0, (w.revenue / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[0.7rem] text-[var(--wms-muted)]">
        <span>{new Date(`${weeks[0].week}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        <span>{new Date(`${weeks[weeks.length - 1].week}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      </div>
    </section>
  );
}
