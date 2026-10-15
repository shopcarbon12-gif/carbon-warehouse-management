"use client";

import useSWR from "swr";
import Link from "next/link";
import { useMemo, useState } from "react";

/**
 * Counts → Combine & review (owner, 2026-10-15): pick a Count file and the
 * Add-On files scanned against it, see the combined result against the live
 * WMS, then push it once — add to current stock, or override the entire stock
 * (every live tag the count did not see goes to unknown). Server:
 * lib/server/count-review.ts.
 */

type CountFile = {
  id: string;
  activity: string;
  filename: string;
  rowCount: number;
  uploadedAt: string;
  deviceId: string | null;
  uploadedBy: string;
  pushedAt: string | null;
  pushMode: string | null;
};
type TagRow = {
  epc: string;
  status: string;
  product: string | null;
  upc: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
  lastSeenAt: string | null;
  location: string | null;
  file: string | null;
};
type ManualRow = { customSkuId: string; sku: string; product: string | null; color: string | null; size: string | null; qty: number };
type Review = {
  locationName: string;
  files: CountFile[];
  alreadyPushed: CountFile[];
  scanned: number;
  perFile: Array<{ id: string; filename: string; tags: number; newToCombined: number }>;
  alreadyLive: number;
  willGoLive: TagRow[];
  liveElsewhere: TagRow[];
  newTags: TagRow[];
  defective: TagRow[];
  killedProducts: TagRow[];
  killedNoProduct: TagRow[];
  otherStatus: TagRow[];
  missing: TagRow[];
  missingTotal: number;
  manual: ManualRow[];
  manualUnits: number;
};
type PushResult = {
  mode: "add" | "override";
  scanned: number;
  wentLive: number;
  stayedSame: number;
  revived: number;
  zeroedToUnknown: number;
  manualZeroed: number;
  manualUnitsZeroed: number;
};

const ET = "America/New_York";
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: ET, month: "2-digit", day: "2-digit", year: "numeric" });
const n = (v: number) => v.toLocaleString("en-US");

const btn =
  "rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 max-md:min-h-11";
const btnPrimary =
  "rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-45 max-md:min-h-11";

const fetchFiles = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load the count files (HTTP ${r.status})`);
  return (await r.json()) as { files: CountFile[]; isSuperAdmin: boolean };
};

function Tile({ value, label, tone }: { value: string; label: string; tone?: "warn" | "bad" | "good" }) {
  const color =
    tone === "bad"
      ? "text-[var(--wms-status-danger-fg)]"
      : tone === "warn"
        ? "text-[var(--wms-status-warning-fg)]"
        : tone === "good"
          ? "text-[var(--wms-status-success-fg,var(--wms-fg))]"
          : "text-[var(--wms-fg)]";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5">
      <span className={`font-mono text-xl font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-[0.72rem] leading-snug text-[var(--wms-muted)]">{label}</span>
    </div>
  );
}

function TagTable({ rows, pick }: { rows: TagRow[]; pick?: { selected: Set<string>; toggle: (epc: string) => void } }) {
  return (
    <div className="max-h-[28rem] w-full overflow-auto rounded border border-[var(--wms-border)] [contain:inline-size]">
      <table className="w-full min-w-[720px] border-collapse font-mono text-[0.72rem]">
        <thead className="sticky top-0 bg-[var(--wms-surface-elevated)] text-left text-[var(--wms-muted)]">
          <tr>
            {pick ? <th className="px-2 py-1.5">Bring back</th> : null}
            <th className="px-2 py-1.5">Product</th>
            <th className="px-2 py-1.5">Custom SKU</th>
            <th className="px-2 py-1.5">Colour</th>
            <th className="px-2 py-1.5">Size</th>
            <th className="px-2 py-1.5">Bin</th>
            <th className="px-2 py-1.5">EPC</th>
            <th className="px-2 py-1.5">Last seen</th>
            <th className="px-2 py-1.5">Found in</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.epc} className="border-t border-[var(--wms-border)]">
              {pick ? (
                <td className="px-2 py-1">
                  <input type="checkbox" checked={pick.selected.has(t.epc)} onChange={() => pick.toggle(t.epc)} aria-label={`Bring ${t.epc} back to live`} />
                </td>
              ) : null}
              <td className="px-2 py-1 text-[var(--wms-fg)]">
                {t.product ?? <span className="text-[var(--wms-muted)]">no product</span>}
                {t.upc ? <span className="ml-1 text-[var(--wms-muted)]">· {t.upc}</span> : null}
              </td>
              <td className="px-2 py-1">{t.sku ?? "—"}</td>
              <td className="px-2 py-1">{t.color ?? "—"}</td>
              <td className="px-2 py-1">{t.size ?? "—"}</td>
              <td className="px-2 py-1">{t.bin ?? "—"}</td>
              <td className="px-2 py-1 select-all">{t.epc}</td>
              <td className="px-2 py-1 whitespace-nowrap">{when(t.lastSeenAt)}</td>
              <td className="px-2 py-1">{t.file ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  count,
  note,
  csv,
  children,
  open,
  tone,
}: {
  title: string;
  count: number;
  note?: string;
  csv?: string;
  children?: React.ReactNode;
  open?: boolean;
  tone?: "warn" | "bad";
}) {
  if (!count) return null;
  const color = tone === "bad" ? "text-[var(--wms-status-danger-fg)]" : tone === "warn" ? "text-[var(--wms-status-warning-fg)]" : "text-[var(--wms-fg)]";
  return (
    <details open={open} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2">
      <summary className="cursor-pointer font-mono text-sm">
        <span className={`font-semibold ${color}`}>{title}</span> <span className="tabular-nums text-[var(--wms-muted)]">({n(count)})</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {note ? <p className="text-[0.78rem] text-[var(--wms-muted)]">{note}</p> : null}
        {csv ? (
          <a href={csv} className="self-start font-mono text-[0.72rem] text-[var(--wms-accent)] underline underline-offset-2">
            Download CSV
          </a>
        ) : null}
        {children}
      </div>
    </details>
  );
}

export function CountReviewWorkspace() {
  const { data, error, mutate } = useSWR("/api/reports/count-review", fetchFiles);
  const files = useMemo(() => data?.files ?? [], [data]);
  const isSuperAdmin = !!data?.isSuperAdmin;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<"review" | "push" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"add" | "override">("add");
  const [confirmText, setConfirmText] = useState("");
  const [revive, setRevive] = useState<Set<string>>(new Set());
  const [zeroManual, setZeroManual] = useState(false);
  const [result, setResult] = useState<PushResult | null>(null);

  const days = useMemo(() => {
    const m = new Map<string, CountFile[]>();
    for (const f of files) {
      if (f.pushedAt) continue;
      const d = dayOf(f.uploadedAt);
      m.set(d, [...(m.get(d) ?? []), f]);
    }
    return [...m.entries()];
  }, [files]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const runReview = async (ids: string[]) => {
    setBusy("review");
    setErr(null);
    setResult(null);
    setRevive(new Set());
    setConfirmText("");
    try {
      const r = await fetch("/api/reports/count-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportIds: ids }),
      });
      const j = (await r.json().catch(() => ({}))) as { review?: Review; error?: string };
      if (!r.ok || !j.review) throw new Error(j.error ?? `Review failed (HTTP ${r.status})`);
      setReview(j.review);
      setReviewedIds(ids);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    if (!review) return;
    setBusy("push");
    setErr(null);
    try {
      const r = await fetch("/api/reports/count-review/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportIds: reviewedIds,
          mode,
          confirmZeroCount: mode === "override" ? Number(confirmText) : null,
          reviveEpcs: [...revive],
          zeroManual: mode === "override" && zeroManual,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { result?: PushResult; error?: string };
      if (!r.ok || !j.result) throw new Error(j.error ?? `Push failed (HTTP ${r.status})`);
      setResult(j.result);
      setSelected(new Set());
      void mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(null);
    }
  };

  const csv = (list: string) => `/api/reports/count-review/csv?ids=${reviewedIds.join(",")}&list=${list}`;
  const confirmOk = mode === "add" || (confirmText.trim() !== "" && Number(confirmText) === review?.missingTotal);
  const canPush = !!review && !result && !review.alreadyPushed.length && confirmOk && busy === null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Link href="/reports/count-sessions" className="self-start font-mono text-xs text-[var(--wms-accent)] underline underline-offset-2">
        ← Count session reports
      </Link>

      {/* 1. Pick the files */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-[var(--wms-muted)]">1 · Pick the count files</h2>
        {error ? <p className="font-mono text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p> : null}
        {days.length ? (
          <div className="flex flex-wrap gap-2">
            {days.map(([d, fs]) => (
              <button key={d} type="button" className={btn} onClick={() => setSelected(new Set(fs.map((f) => f.id)))}>
                {d} — {fs.filter((f) => f.activity === "MOBILE COUNT").length} Count + {fs.filter((f) => f.activity === "ADD-ON COUNT").length} Add-On
              </button>
            ))}
          </div>
        ) : null}
        <div className="max-h-80 w-full overflow-auto rounded border border-[var(--wms-border)] [contain:inline-size]">
          <table className="w-full min-w-[640px] border-collapse font-mono text-[0.72rem]">
            <thead className="sticky top-0 bg-[var(--wms-surface-elevated)] text-left text-[var(--wms-muted)]">
              <tr>
                <th className="px-2 py-1.5" />
                <th className="px-2 py-1.5">File</th>
                <th className="px-2 py-1.5">Type</th>
                <th className="px-2 py-1.5 text-right">Tags</th>
                <th className="px-2 py-1.5">Uploaded</th>
                <th className="px-2 py-1.5">By</th>
                <th className="px-2 py-1.5">Pushed</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id} className="border-t border-[var(--wms-border)]">
                  <td className="px-2 py-1">
                    <input type="checkbox" disabled={!!f.pushedAt} checked={selected.has(f.id)} onChange={() => toggle(f.id)} aria-label={`Select ${f.filename}`} />
                  </td>
                  <td className="px-2 py-1 text-[var(--wms-fg)]">{f.filename}</td>
                  <td className="px-2 py-1">{f.activity === "MOBILE COUNT" ? "Count" : "Add-On"}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(f.rowCount)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{when(f.uploadedAt)}</td>
                  <td className="px-2 py-1">{f.uploadedBy || "—"}</td>
                  <td className="px-2 py-1">{f.pushedAt ? `${when(f.pushedAt)} · ${f.pushMode === "override" ? "override" : "add"}` : "—"}</td>
                </tr>
              ))}
              {!files.length && data ? (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-[var(--wms-muted)]">
                    No Count or Add-On files in the last 30 days.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-[0.75rem] text-[var(--wms-muted)]">
          Every Add-On save holds the whole session so far, so ticking them all is safe — each tag is counted once.
        </p>
        <button type="button" className={`${btnPrimary} self-start`} disabled={!selected.size || busy !== null} onClick={() => void runReview([...selected])}>
          {busy === "review" ? "Combining…" : `Combine & review (${selected.size})`}
        </button>
        {err && !review ? <p className="font-mono text-xs text-[var(--wms-status-danger-fg)]">{err}</p> : null}
      </section>

      {/* 2. Review */}
      {review ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-[var(--wms-muted)]">
            2 · Review — {review.locationName}
          </h2>
          {review.alreadyPushed.length ? (
            <p className="rounded border border-[var(--wms-status-danger-fg)]/50 px-3 py-2 font-mono text-xs text-[var(--wms-status-danger-fg)]">
              Already pushed: {review.alreadyPushed.map((f) => f.filename).join(", ")}. Untick them — a file is pushed once.
            </p>
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            <Tile value={n(review.scanned)} label="unique tags scanned" />
            <Tile value={n(review.alreadyLive)} label="already live here — nothing changes" />
            <Tile value={n(review.willGoLive.length + review.newTags.length + review.liveElsewhere.length)} label="will go live here" tone="good" />
            <Tile value={n(review.killedProducts.length + review.killedNoProduct.length)} label="killed in WMS, found on the shelf" tone="warn" />
            <Tile value={n(review.otherStatus.length)} label="sold / damaged / other status, found" tone="warn" />
            <Tile value={n(review.defective.length)} label="not in WMS, no product" tone="warn" />
            <Tile value={n(review.missingTotal)} label="live here, NOT scanned — go to unknown on override" tone="bad" />
            <Tile value={n(review.manualUnits)} label={`non-RFID manual units (${review.manual.length} SKUs)`} />
          </div>

          <details className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2">
            <summary className="cursor-pointer font-mono text-sm text-[var(--wms-fg)]">Files combined ({review.perFile.length})</summary>
            <table className="mt-2 w-full font-mono text-[0.72rem] [overflow-wrap:anywhere]">
              <tbody>
                {review.perFile.map((f) => (
                  <tr key={f.id} className="border-t border-[var(--wms-border)]">
                    <td className="px-2 py-1">{f.filename}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{n(f.tags)} tags</td>
                    <td className="px-2 py-1 text-right tabular-nums text-[var(--wms-muted)]">+{n(f.newToCombined)} new to the total</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <Section title="Will go live — unknown in WMS" count={review.willGoLive.length} csv={csv("willGoLive")}>
            <TagTable rows={review.willGoLive} />
          </Section>
          <Section title="Live at another location — will move here" count={review.liveElsewhere.length} csv={csv("liveElsewhere")}>
            <TagTable rows={review.liveElsewhere} />
          </Section>
          <Section title="New tags — not in WMS yet, will be added live" count={review.newTags.length} csv={csv("newTags")}>
            <TagTable rows={review.newTags} />
          </Section>
          <Section
            title="Killed tags found on the shelf — products"
            count={review.killedProducts.length}
            tone="warn"
            open
            csv={csv("killedProducts")}
            note={
              isSuperAdmin
                ? "Ignored by the push unless you tick them here — ticked tags are brought back to live (super-admin)."
                : "Ignored by the push. Only a super-admin can bring a killed tag back."
            }
          >
            <TagTable
              rows={review.killedProducts}
              pick={
                isSuperAdmin
                  ? {
                      selected: revive,
                      toggle: (epc) =>
                        setRevive((prev) => {
                          const s = new Set(prev);
                          if (s.has(epc)) s.delete(epc);
                          else s.add(epc);
                          return s;
                        }),
                    }
                  : undefined
              }
            />
          </Section>
          <Section
            title="Killed tags with no product"
            count={review.killedNoProduct.length}
            csv={csv("killedNoProduct")}
            note="The EPC doesn't match any custom SKU — an earlier scan filed it as defective. Ignored by the push."
          >
            <TagTable rows={review.killedNoProduct} />
          </Section>
          <Section title="Sold / damaged / other status, found on the shelf" count={review.otherStatus.length} csv={csv("otherStatus")} note="Ignored by the push — a scan never changes these.">
            <TagTable rows={review.otherStatus} />
          </Section>
          <Section title="Not in WMS — no product" count={review.defective.length} csv={csv("defective")} note="Filed as defective by the push, like any count upload.">
            <TagTable rows={review.defective} />
          </Section>
          <Section
            title="Live here but NOT scanned"
            count={review.missingTotal}
            tone="bad"
            open
            csv={csv("missing")}
            note={`Override entire stock sets these to unknown; each comes back to live the next time it is scanned.${review.missing.length < review.missingTotal ? ` Showing the first ${n(review.missing.length)} — the CSV has all.` : ""}`}
          >
            <TagTable rows={review.missing} />
          </Section>
          <Section title="Non-RFID manual stock at this location" count={review.manual.length} csv={csv("manual")} note="Never touched by a push unless you tick “Also zero out manual stock” below.">
            <div className="w-full overflow-auto rounded border border-[var(--wms-border)] [contain:inline-size]">
              <table className="w-full min-w-[480px] font-mono text-[0.72rem]">
                <tbody>
                  {review.manual.map((m) => (
                    <tr key={m.customSkuId} className="border-t border-[var(--wms-border)]">
                      <td className="px-2 py-1">{m.product ?? "—"}</td>
                      <td className="px-2 py-1">{m.sku}</td>
                      <td className="px-2 py-1">{m.color ?? "—"}</td>
                      <td className="px-2 py-1">{m.size ?? "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{m.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* 3. Push */}
          <section className="flex flex-col gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3">
            <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-[var(--wms-muted)]">3 · Push to the WMS</h2>
            <label className="flex items-start gap-2 text-sm text-[var(--wms-fg)]">
              <input type="radio" name="mode" checked={mode === "add"} onChange={() => setMode("add")} className="mt-1" />
              <span>
                <b>Add to current stock</b> — the {n(review.willGoLive.length + review.newTags.length + review.liveElsewhere.length)} tags above go live here.
                Nothing else changes.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-[var(--wms-fg)]">
              <input type="radio" name="mode" checked={mode === "override"} onChange={() => setMode("override")} className="mt-1" />
              <span>
                <b>Override entire stock</b> — the same, and the <b className="text-[var(--wms-status-danger-fg)]">{n(review.missingTotal)}</b> live tags at{" "}
                {review.locationName} that the count did not see go to unknown.
              </span>
            </label>
            {mode === "override" ? (
              <div className="flex flex-col gap-2 pl-6">
                <label className="flex items-start gap-2 text-sm text-[var(--wms-fg)]">
                  <input type="checkbox" checked={zeroManual} onChange={(e) => setZeroManual(e.target.checked)} className="mt-1" disabled={!review.manual.length} />
                  <span>
                    Also zero out non-RFID manual stock ({n(review.manualUnits)} units, {review.manual.length} SKUs)
                  </span>
                </label>
                <label className="grid gap-1 font-mono text-[0.7rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  <span>Type {review.missingTotal} to confirm</span>
                  <input
                    inputMode="numeric"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value.replace(/[^0-9]/g, ""))}
                    className="w-40 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11"
                  />
                </label>
              </div>
            ) : null}
            {revive.size ? (
              <p className="font-mono text-xs text-[var(--wms-status-warning-fg)]">{revive.size} killed tag(s) ticked to bring back to live.</p>
            ) : null}
            <button type="button" className={`${btnPrimary} self-start`} disabled={!canPush} onClick={() => void push()}>
              {busy === "push" ? "Pushing…" : mode === "override" ? "Push — override entire stock" : "Push — add to current stock"}
            </button>
            {err ? <p className="font-mono text-xs text-[var(--wms-status-danger-fg)]">{err}</p> : null}
            {result ? (
              <div className="rounded border border-[var(--wms-accent)]/60 px-3 py-2 text-sm text-[var(--wms-fg)]">
                <b>Pushed ({result.mode === "override" ? "override entire stock" : "add to current stock"}).</b> {n(result.wentLive)} tags went live
                {result.revived ? `, ${n(result.revived)} killed tags brought back` : ""}
                {result.mode === "override" ? `, ${n(result.zeroedToUnknown)} not-scanned tags set to unknown` : ""}
                {result.manualZeroed ? `, ${n(result.manualUnitsZeroed)} manual units zeroed (${result.manualZeroed} SKUs)` : ""}. Shopify quantities are
                syncing now. These files are locked from being pushed again.
              </div>
            ) : null}
          </section>
        </section>
      ) : null}
    </div>
  );
}
