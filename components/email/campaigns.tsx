"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { EmailPreviewFrames } from "./preview-frame";
import { btn, card, etLocalInput, etLocalToIso, etWhen, fetcher, field, label, send } from "@/components/marketing/marketing-shared";

/**
 * Email → Campaigns. A campaign = a converted design + subject + who gets it
 * + an optional personal Shopify code per person + when. Nothing is sent
 * until a person approves it; test emails first. While sending it shows live
 * numbers and can be paused, resumed or cancelled; it also pauses by itself
 * when too many emails bounce.
 */

type Audience = { who: "all" | "subscribed"; sinceYear?: number | null; beforeYear?: number | null; notEmailedDays?: number | null };
type Offer = { amount: number; endsAt: string; minSubtotal: number | null; prefix: string; kind?: "amount" | "percent" };
const offerText = (o: Offer) => (o.kind === "percent" ? `${o.amount}%` : `$${o.amount}`);
type Stats = { total: number; queued: number; sent: number; failed: number; skipped: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number; used: number; sales: number };
type Row = { id: string; name: string; status: string; subject: string; send_at: string | null; pause_reason: string | null; offer: Offer | null; design_title: string | null; created_at: string; stats: Stats | null };
type Campaign = {
  id: string;
  name: string;
  design_id: string | null;
  subject: string;
  preheader: string;
  audience: Audience;
  offer: Offer | null;
  status: string;
  pause_reason: string | null;
  send_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  results_at: string | null;
};
type Detail = { campaign: Campaign; stats: Stats; problems: string[]; reach: number | null; failures: { email: string; error: string | null }[] };
type DesignRow = { id: string; title: string; status: string; has_html: boolean };

const nf = new Intl.NumberFormat("en-US");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

const STATUS: Record<string, { text: string; tone: string }> = {
  draft: { text: "Draft", tone: "border-[var(--wms-border)] text-[var(--wms-muted)]" },
  scheduled: { text: "Approved · scheduled", tone: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  sending: { text: "Sending", tone: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  paused: { text: "Paused", tone: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  sent: { text: "Sent", tone: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  cancelled: { text: "Cancelled", tone: "border-[var(--wms-border)] text-[var(--wms-muted)]" },
};

function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.draft;
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.62rem] uppercase ${s.tone}`}>{s.text}</span>;
}

export function EmailCampaigns({ onOpenDesigner }: { onOpenDesigner: () => void }) {
  const openId = useSearchParams().get("campaign");
  function open(v: string | null) {
    const u = new URL(window.location.href);
    if (v) u.searchParams.set("campaign", v);
    else u.searchParams.delete("campaign");
    window.history.replaceState(null, "", u.toString());
  }
  const { data, error, mutate } = useSWR<{ campaigns: Row[] }>("/api/email/campaigns", fetcher, { refreshInterval: 20_000 });
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function create() {
    setMsg(null);
    try {
      const r = await send<{ id: string }>("/api/email/campaigns", "POST", { name: name.trim() || "New campaign", audience: { who: "all" } });
      setName("");
      await mutate();
      open(r.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create it");
    }
  }

  if (openId) return <CampaignEditor id={openId} onBack={() => (open(null), void mutate())} onOpenDesigner={onOpenDesigner} />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input id="email-new-campaign" className={`${field} min-w-0 flex-1 font-sans text-sm`} placeholder="New campaign name, e.g. Win-back $20 · November" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={create}>
          New campaign
        </button>
      </div>
      {msg && <p className="text-xs text-[var(--wms-status-danger-fg)]">{msg}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs tabular-nums">
          <thead>
            <tr className="text-left">
              {["Campaign", "Status", "When", "Sent", "Opened", "Clicked", "Bounced", "Codes used", "Sales"].map((h) => (
                <th key={h} className={`${label} py-1 pr-2`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.campaigns ?? []).map((c) => (
              <tr key={c.id} className="cursor-pointer border-t border-[var(--wms-border)] hover:bg-[var(--wms-surface-elevated)]" onClick={() => open(c.id)}>
                <td className="py-2 pr-2">
                  <span className="block font-semibold text-[var(--wms-fg)]">{c.name}</span>
                  <span className="block text-[var(--wms-muted)]">{c.subject || "No subject yet"}</span>
                </td>
                <td className="py-2 pr-2">
                  <Pill status={c.status} />
                </td>
                <td className="py-2 pr-2 text-[var(--wms-muted)]">{c.send_at ? etWhen(c.send_at) : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats ? `${nf.format(c.stats.sent)} / ${nf.format(c.stats.total)}` : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats ? pct(c.stats.opened, c.stats.sent) : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats ? pct(c.stats.clicked, c.stats.sent) : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats ? pct(c.stats.bounced, c.stats.sent) : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats && c.offer ? nf.format(c.stats.used) : "—"}</td>
                <td className="py-2 pr-2 text-[var(--wms-fg)]">{c.stats && c.offer ? usd.format(c.stats.sales) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.campaigns.length && <p className="py-3 text-xs text-[var(--wms-muted)]">No campaigns yet. Make a design in the AI Designer first, then a campaign here.</p>}
      </div>
    </div>
  );
}

function CampaignEditor({ id, onBack, onOpenDesigner }: { id: string; onBack: () => void; onOpenDesigner: () => void }) {
  const { data, error, mutate } = useSWR<Detail>(`/api/email/campaigns/${id}`, fetcher, {
    refreshInterval: (d) => (d && ["scheduled", "sending"].includes(d.campaign.status) ? 5000 : 0),
  });
  const { data: designs } = useSWR<{ designs: DesignRow[] }>("/api/email/designs", fetcher);
  const { data: built } = useSWR<{ emails: { id: string; title: string }[] }>("/api/email/editor", fetcher);
  const [draft, setDraft] = useState<Campaign | null>(null);
  const [testTo, setTestTo] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (data && (!draft || draft.id !== data.campaign.id || data.campaign.status !== "draft")) setDraft(data.campaign);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const c = data?.campaign;
  const s = data?.stats;
  const isDraft = c?.status === "draft";
  const audienceKey = useMemo(() => JSON.stringify(draft?.audience ?? { who: "all" }), [draft?.audience]);
  const { data: reach } = useSWR<{ count: number }>(isDraft ? `/api/email/contacts?audience=${encodeURIComponent(audienceKey)}` : null, fetcher);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      if (!draft) return;
      await send(`/api/email/campaigns/${id}`, "PATCH", {
        name: draft.name,
        designId: draft.design_id,
        subject: draft.subject,
        preheader: draft.preheader,
        audience: draft.audience,
        offer: draft.offer,
      });
      await mutate();
      setMsg({ text: "Saved." });
    });

  const action = (a: string, extra: Record<string, unknown> = {}, done?: (r: Record<string, unknown>) => string) =>
    run(a, async () => {
      const r = await send<Record<string, unknown>>(`/api/email/campaigns/${id}/action`, "POST", { action: a, ...extra });
      await mutate();
      setMsg({ text: done ? done(r) : "Done." });
    });

  if (error) return <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>;
  if (!c || !draft || !s) return <p className="text-xs text-[var(--wms-muted)]">Loading…</p>;

  const ready = (designs?.designs ?? []).filter((d) => d.has_html);
  const set = (p: Partial<Campaign>) => setDraft({ ...draft, ...p });
  const setAud = (p: Partial<Audience>) => set({ audience: { ...draft.audience, ...p } });
  const defaultEnds = () => {
    const d = new Date(Date.now() + 21 * 86400_000);
    return new Date(`${d.toISOString().slice(0, 10)}T23:59:00-05:00`).toISOString();
  };
  const dirty = JSON.stringify([draft.name, draft.design_id, draft.subject, draft.preheader, draft.audience, draft.offer]) !== JSON.stringify([c.name, c.design_id, c.subject, c.preheader, c.audience, c.offer]);
  const yearOpts = Array.from({ length: new Date().getFullYear() - 2020 }, (_, i) => 2021 + i);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={onBack}>
          ← All campaigns
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--wms-fg)]">{c.name}</span>
        <Pill status={c.status} />
      </div>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {c.pause_reason && c.status === "paused" && <p className="text-xs text-amber-700 dark:text-amber-300">{c.pause_reason}</p>}

      {!isDraft && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
          {(
            [
              ["Sent", `${nf.format(s.sent)} / ${nf.format(s.total)}`],
              ["Delivered", `${nf.format(s.delivered)} · ${pct(s.delivered, s.sent)}`],
              ["Opened", `${nf.format(s.opened)} · ${pct(s.opened, s.delivered || s.sent)}`],
              ["Clicked", `${nf.format(s.clicked)} · ${pct(s.clicked, s.delivered || s.sent)}`],
              ["Bounced", `${nf.format(s.bounced)} · ${pct(s.bounced, s.sent)}`],
              ["Spam reports", nf.format(s.complained)],
              ["Unsubscribed", nf.format(s.unsubscribed)],
              [c.offer ? "Codes used · sales" : "Failed", c.offer ? `${nf.format(s.used)} · ${usd.format(s.sales)}` : nf.format(s.failed)],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className={card}>
              <span className={`${label} block`}>{k}</span>
              <span className="text-sm font-semibold tabular-nums text-[var(--wms-fg)]">{v}</span>
            </div>
          ))}
        </div>
      )}
      {!isDraft && (
        <div className="flex flex-wrap items-center gap-2">
          {["scheduled", "sending"].includes(c.status) && (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => action("pause", {}, () => "Paused. Nothing more goes out until you resume.")}>
              Pause
            </button>
          )}
          {c.status === "paused" && (
            <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy} onClick={() => action("resume", {}, () => "Resumed.")}>
              Resume
            </button>
          )}
          {["scheduled", "paused"].includes(c.status) && !c.started_at && (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => action("unapprove", {}, () => "Back to draft. You can change it now.")}>
              Back to draft
            </button>
          )}
          {!["sent", "cancelled"].includes(c.status) &&
            (confirmCancel ? (
              <span className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
                Stop for good? Nobody left in the queue will get it.
                <button type="button" className={`${btn} border-red-500 text-red-600`} onClick={() => (setConfirmCancel(false), action("cancel", {}, () => "Cancelled."))}>
                  Yes, cancel
                </button>
                <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setConfirmCancel(false)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => setConfirmCancel(true)}>
                Cancel campaign
              </button>
            ))}
          {c.offer && c.started_at && (
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => action("refresh", {}, () => "Code use and sales read from Shopify.")}>
              {busy === "refresh" ? "Reading Shopify…" : "Refresh sales"}
            </button>
          )}
          <span className="text-[0.68rem] text-[var(--wms-muted)]">
            {c.approved_by ? `Approved by ${c.approved_by}${c.approved_at ? ` · ${etWhen(c.approved_at)}` : ""}` : ""}
            {c.send_at ? ` · Sends ${etWhen(c.send_at)} ET` : ""}
            {c.results_at ? ` · Sales checked ${etWhen(c.results_at)}` : ""}
          </span>
        </div>
      )}
      {!isDraft && data.failures.length > 0 && (
        <div className={card}>
          <span className={`${label} block pb-1`}>Could not send ({nf.format(s.failed)})</span>
          <ul className="text-xs text-[var(--wms-fg)]">
            {data.failures.map((f) => (
              <li key={f.email} className="break-all border-t border-[var(--wms-border)] py-1">
                {f.email}: <span className="text-[var(--wms-muted)]">{f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className={`${card} grid gap-3 md:grid-cols-2`}>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>Campaign name (only you see it)</span>
          <input id="email-c-name" className={field} disabled={!isDraft} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>Email</span>
          <div className="flex gap-2">
            <select id="email-c-design" className={`${field} min-w-0 flex-1`} disabled={!isDraft} value={draft.design_id ?? ""} onChange={(e) => set({ design_id: e.target.value || null })}>
              <option value="">Choose an email…</option>
              {!!built?.emails.length && (
                <optgroup label="Emails (editor)">
                  {built.emails.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {!!ready.length && (
                <optgroup label="AI Designer">
                  {ready.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={onOpenDesigner}>
              Emails
            </button>
          </div>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>Subject ({"{{first_name}}"} puts in their name)</span>
          <input id="email-c-subject" className={field} disabled={!isDraft} value={draft.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>Preview text (shown after the subject in the inbox)</span>
          <input id="email-c-pre" className={field} disabled={!isDraft} value={draft.preheader} maxLength={250} onChange={(e) => set({ preheader: e.target.value })} />
        </label>

        <fieldset className="flex min-w-0 flex-col gap-2 md:col-span-2" disabled={!isDraft}>
          <legend className={label}>Who gets it</legend>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--wms-fg)]">
            <select id="email-c-who" className={field} value={draft.audience.who} onChange={(e) => setAud({ who: e.target.value as Audience["who"] })}>
              <option value="all">Every customer we may email</option>
              <option value="subscribed">Only &quot;subscribed&quot; in Shopify</option>
            </select>
            <span>customers since</span>
            <select id="email-c-since" className={field} value={draft.audience.sinceYear ?? ""} onChange={(e) => setAud({ sinceYear: e.target.value ? Number(e.target.value) : null })}>
              <option value="">any year</option>
              {yearOpts.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span>and before</span>
            <select id="email-c-before" className={field} value={draft.audience.beforeYear ?? ""} onChange={(e) => setAud({ beforeYear: e.target.value ? Number(e.target.value) : null })}>
              <option value="">any year</option>
              {yearOpts.map((y) => (
                <option key={y} value={y + 1}>
                  {y + 1}
                </option>
              ))}
            </select>
            <span>not emailed in the last</span>
            <input
              id="email-c-gap"
              className={`${field} w-16`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={draft.audience.notEmailedDays ?? ""}
              onChange={(e) => setAud({ notEmailedDays: Number(e.target.value.replace(/\D/g, "")) || null })}
            />
            <span>days</span>
          </div>
          <p className="text-xs text-[var(--wms-muted)]">
            {isDraft ? (reach ? <b className="text-[var(--wms-fg)]">{nf.format(reach.count)} people</b> : "Counting…") : <b className="text-[var(--wms-fg)]">{nf.format(s.total)} people</b>}
            {" "}· Unsubscribed, bounced, spam-reporting, fake and staff addresses are always left out. Newest customers get it first.
          </p>
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-2 md:col-span-2" disabled={!isDraft}>
          <legend className={label}>Personal code</legend>
          <label className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
            <input
              id="email-c-offer"
              type="checkbox"
              className="max-md:h-5 max-md:w-5"
              checked={!!draft.offer}
              onChange={(e) => set({ offer: e.target.checked ? { amount: 20, endsAt: defaultEnds(), minSubtotal: null, prefix: "CB20" } : null })}
            />
            Give every person their own single-use Shopify code
          </label>
          {draft.offer && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--wms-fg)]">
              <select
                id="email-c-kind"
                className={`${field} w-24`}
                value={draft.offer.kind ?? "amount"}
                onChange={(e) => {
                  const kind = e.target.value === "percent" ? "percent" : "amount";
                  set({ offer: { ...draft.offer!, kind, amount: kind === "percent" ? Math.min(draft.offer!.amount, 90) : draft.offer!.amount } });
                }}
              >
                <option value="amount">$ off</option>
                <option value="percent">% off</option>
              </select>
              <input
                id="email-c-amount"
                className={`${field} w-20`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={String(draft.offer.amount)}
                onChange={(e) => set({ offer: { ...draft.offer!, amount: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 } })}
              />
              <span>{draft.offer.kind === "percent" ? "percent" : "dollars"} off one order (once per person) · ends</span>
              <input
                id="email-c-ends"
                className={field}
                type="datetime-local"
                value={etLocalInput(draft.offer.endsAt)}
                onChange={(e) => {
                  const iso = etLocalToIso(e.target.value);
                  if (iso) set({ offer: { ...draft.offer!, endsAt: iso } });
                }}
              />
              <span>ET · minimum order $</span>
              <input
                id="email-c-min"
                className={`${field} w-20`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="none"
                value={draft.offer.minSubtotal ?? ""}
                onChange={(e) => set({ offer: { ...draft.offer!, minSubtotal: Number(e.target.value.replace(/[^\d.]/g, "")) || null } })}
              />
              <span>· code starts with</span>
              <input id="email-c-prefix" className={`${field} w-24 uppercase`} value={draft.offer.prefix} maxLength={12} onChange={(e) => set({ offer: { ...draft.offer!, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") } })} />
            </div>
          )}
          <p className="text-[0.68rem] text-[var(--wms-muted)]">
            Online at shopcarbon.com only. Codes don&apos;t combine with other discounts, and unused codes stop working on the end date. Each code is made in Shopify just before that person&apos;s email goes out.
          </p>
        </fieldset>

        {isDraft && (
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || !dirty} onClick={save}>
              {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
            {dirty && <span className="text-[0.68rem] text-amber-700 dark:text-amber-300">Not saved yet</span>}
          </div>
        )}
      </section>

      {draft.design_id && (
        <section className={`${card} flex flex-col gap-2`}>
          <span className={label}>Preview (sample name and code)</span>
          <EmailPreviewFrames designId={draft.design_id} height={560} />
        </section>
      )}

      <section className={`${card} flex flex-col gap-2`}>
        <span className={label}>Test email</span>
        <div className="flex flex-wrap items-center gap-2">
          <input id="email-c-test" className={`${field} min-w-0 flex-1`} type="email" placeholder="Your email (empty = the one you are signed in with)" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button
            type="button"
            className={`${btn} border-[var(--wms-border)]`}
            disabled={!!busy || dirty}
            onClick={() => action("test", testTo.trim() ? { to: testTo.trim() } : {}, (r) => `Test sent to ${String(r.to ?? "you")}. The code in a test (…-TEST00) is a sample and won't work at checkout.`)}
          >
            {busy === "test" ? "Sending…" : "Send test"}
          </button>
        </div>
        {dirty && <p className="text-[0.68rem] text-[var(--wms-muted)]">Save your changes first; the test uses the saved campaign.</p>}
      </section>

      {isDraft && (
        <section className={`${card} flex flex-col gap-2`}>
          <span className={label}>Approve and send</span>
          {data.problems.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-[var(--wms-status-danger-fg)]">
              {data.problems.map((p) => (
                <li key={p}>✗ {p}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">✓ Everything is ready.</p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--wms-fg)]">
            <span>Send</span>
            <input id="email-c-sendat" className={field} type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
            <span>ET (empty = right away)</span>
            {confirmApprove ? (
              <>
                <span className="font-semibold">
                  Send to {nf.format(data.reach ?? 0)} people{draft.offer ? ` with a ${offerText(draft.offer)} code each` : ""}?
                </span>
                <button
                  type="button"
                  className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`}
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmApprove(false);
                    void action("approve", { sendAt: sendAt ? etLocalToIso(sendAt) : null }, (r) => `Approved for ${nf.format(Number(r.recipients ?? 0))} people.`);
                  }}
                >
                  Yes, approve
                </button>
                <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setConfirmApprove(false)}>
                  Not yet
                </button>
              </>
            ) : (
              <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || dirty || data.problems.length > 0} onClick={() => setConfirmApprove(true)}>
                Approve
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
