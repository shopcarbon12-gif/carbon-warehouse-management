"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, label } from "./marketing-shared";

/**
 * Social → Merchant Center. Every problem Google reports on the shop's
 * products, grouped by problem: "Not shown" ones keep the product out of
 * Shopping ads or free listings; "Warning" ones do not.
 */

type Issue = { offerId: string; title: string; link: string | null; image: string | null; severity: string; description: string; detail: string | null; attribute: string | null; destinations: string[] };
type Data = { merchantId: string; products: number; issues: Issue[] };

const SEV: Record<string, string> = { DISAPPROVED: "Not shown", DEMOTED: "Shown less", NOT_IMPACTED: "Warning" };
const ORDER = ["DISAPPROVED", "DEMOTED", "NOT_IMPACTED"];

export function MarketingMerchantWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<Data>("/api/marketing/merchant", fetcher);
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, { severity: string; description: string; detail: string | null; items: Issue[] }>();
    for (const i of data?.issues ?? []) {
      const k = `${i.severity}|${i.description}`;
      const g = m.get(k) ?? { severity: i.severity, description: i.description, detail: i.detail, items: [] };
      g.items.push(i);
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => ORDER.indexOf(a[1].severity) - ORDER.indexOf(b[1].severity) || b[1].items.length - a[1].items.length);
  }, [data]);
  const notShown = new Set((data?.issues ?? []).filter((i) => i.severity === "DISAPPROVED").map((i) => i.offerId)).size;

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Social · Merchant Center</h1>
          <p className="text-xs text-[var(--wms-muted)]">
            {data ? `${data.products.toLocaleString("en-US")} listings · ${notShown} not shown somewhere · account ${data.merchantId}` : isLoading ? "Reading Google…" : ""}
          </p>
        </div>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => void mutate()}>
          Refresh
        </button>
      </header>
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {data && !groups.length && <p className={`${card} text-xs text-emerald-700 dark:text-emerald-300`}>Google reports no problems.</p>}
      {groups.map(([k, g]) => (
        <section key={k} className={card}>
          <button type="button" className="flex w-full items-start justify-between gap-2 text-left max-md:min-h-11" onClick={() => setOpen(open === k ? null : k)}>
            <span className="min-w-0">
              <span className={`${label} block ${g.severity === "DISAPPROVED" ? "text-[var(--wms-status-danger-fg)]" : ""}`}>{SEV[g.severity] ?? g.severity}</span>
              <span className="block text-sm text-[var(--wms-fg)]">{g.description}</span>
              {g.detail && <span className="block text-xs text-[var(--wms-muted)]">{g.detail}</span>}
            </span>
            <span className="shrink-0 font-mono text-sm text-[var(--wms-fg)]">{g.items.length}</span>
          </button>
          {open === k && (
            <ul className="mt-2 flex flex-col gap-1 border-t border-[var(--wms-border)] pt-2">
              {g.items.map((i) => (
                <li key={`${i.offerId}:${i.attribute}`} className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
                  {i.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.image} alt="" className="h-10 w-8 shrink-0 rounded-sm object-cover" loading="lazy" />
                  ) : (
                    <span className="h-10 w-8 shrink-0 rounded-sm bg-[var(--wms-surface-elevated)]" />
                  )}
                  <span className="min-w-0 flex-1">
                    {i.link ? (
                      <a className="underline" href={i.link} target="_blank" rel="noreferrer">
                        {i.title}
                      </a>
                    ) : (
                      i.title
                    )}
                    <span className="block font-mono text-[0.62rem] text-[var(--wms-muted)]">
                      {i.offerId}
                      {i.attribute ? ` · ${i.attribute}` : ""}
                      {i.destinations.length ? ` · ${i.destinations.join(", ").toLowerCase().replace(/_/g, " ")}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
