"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import type { WholesaleApplication, WholesaleStatus } from "@/lib/server/wholesale/applications";

/**
 * Shopify → Wholesale (owner 2026-11-03). Applications from the Wholesale page
 * on shopcarbon.com (the form still emails the store contact address too).
 * Approve creates the company and buyer in Shopify — the Wholesale market gives
 * them wholesale prices and the run minimum — and Shopify sends the buyer its
 * customer account invite (Shopify's B2B welcome email is Plus-only). Decline
 * only marks the application; nobody is emailed.
 */

type ListResponse = { applications: WholesaleApplication[]; counts: Record<WholesaleStatus, number> };

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as ListResponse;
};

const ET = "America/New_York";
function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const card = "min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3";
const btn =
  "rounded-md border px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11 max-md:px-3";
const label = "font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]";

const FILTERS: { id: WholesaleStatus | "all"; label: string }[] = [
  { id: "new", label: "Waiting" },
  { id: "approved", label: "Approved" },
  { id: "declined", label: "Declined" },
  { id: "all", label: "All" },
];

const STATUS_CHIP: Record<WholesaleStatus, { text: string; cls: string }> = {
  new: { text: "Waiting", cls: "border-[var(--wms-accent)] text-[var(--wms-accent)]" },
  approved: { text: "Approved", cls: "border-emerald-500/70 text-[var(--wms-status-success-fg)]" },
  declined: { text: "Declined", cls: "border-[var(--wms-border)] text-[var(--wms-muted)]" },
};

/** Shopify admin link for a company GID. */
function companyUrl(gid: string): string {
  const id = gid.split("/").pop();
  return `https://admin.shopify.com/store/shopcarbon1/companies/${id}`;
}

function websiteHref(w: string): string | null {
  const t = w.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("@")) return `https://instagram.com/${t.slice(1)}`;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t)) return `https://${t}`;
  return null;
}

export function WholesaleWorkspace() {
  const params = useSearchParams();
  const focusId = Number(params.get("application")) || null;
  const { data, error, mutate, isLoading } = useSWR<ListResponse>("/api/shopify/wholesale", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  const [filter, setFilter] = useState<WholesaleStatus | "all">("new");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; action: "approve" | "decline" } | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  const shown = useMemo(() => {
    const all = data?.applications ?? [];
    // An alert link opens its application whatever the filter.
    if (focusId && all.some((a) => a.id === focusId) && filter !== "all") {
      return all.filter((a) => a.id === focusId || a.status === filter);
    }
    return filter === "all" ? all : all.filter((a) => a.status === filter);
  }, [data, filter, focusId]);

  async function decide(id: number, action: "approve" | "decline") {
    setBusyId(id);
    setMsg(null);
    setConfirm(null);
    try {
      const r = await fetch(`/api/shopify/wholesale/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; application?: WholesaleApplication };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const a = j.application!;
      setMsg({
        text:
          action === "approve"
            ? `${a.businessName} is approved. Shopify sent ${a.email} an account invite.`
            : `${a.businessName} is declined. No email was sent.`,
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusyId(null);
      await mutate();
    }
  }

  if (error && !data) {
    return <p className="p-4 font-mono text-xs text-[var(--wms-status-danger-fg)]">Could not load wholesale applications: {error.message}</p>;
  }
  if (isLoading || !data) return <p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading wholesale applications…</p>;

  const counts = data.counts;
  const total = counts.new + counts.approved + counts.declined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 border-b border-[var(--wms-border)] pb-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Wholesale</h1>
          <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
            Applications from the Wholesale page on shopcarbon.com (each one is also emailed to support@shopcarbon.com). Approve creates the
            company and its buyer in Shopify: they get wholesale prices (retail ÷ 2.1) and the 3-run minimum, and Shopify sends them an
            account invite (its wording is in Shopify → Settings → Notifications → Customer account invite). Decline only marks the
            application; nobody is emailed.
          </p>
        </div>
        <div role="tablist" aria-label="Show applications" className="flex w-fit max-w-full flex-wrap overflow-hidden rounded-md border border-[var(--wms-border)]">
          {FILTERS.map((f) => {
            const n = f.id === "all" ? total : counts[f.id];
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide max-md:min-h-11 ${
                  filter === f.id ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                }`}
              >
                {f.label} <span className="tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {msg ? (
        <p role="status" className={`font-mono text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-status-success-fg)]"}`}>
          {msg.text}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className={`${card} font-mono text-xs text-[var(--wms-muted)]`}>
          {filter === "new" ? "No applications waiting." : "Nothing here yet."} New ones arrive from shopcarbon.com/pages/wholesale.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((a) => {
            const chip = STATUS_CHIP[a.status];
            const site = a.website ? websiteHref(a.website) : null;
            const busy = busyId === a.id;
            const asking = confirm?.id === a.id ? confirm.action : null;
            return (
              <li
                key={a.id}
                className={`${card} ${focusId === a.id ? "ring-2 ring-[var(--wms-accent)]" : ""}`}
                aria-label={`Application from ${a.businessName}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-base font-semibold text-[var(--wms-fg)]">{a.businessName}</p>
                    <p className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
                      #{a.id} · applied {when(a.createdAt)}
                      {a.decidedAt ? ` · ${a.status} ${when(a.decidedAt)}${a.decidedBy ? ` by ${a.decidedBy}` : ""}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[0.66rem] uppercase tracking-wide ${chip.cls}`}>
                    {chip.text}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="min-w-0">
                    <dt className={label}>Contact</dt>
                    <dd className="break-words text-sm text-[var(--wms-fg)]">{a.contactName || "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={label}>Email</dt>
                    <dd className="break-all text-sm">
                      <a className="text-[var(--wms-accent)] underline-offset-2 hover:underline" href={`mailto:${a.email}`}>
                        {a.email}
                      </a>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={label}>Phone</dt>
                    <dd className="text-sm text-[var(--wms-fg)]">
                      {a.phone ? (
                        <a className="text-[var(--wms-accent)] underline-offset-2 hover:underline" href={`tel:${a.phone.replace(/[^\d+]/g, "")}`}>
                          {a.phone}
                        </a>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={label}>City and state</dt>
                    <dd className="break-words text-sm text-[var(--wms-fg)]">{a.cityState}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={label}>Type of store</dt>
                    <dd className="text-sm text-[var(--wms-fg)]">{a.storeType || "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={label}>Website or Instagram</dt>
                    <dd className="break-all text-sm text-[var(--wms-fg)]">
                      {a.website ? (
                        site ? (
                          <a className="text-[var(--wms-accent)] underline-offset-2 hover:underline" href={site} target="_blank" rel="noreferrer noopener">
                            {a.website}
                          </a>
                        ) : (
                          a.website
                        )
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  {a.message ? (
                    <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                      <dt className={label}>Comment</dt>
                      <dd className="whitespace-pre-wrap break-words text-sm text-[var(--wms-fg)]">{a.message}</dd>
                    </div>
                  ) : null}
                </dl>

                {a.lastError && a.status === "new" ? (
                  <p className="mt-3 font-mono text-xs text-[var(--wms-status-danger-fg)]">Last approve attempt: {a.lastError}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {a.status === "new" ? (
                    asking ? (
                      <>
                        <span className="font-mono text-xs text-[var(--wms-fg)]">
                          {asking === "approve"
                            ? `Create ${a.businessName} in Shopify and send ${a.email} an account invite?`
                            : `Decline ${a.businessName}? Nobody is emailed.`}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void decide(a.id, asking)}
                          className={`${btn} ${
                            asking === "approve"
                              ? "border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]"
                              : "border-[var(--wms-status-danger-fg)] text-[var(--wms-status-danger-fg)]"
                          }`}
                        >
                          {asking === "approve" ? "Yes, approve" : "Yes, decline"}
                        </button>
                        <button type="button" onClick={() => setConfirm(null)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirm({ id: a.id, action: "approve" })}
                          className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]`}
                        >
                          {busy ? "Working…" : a.lastError ? "Try approve again" : "Approve"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirm({ id: a.id, action: "decline" })}
                          className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}
                        >
                          Decline
                        </button>
                      </>
                    )
                  ) : null}
                  {a.shopifyCompanyGid ? (
                    <a
                      href={companyUrl(a.shopifyCompanyGid)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)] max-md:inline-flex max-md:items-center`}
                    >
                      Open company in Shopify
                    </a>
                  ) : null}
                  {a.status === "approved" ? (
                    <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
                      {a.welcomeEmailSent ? "Shopify sent the account invite." : "No account invite was sent."}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
