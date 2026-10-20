"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  CarbonStudioTab,
  type BulkStudioApi,
  type BulkStudioStatus,
} from "@/components/inventory/catalog/carbon-studio-tab";

/**
 * Inventory › Bulk Studio (owner, 2026-10-20).
 *
 * Many products on one page. Each item is the product's own Studio tab in
 * bulk mode — the same photos, label, spec and options, saved to the same
 * per-product Studio state — so nothing here is a second copy of the Studio:
 *  - Analyze all = each product's "Analyze photos", exactly as the Studio does it.
 *  - Send batch  = each product's "Add to tonight's batch" (all four panels),
 *    then one OpenAI batch send for the whole queue (or left for 1 AM).
 *
 * The list of items (which products are on the page) is a per-browser
 * convenience kept in localStorage; everything else lives with the product.
 */

type Matrix = {
  id: string;
  description: string | null;
  upc: string | null;
  category: string | null;
  subcategory_1: string | null;
  shopify_product_id?: string | null;
  image_urls?: string[] | null;
};
type Variant = { id: string; color: string | null; shopify_variant_id?: string | null; archived?: boolean };
type MatrixDetail = { matrix: Matrix; variants: Variant[] };
type SearchRow = { matrix_id: string; upc: string | null; name: string; vendor: string | null };

type Item = { key: string; matrixId: string | null };

const STORE_KEY = "wms_bulk_studio_items_v1";
const PANELS_PER_ITEM = 4;
/** Logged batch cost per panel (memory: ≈ $0.075 in batch vs ≈ $0.15 live). */
const BATCH_COST_PER_PANEL = 0.075;

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j;
};

function newKey() {
  return Math.random().toString(36).slice(2, 10);
}

function readItems(): Item[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as Item[]) : [];
    const ok = Array.isArray(list) ? list.filter((x) => x && typeof x.key === "string") : [];
    return ok.length ? ok : [{ key: newKey(), matrixId: null }];
  } catch {
    return [{ key: newKey(), matrixId: null }];
  }
}

const btn =
  "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11";

export function BulkStudioWorkspace({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<"studio" | "upload">("studio");
  const [items, setItems] = useState<Item[]>([{ key: "init", matrixId: null }]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // localStorage is only readable after mount (no SSR mismatch).
    setItems(readItems());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(items));
    } catch {
      /* private window — the list just isn't remembered */
    }
  }, [items, loaded]);

  const apis = useRef(new Map<string, BulkStudioApi>());
  const [statuses, setStatuses] = useState<Record<string, BulkStudioStatus>>({});
  const [running, setRunning] = useState<null | "analyze" | "send">(null);
  const [barMsg, setBarMsg] = useState<{ text: string; tone: "info" | "ok" | "warn" | "err" } | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  /** Per item: what the last Analyze all / Send batch did to it. */
  const [stepNote, setStepNote] = useState<Record<string, string>>({});

  const register = useCallback((key: string, api: BulkStudioApi | null) => {
    if (api) apis.current.set(key, api);
    else apis.current.delete(key);
  }, []);
  const report = useCallback((key: string, s: BulkStudioStatus) => {
    setStatuses((prev) => ({ ...prev, [key]: s }));
  }, []);

  const picked = items.filter((i) => i.matrixId);
  const st = (i: Item) => statuses[i.key];
  const analyzable = picked.filter((i) => {
    const s = st(i);
    return s && !s.busy && s.spec !== "ready" && s.analyzeProblems.length === 0;
  });
  const sendable = picked.filter((i) => {
    const s = st(i);
    return s && !s.busy && s.sendProblems.length === 0;
  });
  const photoTotal = picked.reduce((n, i) => n + (st(i)?.photoCount ?? 0), 0);
  const analysedTotal = picked.filter((i) => st(i)?.spec === "ready").length;
  const openTotal = picked.reduce((n, i) => n + (st(i)?.batchOpen ?? 0), 0);
  const readyTotal = picked.reduce((n, i) => n + (st(i)?.batchReady ?? 0), 0);

  const analyzeAll = useCallback(async () => {
    const list = analyzable;
    if (!list.length) return;
    setRunning("analyze");
    setBarMsg({ text: `Analyzing ${list.length} item${list.length === 1 ? "" : "s"} — two at a time, exactly as the Studio tab does…`, tone: "info" });
    let next = 0;
    let ok = 0;
    const failed: string[] = [];
    const worker = async () => {
      while (next < list.length) {
        const it = list[next++];
        const api = apis.current.get(it.key);
        if (!api) continue;
        setStepNote((p) => ({ ...p, [it.key]: "Analyzing…" }));
        const done = await api.analyze().catch(() => false);
        setStepNote((p) => ({ ...p, [it.key]: done ? "Analyzed" : "Analysis failed — see the item" }));
        if (done) ok++;
        else failed.push(String(items.findIndex((x) => x.key === it.key) + 1));
      }
    };
    await Promise.all([worker(), worker()]);
    setRunning(null);
    setBarMsg(
      failed.length
        ? { text: `${ok} analysed; item${failed.length === 1 ? "" : "s"} ${failed.join(", ")} failed — the reason is on the item.`, tone: "warn" }
        : { text: `${ok} analysed. Read each item's spec (fix anything wrong — the BACK line especially), then Send batch.`, tone: "ok" },
    );
  }, [analyzable, items]);

  const sendBatch = useCallback(
    async (when: "now" | "night") => {
      setConfirmSend(false);
      const list = sendable;
      if (!list.length) return;
      setRunning("send");
      setBarMsg({ text: `Adding ${list.length} item${list.length === 1 ? "" : "s"} to the batch…`, tone: "info" });
      let queued = 0;
      const failed: string[] = [];
      // One at a time: each queue call builds that product's four panel requests.
      for (const it of list) {
        const api = apis.current.get(it.key);
        if (!api) continue;
        setStepNote((p) => ({ ...p, [it.key]: "Adding to the batch…" }));
        const done = await api.queue().catch(() => false);
        setStepNote((p) => ({ ...p, [it.key]: done ? (when === "now" ? "Added — sending" : "Queued for 1 AM") : "Not added — see the item" }));
        if (done) queued++;
        else failed.push(String(items.findIndex((x) => x.key === it.key) + 1));
      }
      if (!queued) {
        setRunning(null);
        setBarMsg({ text: "Nothing was added — the reason is on each item.", tone: "err" });
        return;
      }
      if (when === "night") {
        setRunning(null);
        setBarMsg({
          text: `${queued} item${queued === 1 ? "" : "s"} (${queued * PANELS_PER_ITEM} panels) wait for tonight's 1 AM send.${failed.length ? ` Not added: item ${failed.join(", ")}.` : ""}`,
          tone: failed.length ? "warn" : "ok",
        });
        return;
      }
      try {
        const r = await fetch("/api/studio/batch/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger: "manual" }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok && r.status !== 409) throw new Error(j.error || `HTTP ${r.status}`);
        setBarMsg({
          text:
            r.status === 409
              ? `${queued} item(s) added. A batch send is already running — they go with the next send (or at 1 AM).`
              : `Sent to OpenAI: ${queued} item${queued === 1 ? "" : "s"}, ${queued * PANELS_PER_ITEM} panels. Each item shows its result when it is back (checked every 5 minutes); pictures are saved to Dropbox.${failed.length ? ` Not added: item ${failed.join(", ")}.` : ""}`,
          tone: failed.length ? "warn" : "ok",
        });
      } catch (e) {
        setBarMsg({
          text: `${queued} item(s) were added to the queue, but the send did not start (${e instanceof Error ? e.message : "error"}). They go at 1 AM, or press Send batch again.`,
          tone: "err",
        });
      } finally {
        setRunning(null);
        window.setTimeout(() => {
          for (const api of apis.current.values()) void api.refreshBatch();
        }, 20_000);
      }
    },
    [sendable, items],
  );

  const checkNow = useCallback(async () => {
    setRunning("send");
    try {
      const r = await fetch("/api/studio/batch/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      if (!r.ok && r.status !== 409) throw new Error(`HTTP ${r.status}`);
      setBarMsg({ text: "Checking with OpenAI — finished runs appear on their items in a minute.", tone: "info" });
      window.setTimeout(() => {
        for (const api of apis.current.values()) void api.refreshBatch();
      }, 20_000);
    } catch (e) {
      setBarMsg({ text: `Could not check (${e instanceof Error ? e.message : "error"}).`, tone: "err" });
    } finally {
      setRunning(null);
    }
  }, []);

  const addItem = () => setItems((p) => [...p, { key: newKey(), matrixId: null }]);
  const removeItem = (key: string) => {
    setItems((p) => {
      const next = p.filter((x) => x.key !== key);
      return next.length ? next : [{ key: newKey(), matrixId: null }];
    });
    setStatuses((p) => {
      const n = { ...p };
      delete n[key];
      return n;
    });
  };
  const setMatrix = (key: string, matrixId: string | null) =>
    setItems((p) => p.map((x) => (x.key === key ? { ...x, matrixId } : x)));

  const toneCls = {
    info: "text-[var(--wms-muted)]",
    ok: "text-[var(--wms-status-success-fg)]",
    warn: "text-[var(--wms-status-warning-fg)]",
    err: "text-[var(--wms-status-danger-fg)]",
  } as const;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-[var(--wms-border)]">
        {(
          [
            ["studio", `Bulk Studio · ${picked.length}`],
            ["upload", "Upload"],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 font-mono text-xs uppercase tracking-wide max-md:min-h-11 ${
              tab === id ? "border-[var(--wms-accent)] text-[var(--wms-fg)]" : "border-transparent text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === "upload" ? (
        <div className="rounded-md border border-dashed border-[var(--wms-border)] p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
          The upload page for finished generations comes next. Until then, open each item&apos;s results in its
          Bulk Studio card (Load results) or in the product&apos;s Studio tab, and publish from there.
        </div>
      ) : (
        <>
          {/* Top bar — sticks while the item list scrolls. */}
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2 shadow-sm">
            <div className="flex min-w-[14rem] flex-1 flex-wrap gap-x-4 gap-y-1 font-mono text-[0.74rem] text-[var(--wms-muted)]">
              <span>
                <b className="text-[var(--wms-fg)] tabular-nums">{picked.length}</b> items
              </span>
              <span>
                <b className="text-[var(--wms-fg)] tabular-nums">{photoTotal}</b> photos
              </span>
              <span>
                <b className="text-[var(--wms-fg)] tabular-nums">{analysedTotal}</b> analysed
              </span>
              <span>
                <b className="text-[var(--wms-fg)] tabular-nums">{sendable.length}</b> ready to send
              </span>
              <span>
                ≈ <b className="text-[var(--wms-fg)] tabular-nums">${(sendable.length * PANELS_PER_ITEM * BATCH_COST_PER_PANEL).toFixed(2)}</b> batch
              </span>
              {openTotal ? (
                <span>
                  <b className="text-[var(--wms-accent)] tabular-nums">{openTotal}</b> out with OpenAI / queued
                </span>
              ) : null}
              {readyTotal ? (
                <span>
                  <b className="text-[var(--wms-status-success-fg)] tabular-nums">{readyTotal}</b> back — load on the item
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canManage || running !== null || analyzable.length === 0}
                onClick={() => void analyzeAll()}
                className={`${btn} border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/60`}
              >
                {running === "analyze" ? "Analyzing…" : `🔍 Analyze${analyzable.length ? ` ${analyzable.length}` : " all"}`}
              </button>
              <button
                type="button"
                disabled={!canManage || running !== null || sendable.length === 0}
                onClick={() => setConfirmSend(true)}
                className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)] hover:brightness-110`}
              >
                {running === "send" ? "Sending…" : `➤ Send batch${sendable.length ? ` (${sendable.length})` : ""}`}
              </button>
              {openTotal ? (
                <button
                  type="button"
                  disabled={running !== null}
                  onClick={() => void checkNow()}
                  title="Ask OpenAI now instead of waiting for the automatic check (every 5 minutes)"
                  className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}
                >
                  Check now
                </button>
              ) : null}
            </div>
            {confirmSend ? (
              <div className="basis-full rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/10 p-3 font-mono text-[0.74rem] text-[var(--wms-fg)]">
                <p>
                  Send {sendable.length} item{sendable.length === 1 ? "" : "s"} — {sendable.length * PANELS_PER_ITEM} panels, about $
                  {(sendable.length * PANELS_PER_ITEM * BATCH_COST_PER_PANEL).toFixed(2)} at the batch&apos;s half price. Results usually within a
                  few hours; nothing is published by itself.
                </p>
                <ul className="mt-1 list-disc pl-5 text-[var(--wms-muted)]">
                  {sendable.map((i) => (
                    <li key={i.key}>
                      Item {items.findIndex((x) => x.key === i.key) + 1} · {st(i)?.modelName ?? "model"}
                    </li>
                  ))}
                </ul>
                {picked.length > sendable.length ? (
                  <p className="mt-1 text-[var(--wms-status-warning-fg)]">
                    {picked.length - sendable.length} item(s) are not ready and stay here — see the notes on each.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void sendBatch("now")} className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]`}>
                    Send now
                  </button>
                  <button type="button" onClick={() => void sendBatch("night")} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
                    ☾ Add to tonight&apos;s 1 AM batch
                  </button>
                  <button type="button" onClick={() => setConfirmSend(false)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-muted)]`}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {barMsg ? <p className={`basis-full font-mono text-[0.74rem] ${toneCls[barMsg.tone]}`}>{barMsg.text}</p> : null}
          </div>

          {items.map((it, idx) => (
            <BulkItemCard
              key={it.key}
              index={idx}
              item={it}
              canManage={canManage}
              status={statuses[it.key]}
              stepNote={stepNote[it.key]}
              takenIds={items.filter((x) => x.key !== it.key && x.matrixId).map((x) => x.matrixId as string)}
              onPick={(id) => setMatrix(it.key, id)}
              onRemove={() => removeItem(it.key)}
              register={register}
              report={report}
            />
          ))}

          <button
            type="button"
            onClick={addItem}
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-md border-2 border-dashed border-[var(--wms-border)] font-mono text-sm uppercase tracking-wide text-[var(--wms-muted)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-accent)]"
          >
            <span className="text-xl leading-none">＋</span> Add another item
          </button>
        </>
      )}
    </div>
  );
}

function BulkItemCard({
  index,
  item,
  canManage,
  status,
  stepNote,
  takenIds,
  onPick,
  onRemove,
  register,
  report,
}: {
  index: number;
  item: Item;
  canManage: boolean;
  status?: BulkStudioStatus;
  stepNote?: string;
  takenIds: string[];
  onPick: (matrixId: string | null) => void;
  onRemove: () => void;
  register: (key: string, api: BulkStudioApi | null) => void;
  report: (key: string, s: BulkStudioStatus) => void;
}) {
  const { data, error, isLoading } = useSWR<MatrixDetail>(
    item.matrixId ? `/api/inventory/catalog/matrices/${item.matrixId}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const key = item.key;
  /* Stable per item, so the Studio tab registers once (not on every render). */
  const hooks = useMemo(
    () => ({
      register: (api: BulkStudioApi | null) => register(key, api),
      onStatus: (s: BulkStudioStatus) => report(key, s),
    }),
    [key, register, report],
  );
  const m = data?.matrix;
  const variants = data?.variants ?? [];
  const live = variants.some((v) => !v.archived) ? variants.filter((v) => !v.archived) : variants;
  const archived = variants.length > 0 && variants.every((v) => v.archived);

  let pill: { text: string; cls: string } = { text: "Pick a product", cls: "border-[var(--wms-border)] text-[var(--wms-muted)]" };
  if (status) {
    if (status.busy) pill = { text: stepNote || "Working…", cls: "border-amber-500/60 text-amber-300" };
    else if (status.batchReady) pill = { text: "Results back — load below", cls: "border-[var(--wms-status-success-fg)]/60 text-[var(--wms-status-success-fg)]" };
    else if (status.batchOpen) pill = { text: "In the batch", cls: "border-[var(--wms-accent)]/60 text-[var(--wms-accent)]" };
    else if (!status.sendProblems.length) pill = { text: "Ready to send", cls: "border-[var(--wms-status-success-fg)]/60 text-[var(--wms-status-success-fg)]" };
    else if (status.spec === "ready") pill = { text: "Analyzed · needs a fix", cls: "border-amber-500/60 text-amber-300" };
    else if (!status.analyzeProblems.length) pill = { text: status.spec === "stale" ? "Photos changed · analyze" : "Ready to analyze", cls: "border-sky-500/60 text-sky-300" };
    else pill = { text: "Draft", cls: "border-[var(--wms-border)] text-[var(--wms-muted)]" };
  }

  return (
    <section className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]" aria-label={`Item ${index + 1}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--wms-border)] px-3 py-2">
        <span className="font-mono text-[0.72rem] font-bold uppercase tracking-wide text-[var(--wms-muted)]">Item {index + 1}</span>
        {item.matrixId ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--wms-fg)]">
              {m?.description ?? (isLoading ? "Loading…" : error ? "Could not load this product" : "")}
            </p>
            <p className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
              {m ? [m.upc ? `UPC ${m.upc}` : null, m.category, m.subcategory_1].filter(Boolean).join(" · ") : ""}
            </p>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <ProductPicker takenIds={takenIds} onPick={onPick} />
          </div>
        )}
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[0.66rem] uppercase tracking-wide ${pill.cls}`}>{pill.text}</span>
        {status?.clockText ? <span className="font-mono text-[0.72rem] tabular-nums text-[var(--wms-muted)]">⏱ {status.clockText}</span> : null}
        <div className="flex gap-1.5">
          {item.matrixId ? (
            <button
              type="button"
              onClick={() => onPick(null)}
              title="Pick a different product (this product's photos stay saved with it)"
              className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.7rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:min-h-11"
            >
              change
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove item ${index + 1}`}
            title="Remove from this page (the product's photos and spec stay saved with it)"
            className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.7rem] text-[var(--wms-status-danger-fg)] max-md:min-h-11 max-md:min-w-11"
          >
            ✕
          </button>
        </div>
      </div>

      {status && (status.sendProblems.length || status.batchLine) && !status.busy ? (
        <div className="space-y-0.5 border-b border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.7rem]">
          {status.batchLine ? <p className="text-[var(--wms-muted)]">Last batch run: {status.batchLine}</p> : null}
          {status.batchOpen || status.batchReady
            ? null
            : status.sendProblems.map((p) => (
                <p key={p} className="text-[var(--wms-status-warning-fg)]">
                  • {p}
                </p>
              ))}
        </div>
      ) : null}

      {item.matrixId && m ? (
        archived ? (
          <p className="p-3 font-mono text-xs text-[var(--wms-status-warning-fg)]">
            This product is archived in the WMS — it is not shot. Pick another product.
          </p>
        ) : (
          <div className="p-3">
            <CarbonStudioTab
              key={item.matrixId}
              matrixId={item.matrixId}
              shopifyProductId={m.shopify_product_id ?? null}
              itemRefUrls={m.image_urls ?? []}
              defaultItemType={m.subcategory_1 || m.category || ""}
              category={m.category ?? ""}
              productName={m.description ?? ""}
              variants={live.map((v) => ({ id: v.id, color: v.color, shopify_variant_id: v.shopify_variant_id ?? null }))}
              canManage={canManage}
              bulk={hooks}
            />
          </div>
        )
      ) : null}
    </section>
  );
}

function ProductPicker({ takenIds, onPick }: { takenIds: string[]; onPick: (matrixId: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/inventory/catalog/search?scope=matrix&q=${encodeURIComponent(term)}`, { signal: ctl.signal, cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as { rows?: SearchRow[] };
        setRows(Array.isArray(j.rows) ? j.rows : []);
        setCursor(-1);
      } catch {
        /* typing again retries */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [q]);
  const shown = q.trim() ? rows : [];
  const choose = (r: SearchRow | undefined) => {
    if (!r || takenIds.includes(r.matrix_id)) return;
    onPick(r.matrix_id);
    setOpen(false);
  };
  return (
    <div className="relative max-w-md">
      <input
        type="search"
        value={q}
        autoComplete="off"
        enterKeyHint="search"
        placeholder="UPC or product name…"
        aria-label="UPC or product name"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !shown.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(shown.length - 1, c + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(shown[Math.max(0, cursor)]);
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
      />
      {open && q.trim() ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-lg">
          {loading && !shown.length ? <p className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">Searching…</p> : null}
          {!loading && !shown.length ? <p className="px-3 py-2 font-mono text-xs text-[var(--wms-muted)]">No product matches “{q.trim()}”.</p> : null}
          {shown.map((r, i) => {
            const taken = takenIds.includes(r.matrix_id);
            return (
              <button
                key={r.matrix_id}
                type="button"
                disabled={taken}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
                className={`flex w-full items-baseline gap-3 px-3 py-2 text-left disabled:opacity-50 max-md:min-h-11 ${
                  i === cursor ? "bg-[var(--wms-accent)]/15" : "hover:bg-[var(--wms-surface-elevated)]"
                }`}
              >
                <span className="min-w-[4.5rem] font-mono text-xs text-[var(--wms-muted)]">{r.upc ?? "—"}</span>
                <span className="text-sm text-[var(--wms-fg)]">
                  {r.name}
                  {taken ? <span className="ml-2 font-mono text-[0.66rem] text-[var(--wms-muted)]">already on this page</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
