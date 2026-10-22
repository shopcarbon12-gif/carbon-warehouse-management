"use client";

/**
 * Size Grading home (owner 2026-10-22: "update this page to the new app").
 * Garments are measured on the depth-camera Samsungs with the CarbonGradingAI
 * app; this page is where the WMS side of it lives:
 *  - the app: newest version and its download link,
 *  - progress over the catalogue (one reading per product size),
 *  - scans the app flagged, waiting for a check (→ Scan review),
 *  - what to measure next — cut groups first, then single products,
 *  - an item lookup showing what is saved for each size (first: it is what the page is opened for).
 * The old in-browser photo measuring (camera, tap the target's corners,
 * sample size chart) is gone: the app does all of that now.
 */
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Smartphone, Download, AlertTriangle, ListChecks, Layers, Ruler } from "lucide-react";
import { ItemPicker, type PickedItem, type PickedSize } from "./item-picker";
import { SizeGradingSection } from "./item-card-section";
import type { QueueResult } from "@/lib/server/grading-app";

const fetcher = async <T,>(u: string): Promise<T> => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
};

type Release = { version: string; notes: string | null; downloadUrl: string } | null;

const card = "min-w-0 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4";
const label = "font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]";
const link =
  "font-mono text-xs text-[var(--wms-accent)] hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center";

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function GradingHub() {
  const queue = useSWR<QueueResult>("/api/grading-app/queue?limit=200", fetcher, { refreshInterval: 60_000, revalidateOnFocus: false });
  const rel = useSWR<{ release: Release }>("/api/grading-app/releases", fetcher, { revalidateOnFocus: false });
  const [item, setItem] = useState<PickedItem | null>(null);
  const [size, setSize] = useState<PickedSize | null>(null);
  const [showAll, setShowAll] = useState(false);

  const q = queue.data;
  const pct = q && q.progress.total ? Math.round((q.progress.measured / q.progress.total) * 100) : 0;
  const entries = q ? (showAll ? q.entries : q.entries.slice(0, 12)) : [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* One item */}
      <section className={card} aria-labelledby="sg-item">
        <h2 id="sg-item" className="text-sm font-semibold text-[var(--wms-fg)]">Look up an item</h2>
        <p className="mt-1 mb-3 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          What is saved for each size — the app&apos;s measurements and the factory sheet. Lines are moved in Scan review.
        </p>
        <ItemPicker
          item={item}
          size={size}
          onPick={(i) => {
            setItem(i);
            setSize(null);
          }}
          onPickSize={setSize}
        />
        {item && size ? (
          <div className="mt-3">
            <SizeGradingSection key={size.customSkuId} customSkuId={size.customSkuId} editable category={item.category} subcategory={item.subcategory} />
          </div>
        ) : item ? (
          <p className="mt-3 font-mono text-xs text-[var(--wms-muted)]">Pick a size.</p>
        ) : null}
      </section>

      <div className="grid min-w-0 gap-4 md:grid-cols-3">
        {/* The app */}
        <section className={card} aria-labelledby="sg-app">
          <h2 id="sg-app" className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
            <Smartphone className="h-4 w-4 text-[var(--wms-accent)]" aria-hidden /> CarbonGradingAI app
          </h2>
          {rel.data?.release ? (
            <>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">v{rel.data.release.version}</p>
              <a href={rel.data.release.downloadUrl} className={`${link} mt-3 inline-flex items-center gap-1.5`}>
                <Download className="h-3.5 w-3.5" aria-hidden /> Download the APK
              </a>
            </>
          ) : (
            <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">{rel.error ? rel.error.message : rel.isLoading ? "Loading…" : "No release yet."}</p>
          )}
          <a href="/inventory/size-grading/target" target="_blank" rel="noreferrer" className={`${link} mt-2 inline-block`}>
            Print the accuracy-check target (18×24 cm)
          </a>
        </section>

        {/* Progress */}
        <section className={card} aria-labelledby="sg-progress">
          <h2 id="sg-progress" className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
            <Ruler className="h-4 w-4 text-[var(--wms-accent)]" aria-hidden /> Catalogue measured
          </h2>
          {q ? (
            <>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">
                {pct}% <span className="text-sm font-normal text-[var(--wms-muted)]">· {q.progress.measured.toLocaleString()} of {q.progress.total.toLocaleString()} sizes</span>
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-[var(--wms-accent)]" style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">{queue.error ? queue.error.message : "Loading…"}</p>
          )}
        </section>

        {/* Shortcuts */}
        <section className={card} aria-labelledby="sg-work">
          <h2 id="sg-work" className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
            <ListChecks className="h-4 w-4 text-[var(--wms-accent)]" aria-hidden /> Review
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            <li>
              <Link href="/inventory/size-grading/review?status=flagged" className="flex items-baseline justify-between gap-2 text-sm text-[var(--wms-fg)] hover:underline max-md:min-h-11 max-md:items-center">
                <span>Scans that need a check</span>
                <span className={`font-mono tabular-nums ${q?.needsCheck.length ? "text-[var(--wms-status-warning-fg)]" : "text-[var(--wms-muted)]"}`}>
                  {q ? q.needsCheck.length : "—"}
                </span>
              </Link>
            </li>
            <li>
              <Link href="/inventory/size-grading/review" className="flex items-baseline justify-between gap-2 text-sm text-[var(--wms-fg)] hover:underline max-md:min-h-11 max-md:items-center">
                <span>All scans · accuracy checks</span>
                <span className="font-mono text-[var(--wms-muted)]">→</span>
              </Link>
            </li>
            <li>
              <Link href="/inventory/size-grading/cut-groups" className="flex items-baseline justify-between gap-2 text-sm text-[var(--wms-fg)] hover:underline max-md:min-h-11 max-md:items-center">
                <span>Cut groups</span>
                <span className="font-mono tabular-nums text-[var(--wms-muted)]">{q ? q.groups : "—"}</span>
              </Link>
            </li>
          </ul>
        </section>
      </div>

      {/* Waiting for a check */}
      {q?.needsCheck.length ? (
        <section className={card} aria-labelledby="sg-flagged">
          <h2 id="sg-flagged" className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
            <AlertTriangle className="h-4 w-4 text-[var(--wms-status-warning-fg)]" aria-hidden /> Waiting for a check
          </h2>
          <ul className="mt-2 divide-y divide-[var(--wms-border)]">
            {q.needsCheck.map((s) => (
              <li key={s.scanId}>
                <Link
                  href={`/inventory/size-grading/review?status=flagged&scan=${encodeURIComponent(s.scanId)}`}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11"
                >
                  <span className="text-sm font-medium text-[var(--wms-fg)]">
                    {s.name ?? "Item"}
                    {s.size ? ` · ${s.size}` : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-[var(--wms-muted)]">{s.flags.join(" · ") || "Flagged"}</span>
                  <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">{ago(s.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Measure next */}
      <section className={card} aria-labelledby="sg-next">
        <h2 id="sg-next" className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
          <Layers className="h-4 w-4 text-[var(--wms-accent)]" aria-hidden /> Measure next
        </h2>
        {q ? (
          entries.length ? (
            <>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left max-md:min-w-0 text-sm">
                  <thead>
                    <tr className={label}>
                      <th className="py-1.5 pr-3 font-normal">Item</th>
                      <th className="py-1.5 pr-3 font-normal">Size</th>
                      <th className="py-1.5 pr-3 font-normal max-md:hidden">Covers</th>
                      <th className="py-1.5 font-normal"><span className="max-md:hidden">Take off the rail</span><span className="md:hidden">SKU</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--wms-border)]">
                    {entries.map((e) => (
                      <tr key={`${e.kind}-${e.cutGroupId ?? e.matrixId}-${e.size}`}>
                        <td className="py-2 pr-3 text-[var(--wms-fg)]">
                          {e.kind === "cut" ? (
                            <Link href={`/inventory/size-grading/cut-groups?group=${encodeURIComponent(e.cutGroupId!)}`} className="hover:underline">
                              <span className="mr-1.5 rounded border border-[var(--wms-accent)] px-1 font-mono text-[0.62rem] uppercase text-[var(--wms-accent)]">Cut</span>
                              {e.name}
                            </Link>
                          ) : (
                            e.name
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono tabular-nums text-[var(--wms-fg)]">{e.size}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-[var(--wms-muted)] max-md:hidden">
                          {e.products} product{e.products === 1 ? "" : "s"}
                        </td>
                        <td className="py-2 font-mono text-xs text-[var(--wms-muted)]">{e.sampleSku ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {q.entries.length > 12 ? (
                <button type="button" onClick={() => setShowAll((v) => !v)} className={`${link} mt-2`}>
                  {showAll ? "Show fewer" : `Show all ${q.entries.length}${q.entries.length >= 200 ? "+" : ""}`}
                </button>
              ) : null}
            </>
          ) : (
            <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">Everything on the store is measured.</p>
          )
        ) : (
          <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">{queue.error ? queue.error.message : "Loading…"}</p>
        )}
      </section>

    </div>
  );
}
