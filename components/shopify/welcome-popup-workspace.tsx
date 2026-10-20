"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { WelcomeReport } from "@/lib/server/welcome/report";

/**
 * Shopify → Email Popup (owner 2026-10-20). Our own signup popup on
 * shopcarbon.com, replacing pop-convert: the email goes to Shopify as a
 * subscribed customer, and the shopper gets ONE unique code, single use,
 * locked to their email, never stacked with another discount, never on
 * shipping. This page turns it on/off, sets the offer, and shows signups and
 * codes used.
 */

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as WelcomeReport;
};

const PREVIEW_URL = "https://shopcarbon.com/?carbon_welcome=preview";
const ET = "America/New_York";
function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric", year: "numeric" });
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const card = "min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3";
const th = "px-2 py-1.5 text-left font-mono text-[0.66rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]";
const td = "px-2 py-1.5 align-top text-[0.8rem] text-[var(--wms-fg)]";
const btn =
  "rounded-md border px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11 max-md:px-3";
const field =
  "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";

export function WelcomePopupWorkspace() {
  const { data, error, mutate, isLoading } = useSWR<WelcomeReport>("/api/shopify/welcome-popup", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  async function save(patch: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/welcome-popup/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg({ text: ok });
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <p className="p-4 font-mono text-xs text-[var(--wms-status-danger-fg)]">Could not load the email popup: {error.message}</p>;
  if (isLoading || !data) return <p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading the email popup…</p>;

  const s = data.settings;
  const t = data.totals;
  const neverUsed = data.floorPercent > 0 && s.percentOff <= data.floorPercent;
  const floorSale = data.sale.find((x) => (x.minQuantity ?? 0) <= 1 && x.percent === data.floorPercent);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Header + on/off */}
      <div className="flex flex-col gap-3 border-b border-[var(--wms-border)] pb-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Email Popup</h1>
          <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
            Shoppers on shopcarbon.com leave their email and get {s.percentOff}% off their first order. Each email is subscribed in Shopify
            and gets its own code: one use, linked to that email, never on top of another discount, never on shipping.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div role="radiogroup" aria-label="Email popup on or off" className="flex overflow-hidden rounded-md border border-[var(--wms-border)]">
            {([false, true] as const).map((on) => (
              <button
                key={String(on)}
                type="button"
                role="radio"
                aria-checked={s.enabled === on}
                disabled={busy}
                onClick={() => {
                  if (on === s.enabled) return;
                  if (on && neverUsed) setConfirmOn(true);
                  else void save({ enabled: on }, on ? "The popup is on — shoppers see it within a minute." : "The popup is off.");
                }}
                className={`px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide max-md:min-h-11 ${
                  s.enabled === on
                    ? on
                      ? "bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]"
                      : "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]"
                    : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                }`}
              >
                {on ? "On" : "Off"}
              </button>
            ))}
          </div>
          <p className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
            {s.enabled ? `Opens after ${s.delaySeconds} s or half a page of scrolling.` : "Shoppers don't see it. The preview still works."}
          </p>
        </div>
      </div>

      {neverUsed ? (
        <div className="rounded-md border border-amber-500/60 bg-amber-950/20 p-3 text-sm text-[var(--wms-fg)]">
          <p className="font-semibold">A {s.percentOff}% code will never be used while your flash sale runs.</p>
          <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
            {floorSale ? `"${floorSale.title}"` : "An automatic discount"} already takes {data.floorPercent}% off every item. Welcome codes never
            stack with it, and Shopify always gives the shopper whichever discount saves more — so the code only counts when it is
            bigger than {data.floorPercent}%. At {data.floorPercent + 5}%, a one-item first order gets {data.floorPercent + 5}% instead of{" "}
            {data.floorPercent}%; with two or more items the sale&apos;s bigger tiers still win.
          </p>
          {data.sale.length ? (
            <p className="mt-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Running now: {data.sale.map((x) => `${x.title} (${x.percent}%${x.minQuantity ? `, ${x.minQuantity}+ items` : ""})`).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {confirmOn ? (
        <div className="rounded-md border border-amber-500/60 bg-amber-950/20 p-3 font-mono text-xs text-[var(--wms-fg)]">
          <p>
            Turn it on at {s.percentOff}%? Shoppers will sign up, but their code won&apos;t lower any order while the {data.floorPercent}% flash
            sale runs. You can raise the percent below first.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmOn(false);
                void save({ enabled: true }, "The popup is on — shoppers see it within a minute.");
              }}
              className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]`}
            >
              Turn on at {s.percentOff}%
            </button>
            <button type="button" onClick={() => setConfirmOn(false)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {msg ? (
        <p className={`font-mono text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-status-success-fg)]"}`}>{msg.text}</p>
      ) : null}
      {!data.emailReady ? (
        <p className="font-mono text-xs text-[var(--wms-status-warning-fg)]">
          Welcome emails can&apos;t be sent: RESEND_API_KEY is missing on the server. The popup still shows the code on screen.
        </p>
      ) : null}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(
          [
            ["Signups · today", t.today.toLocaleString(), `${t.week} in 7 days · ${t.month} in 30 days`],
            ["Emails collected", t.all.toLocaleString(), `${t.newCustomers} new to Carbon · ${t.all - t.newCustomers} already customers`],
            ["Codes used", t.used.toLocaleString(), `${pct(t.used, t.all)} of signups`],
            ["Orders with a code", money(t.revenue), t.unsubscribed ? `${t.unsubscribed} unsubscribed since` : "order totals, paid"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className={card}>
            <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">{value}</p>
            <p className="mt-0.5 font-mono text-[0.68rem] text-[var(--wms-muted)]">{sub}</p>
          </div>
        ))}
      </div>

      <Daily daily={data.daily} />

      <Offer report={data} busy={busy} onSave={(patch) => void save(patch, "Saved — the store updates within a minute.")} />

      <Signups report={data} />

      <p className="font-mono text-[0.66rem] text-[var(--wms-muted)]">
        Codes look like WELCOME{s.percentOff}-XXXXXX and discount only products with no sale price (hidden Shopify collection &quot;Full
        price (welcome offer)&quot;). One code per email, ever: signing up again re-sends the same code. Bots, server farms and quick
        repeat signups are turned away (3 per connection a day).
        {t.emailErrors ? ` ${t.emailErrors} welcome email(s) failed to send — see the list.` : ""}
        {s.updatedAt ? ` Settings last changed ${when(s.updatedAt)}${s.updatedByEmail ? ` by ${s.updatedByEmail}` : ""}.` : ""}
      </p>
    </div>
  );
}

function Daily({ daily }: { daily: WelcomeReport["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.signups));
  const any = daily.some((d) => d.signups || d.used);
  return (
    <div className={card}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Signups per day · 30 days</p>
        <span className="flex items-center gap-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--wms-accent)]" /> signups
        </span>
        <span className="flex items-center gap-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> codes used
        </span>
      </div>
      {any ? (
        <div className="flex h-24 items-end gap-1 overflow-x-auto">
          {daily.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.signups} signups, ${d.used} codes used`} className="flex h-full min-w-[0.6rem] flex-1 flex-col justify-end">
              <div className="w-full rounded-t-sm bg-emerald-500" style={{ height: `${(d.used / max) * 100}%` }} />
              <div className="w-full bg-[var(--wms-accent)]" style={{ height: `${(Math.max(0, d.signups - d.used) / max) * 100}%` }} />
            </div>
          ))}
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">No signups yet.</p>
      )}
    </div>
  );
}

function Offer({ report, busy, onSave }: { report: WelcomeReport; busy: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const s = report.settings;
  const [percent, setPercent] = useState(String(s.percentOff));
  const [days, setDays] = useState(String(s.validDays));
  const [delay, setDelay] = useState(String(s.delaySeconds));
  const num = { type: "text", inputMode: "numeric", pattern: "[0-9]*", autoComplete: "off", enterKeyHint: "done" } as const;
  const p = Number(percent);
  const d = Number(days);
  const w = Number(delay);
  const valid = Number.isInteger(p) && p >= 1 && p <= 50 && Number.isInteger(d) && d >= 1 && d <= 365 && Number.isInteger(w) && w >= 0 && w <= 120;
  return (
    <div className={card}>
      <p className="mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Offer</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Percent off
          <input id="welcome-percent" value={percent} onChange={(e) => setPercent(e.target.value)} {...num} className={`${field} w-20`} />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Code valid (days)
          <input id="welcome-days" value={days} onChange={(e) => setDays(e.target.value)} {...num} className={`${field} w-20`} />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Opens after (seconds)
          <input id="welcome-delay" value={delay} onChange={(e) => setDelay(e.target.value)} {...num} className={`${field} w-20`} />
        </label>
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => onSave({ percentOff: p, validDays: d, delaySeconds: w })}
          className={`${btn} border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]`}
        >
          Save
        </button>
        <a href={PREVIEW_URL} target="_blank" rel="noreferrer" className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)] max-md:flex max-md:items-center`}>
          Preview on the store
        </a>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-[var(--wms-fg)] max-md:min-h-11">
        <input
          id="welcome-send-email"
          type="checkbox"
          className="mt-1 h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
          checked={s.sendEmail}
          disabled={busy}
          onChange={(e) => onSave({ sendEmail: e.target.checked })}
        />
        <span>
          Email the code too
          <span className="block font-mono text-[0.68rem] text-[var(--wms-muted)]">
            From support@shopcarbon.com, in the shopper&apos;s language, with an unsubscribe link. The popup shows the code either way.
          </span>
        </span>
      </label>
      <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
        New percent and days apply to new signups; codes already given keep theirs. The preview opens the popup in your browser only, even
        while it is off — signing up there makes a real code.
      </p>
    </div>
  );
}

function Signups({ report }: { report: WelcomeReport }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return report.recent;
    return report.recent.filter((r) => [r.email, r.code, r.path, r.orderName, r.country].some((x) => (x ?? "").toLowerCase().includes(t)));
  }, [q, report.recent]);
  const status = (r: WelcomeReport["recent"][number]) =>
    r.status === "used" ? (
      <span className="text-[var(--wms-status-success-fg)]">Used{r.orderName ? ` · ${r.orderName}` : ""}{r.orderTotal !== null ? ` · ${money(r.orderTotal)}` : ""}</span>
    ) : r.status === "expired" ? (
      <span className="text-[var(--wms-muted)]">Expired {day(r.endsAt)}</span>
    ) : (
      <span>Open until {day(r.endsAt)}</span>
    );
  return (
    <div className={card}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Latest signups</p>
        <input
          id="welcome-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email, code, order…"
          className={`${field} w-56 max-md:w-full`}
        />
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse">
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Email</th>
                <th className={th}>Code</th>
                <th className={th}>Status</th>
                <th className={th}>Customer</th>
                <th className={th}>Welcome email</th>
                <th className={th}>Page</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-t border-[var(--wms-border)]">
                  <td className={`${td} whitespace-nowrap`}>{when(r.createdAt)}</td>
                  <td className={td}>
                    {r.email}
                    {r.unsubscribed ? <span className="ml-1 font-mono text-[0.66rem] text-[var(--wms-muted)]">unsubscribed</span> : null}
                  </td>
                  <td className={`${td} whitespace-nowrap font-mono`}>{r.code}</td>
                  <td className={`${td} whitespace-nowrap`}>{status(r)}</td>
                  <td className={td}>{r.existingCustomer ? "Already a customer" : "New"}</td>
                  <td className={td}>
                    {r.emailError ? (
                      <span className="text-[var(--wms-status-danger-fg)]" title={r.emailError}>
                        Failed
                      </span>
                    ) : r.emailedAt ? (
                      "Sent"
                    ) : (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className={`${td} max-w-[14rem] truncate font-mono text-[0.72rem]`} title={r.path ?? ""}>
                    {r.path ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{q ? "Nothing matches." : "No signups yet."}</p>
      )}
    </div>
  );
}
