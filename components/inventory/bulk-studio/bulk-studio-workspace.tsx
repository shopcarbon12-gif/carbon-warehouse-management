"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import {
  CarbonStudioTab,
  type BulkStudioApi,
  type BulkStudioDraft,
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
type DraftUpdate = BulkStudioDraft | null | ((prev: BulkStudioDraft) => BulkStudioDraft | null);

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
  /** Analyze button colour: green once every product on the page analysed with no problem left. */
  const analysisPassed =
    picked.length > 0 && picked.every((i) => st(i)?.spec === "ready" && !(st(i)?.analyzeProblems.length));
  const openTotal = picked.reduce((n, i) => n + (st(i)?.batchOpen ?? 0), 0);

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

  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Filled in on an empty item before its barcode is scanned (kept in memory only). */
  const [drafts, setDrafts] = useState<Record<string, BulkStudioDraft>>({});
  const setDraft = useCallback((key: string, d: DraftUpdate) => {
    setDrafts((p) => {
      const next = typeof d === "function" ? d(p[key] ?? { files: [] }) : d;
      const n = { ...p };
      if (next) n[key] = next;
      else delete n[key];
      return n;
    });
  }, []);
  const addItem = () => {
    const key = newKey();
    setItems((p) => [...p, { key, matrixId: null }]);
    setFocusKey(key);
    setScrollTo(key);
  };
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
  /* Scan box (owner 2026-10-20): a scanned hang tag (or typed barcode / UPC)
     opens that product's full Studio card straight away — into the first empty
     item if there is one, otherwise as a new item at the end. */
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  /* A scan in an EMPTY item's field loads the product into it; a scan in a
     loaded item's field adds the scanned product as the next item, so tags can
     be scanned one after another. */
  const addScanned = (fromKey: string, matrixId: string) => {
    const already = items.find((x) => x.matrixId === matrixId);
    if (already) {
      setBarMsg({ text: `That product is already item ${items.indexOf(already) + 1} — scrolled to it.`, tone: "info" });
      setScrollTo(already.key);
      return;
    }
    const from = items.find((x) => x.key === fromKey);
    const empty = from && !from.matrixId ? from : items.find((x) => !x.matrixId);
    const key = empty?.key ?? newKey();
    setItems((p) => (empty ? p.map((x) => (x.key === key ? { ...x, matrixId } : x)) : [...p, { key, matrixId }]));
    setBarMsg(null);
    setFocusKey(key);
    if (key !== fromKey) setScrollTo(key);
  };
  useEffect(() => {
    if (!scrollTo) return;
    const t = window.setTimeout(() => {
      document.getElementById(`bulk-item-${scrollTo}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTo(null);
    }, 150);
    return () => window.clearTimeout(t);
  }, [scrollTo]);

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
          {picked.length ? (
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 bg-[var(--wms-bg)] py-1.5">
            <div className="flex-1" />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canManage || running !== null || analyzable.length === 0}
                onClick={() => void analyzeAll()}
                title={analysisPassed ? "Every item's analysis passed" : "Analysis not passed yet on every item"}
                className={`${btn} ${
                  analysisPassed
                    ? "border-emerald-500 bg-emerald-600 text-white hover:brightness-110"
                    : "border-orange-500 bg-orange-500 text-black hover:brightness-110"
                }`}
              >
                {running === "analyze" ? "Analyzing…" : analysisPassed ? "✓ Analyzed" : "🔍 Analyze"}
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
          ) : barMsg ? (
            <p className={`font-mono text-[0.74rem] ${toneCls[barMsg.tone]}`}>{barMsg.text}</p>
          ) : null}

          {items.map((it, idx) => (
            <BulkItemCard
              key={it.key}
              index={idx}
              item={it}
              canManage={canManage}
              status={statuses[it.key]}
              stepNote={stepNote[it.key]}
              onScan={(id) => addScanned(it.key, id)}
              draft={drafts[it.key] ?? null}
              setDraft={setDraft}
              focus={focusKey === it.key || (!it.matrixId && idx === 0 && items.length === 1)}
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
  onScan,
  focus,
  draft,
  setDraft,
  onRemove,
  register,
  report,
}: {
  index: number;
  item: Item;
  canManage: boolean;
  status?: BulkStudioStatus;
  stepNote?: string;
  onScan: (matrixId: string) => void;
  focus: boolean;
  draft: BulkStudioDraft | null;
  setDraft: (key: string, d: DraftUpdate) => void;
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
      draft,
      onDraftUsed: () => setDraft(key, null),
    }),
    [key, register, report, draft, setDraft],
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
    <section
      id={`bulk-item-${item.key}`}
      className="scroll-mt-40 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]"
      aria-label={`Item ${index + 1}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <span className="text-2xl font-semibold uppercase tracking-tight text-[var(--wms-fg)]">Item {index + 1}:</span>
        {item.matrixId ? (
          /* Scanned: the field gives way to the product, with its ✕ beside it. */
          <div className="flex min-w-0 items-center gap-3">
            <p className="min-w-0 font-mono text-[0.72rem] text-[var(--wms-muted)]">
              <span className="text-base font-semibold text-[var(--wms-fg)]">
                {m?.description ?? (isLoading ? "Loading…" : error ? "Could not load this product" : "")}
              </span>
              {m ? [m.upc ? ` · UPC ${m.upc}` : null, m.category, m.subcategory_1].filter(Boolean).join(" · ") : ""}
            </p>
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
        ) : (
          <>
            <div className="min-w-[16rem] max-w-[60%] flex-[3] max-md:max-w-full">
              <ProductPicker scan autoFocus={focus} takenIds={[]} onPick={onScan} placeholder="scan the hang tag…" />
            </div>
            <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove item ${index + 1}`}
            title="Remove from this page (the product's photos and spec stay saved with it)"
            className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.7rem] text-[var(--wms-status-danger-fg)] max-md:min-h-11 max-md:min-w-11"
          >
            ✕
          </button>
          </>
        )}
        <div className="flex-1" />
        {item.matrixId ? (
          <span
            title={status?.sendProblems.length ? status.sendProblems.join("\n") : undefined}
            className={`rounded-full border px-3 py-1 font-mono text-[0.7rem] font-semibold uppercase tracking-wide ${pill.cls}`}
          >
            {pill.text}
          </span>
        ) : null}
        {status?.clockText ? <span className="font-mono text-[0.72rem] tabular-nums text-[var(--wms-muted)]">⏱ {status.clockText}</span> : null}
      </div>

      {!item.matrixId ? (
        <DraftForm draft={draft ?? { files: [] }} update={(d) => setDraft(key, d)} onTag={onScan} />
      ) : null}

      {item.matrixId && m ? (
        archived ? (
          <p className="p-3 font-mono text-xs text-[var(--wms-status-warning-fg)]">
            This product is archived in the WMS — it is not shot. Pick another product.
          </p>
        ) : (
          <div className="px-3 pb-3">
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

function ProductPicker({
  takenIds,
  onPick,
  scan = false,
  autoFocus = false,
  placeholder,
}: {
  takenIds: string[];
  onPick: (matrixId: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** The big scan box at the top: Enter looks the code up at once (a scanner
      types faster than the search delay), one match opens it, and the box
      clears for the next tag. */
  scan?: boolean;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    /* Ready to scan on arrival — desktop only, so a phone keyboard never pops up. */
    if (autoFocus && window.matchMedia("(hover: hover)").matches) inputRef.current?.focus();
  }, [autoFocus]);
  const search = useCallback(async (term: string, signal?: AbortSignal) => {
    const r = await fetch(`/api/inventory/catalog/search?scope=matrix&q=${encodeURIComponent(term)}`, { signal, cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { rows?: SearchRow[] };
    return Array.isArray(j.rows) ? j.rows : [];
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        setRows(await search(term, ctl.signal));
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
  }, [q, search]);
  const shown = q.trim() ? rows : [];
  const choose = (r: SearchRow | undefined) => {
    if (!r || takenIds.includes(r.matrix_id)) return;
    onPick(r.matrix_id);
    setOpen(false);
    if (scan) {
      setQ("");
      setRows([]);
      setNote("");
      inputRef.current?.focus();
    }
  };
  /* Enter in the scan box: look the code up now. A barcode or UPC that names
     one product opens it; several (or a name) show the list to pick from. */
  const submit = async () => {
    const term = q.trim();
    if (!term) return;
    if (cursor >= 0 && shown[cursor]) return choose(shown[cursor]);
    setLoading(true);
    try {
      const found = await search(term);
      setRows(found);
      setCursor(-1);
      const exact = found.filter((r) => (r.upc ?? "").toUpperCase() === term.toUpperCase());
      if (found.length === 1) choose(found[0]);
      else if (exact.length === 1) choose(exact[0]);
      else if (!found.length) setNote(`No product matches “${term}”.`);
      else {
        setNote("");
        setOpen(true);
      }
    } catch {
      setNote("Could not search — scan again.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className={`relative ${scan ? "w-full" : "max-w-md"}`}>
      <input
        ref={inputRef}
        type="search"
        value={q}
        autoComplete="off"
        enterKeyHint="search"
        placeholder={placeholder ?? "UPC or product name…"}
        aria-label={scan ? "Scan a hang tag barcode" : "UPC or product name"}
        onChange={(e) => {
          setQ(e.target.value);
          setNote("");
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (scan && e.key === "Enter") {
            e.preventDefault();
            void submit();
            return;
          }
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
        className={
          scan
            ? "w-full rounded-md border-2 border-[var(--wms-accent)]/60 bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-lg tracking-wide text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none max-md:min-h-12"
            : "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
        }
      />
      {scan && note ? <p className="mt-1 font-mono text-[0.72rem] text-[var(--wms-muted)]">{note}</p> : null}
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

/** One picked photo, shown from the local file. */
function DraftThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="relative">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local file preview, not an optimisable asset
        <img src={url} alt="" className="h-16 w-12 rounded border border-[var(--wms-border)] object-cover" />
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="absolute -right-1.5 -top-1.5 rounded-full bg-black/80 px-1.5 text-[0.65rem] text-white max-md:min-h-11 max-md:min-w-11"
      >
        ✕
      </button>
    </div>
  );
}

type DraftModel = { model_id: string; name: string; gender: string; ref_image_urls?: string[] };

/**
 * An item before its barcode is scanned: every field is already open. What is
 * filled in here is handed to the product's Studio the moment the tag is
 * scanned (photos uploaded into their sections, model / type / instruction set).
 * Colour comes from the product, so it opens after the scan.
 */
function DraftForm({
  draft,
  update,
  onTag,
}: {
  draft: BulkStudioDraft;
  update: (d: DraftUpdate) => void;
  /** A photo turned out to be a hang tag naming one product: load it, as a scan would. */
  onTag: (matrixId: string) => void;
}) {
  const onChange = (d: BulkStudioDraft) => update(d);
  const [tagNote, setTagNote] = useState("");
  const [checking, setChecking] = useState(0);
  const tagFound = useRef(false);
  const { data } = useSWR<{ models?: DraftModel[] }>("/api/models/list", fetcher, { revalidateOnFocus: false });
  const models = (data?.models ?? []).filter((x) => (x.ref_image_urls ?? []).length >= 3);
  const label = "mb-1 block font-mono text-[0.62rem] uppercase tracking-wide text-[var(--wms-muted)]";
  const field =
    "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";
  const zoneCls = "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-2";
  const ztitle = "font-mono text-[0.78rem] font-bold uppercase tracking-wide text-[var(--wms-fg)]";
  const zsub = "mb-2 font-mono text-[0.64rem] leading-snug text-[var(--wms-muted)]";
  const chip =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-accent)] hover:border-[var(--wms-accent)] max-md:min-h-11";
  const add = (view: BulkStudioDraft["files"][number]["view"], list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const entries = files.map((file) => ({ file, view }));
    update((prev) => ({ ...prev, files: [...prev.files, ...entries] }));
    /* Every photo is checked for a hang tag. A tag naming one product loads it
       (exactly as scanning it would) and its photo is taken off the item. */
    for (const entry of entries) {
      setChecking((n) => n + 1);
      void readTag(entry.file)
        .then((res) => {
          if (!res || !res.isTag) return;
          update((prev) => ({ ...prev, files: prev.files.filter((x) => x !== entry) }));
          const ids = [...new Set((res.matches ?? []).map((x) => x.matrixId))];
          if (ids.length === 1 && !tagFound.current) {
            tagFound.current = true;
            setTagNote("");
            onTag(ids[0]);
          } else if (!ids.length) setTagNote(`Tag read (${res.sku || res.upc || "no code"}) — no product has that code. Scan it or type it instead.`);
          else setTagNote(`Tag ${res.sku || res.upc} matches ${ids.length} products — scan or type it to pick one.`);
        })
        .finally(() => setChecking((n) => n - 1));
    }
  };
  const zone = (
    view: BulkStudioDraft["files"][number]["view"],
    title: string,
    sub: string | null,
    extra?: ReactNode,
    after?: ReactNode,
  ) => {
    const mine = draft.files.filter((f) => f.view === view);
    return (
      <div className={zoneCls}>
        <p className={ztitle}>{title}</p>
        {sub ? <p className={zsub}>{sub}</p> : <div className="mb-2" />}
        {extra}
        {mine.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {mine.map((f, i) => (
              <DraftThumb
                key={`${f.file.name}-${f.file.lastModified}-${i}`}
                file={f.file}
                onRemove={() => onChange({ ...draft, files: draft.files.filter((x) => x !== f) })}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <label className={chip}>
            ＋ Upload
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
              add(view, e.target.files);
              e.target.value = "";
            }} />
          </label>
          <span className={`${chip} cursor-not-allowed opacity-50`} title="Scan the barcode first">
            📱 Phone camera
          </span>
        </div>
        {after ? <div className="mt-2">{after}</div> : null}
      </div>
    );
  };
  const backHasPhotos = draft.files.some((f) => f.view === "back");
  return (
    <div className="grid gap-2 px-3 pb-3 md:grid-cols-3">
      {checking > 0 || tagNote ? (
        <p className={`font-mono text-[0.72rem] md:col-span-3 ${tagNote ? "text-[var(--wms-status-warning-fg)]" : "text-[var(--wms-muted)]"}`}>
          {checking > 0 ? "Checking the photos for a hang tag…" : tagNote}
        </p>
      ) : null}
      {zone("general", "Accessories · General", "Accessories, flats, any view — works exactly as before.", null, zone("styling", "Style with", null))}
      {zone("front", "Front", "The FRONT of the item (jeans, shirts, dresses…).")}
      {zone(
        "back",
        "Back",
        "The BACK of the item.",
        backHasPhotos ? null : (
          <label className="mb-2 flex cursor-pointer items-center gap-1.5 font-mono text-[0.66rem] text-[var(--wms-fg)] max-md:py-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
              checked={draft.backIsPlain === true}
              onChange={(e) => onChange({ ...draft, backIsPlain: e.target.checked })}
            />
            <span>
              The back is <b>plain</b>
            </span>
          </label>
        ),
      )}
      <div className="space-y-2 md:col-span-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <span className={label}>Model</span>
            <select className={field} value={draft.modelId ?? models[0]?.model_id ?? ""} onChange={(e) => onChange({ ...draft, modelId: e.target.value })}>
              {models.map((x) => (
                <option key={x.model_id} value={x.model_id}>
                  {x.name} ({x.gender})
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className={label}>Item type</span>
            <input className={field} value={draft.itemType ?? ""} onChange={(e) => onChange({ ...draft, itemType: e.target.value })} />
          </div>
          <div>
            <span className={label}>Colour</span>
            <select className={`${field} opacity-60`} disabled title="The product's colours open after the scan">
              <option>after the scan</option>
            </select>
          </div>
        </div>
        <div>
          <span className={label}>Item instruction (optional)</span>
          <input
            className={field}
            placeholder="e.g. oversized cut, super skinny fit, high-waist…"
            value={draft.instruction ?? ""}
            onChange={(e) => onChange({ ...draft, instruction: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

type TagResult = { isTag: boolean; sku?: string; upc?: string; matches?: { matrixId: string; name: string; upc: string | null }[] };

/** Smaller copy for the tag read (the printed code stays readable at this size). */
async function fileToDataUrl(file: File, max = 1600): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.88);
}

type BarcodeDetectorLike = { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> };

/** Is this photo a hang tag? The browser's barcode reader when it has one, else the server reads it. */
async function readTag(file: File): Promise<TagResult | null> {
  try {
    const W = window as unknown as { BarcodeDetector?: new (o?: { formats: string[] }) => BarcodeDetectorLike };
    let code = "";
    if (typeof W.BarcodeDetector === "function") {
      try {
        const det = new W.BarcodeDetector({ formats: ["code_93", "code_128", "upc_a", "ean_13"] });
        const bmp = await createImageBitmap(file);
        const found = await det.detect(bmp);
        bmp.close();
        code = found[0]?.rawValue?.trim() ?? "";
      } catch {
        code = "";
      }
    }
    const r = await fetch("/api/studio/read-tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(code ? { code } : { image: await fileToDataUrl(file) }),
    });
    if (!r.ok) return null;
    return (await r.json()) as TagResult;
  } catch {
    return null;
  }
}
