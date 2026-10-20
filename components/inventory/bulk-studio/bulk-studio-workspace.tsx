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
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /**
   * Photos dropped on an item (owner 2026-10-20): split into products in
   * shooting order. A hang tag starts its product's item — an item already on
   * the page, the empty item the photos were dropped on, or a new one; photos
   * before the first tag stay on the item they were dropped on; a different
   * garment with no tag becomes a new item waiting for its barcode. Every
   * photo then lands in its item's General box, where the Studio sorts it to
   * Front / Back / General / Style with, turns it upright and cuts the head.
   */
  /* One batch at a time: the phone delivers its photos in several polls a few
     seconds apart, and two batches sorted at once each saw the page before the
     other's items existed (owner's 2026-10-20 upload: the photos after a tag
     landed on the wrong item). */
  const ingestChain = useRef<Promise<void>>(Promise.resolve());
  /** Where each item's photo stream left off: the next batch from the same
      place continues that item until a new tag appears. */
  const streamRef = useRef(new Map<string, { key: string; at: number }>());
  const ingest = useCallback(
    (fromKey: string, entriesIn: { file?: File; url?: string }[]) => {
      ingestChain.current = ingestChain.current.then(() => ingestOne(fromKey, entriesIn)).catch(() => {});
      return ingestChain.current;
    },
    // ingestOne only uses stable setters and refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const ingestOne = async (fromKey: string, entriesIn: { file?: File; url?: string }[]) => {
    /* Shooting order. Files: their own time stamp. Phone photos: the phone page
       sends them one after another, and each stored name carries its arrival
       time — the polls themselves can come back in any order. */
    const stamp = (e: { file?: File; url?: string }) =>
      e.file ? e.file.lastModified : Number((e.url ?? "").match(/\/(\d{12,14})(?:-\d+)?\.\w+$/)?.[1] ?? 0);
    const entries = [...entriesIn].sort((a, b) => stamp(a) - stamp(b) || (a.file && b.file ? a.file.name.localeCompare(b.file.name) : 0));
    if (!entries.length) return;
    setBarMsg({ text: `Sorting ${entries.length} photo${entries.length === 1 ? "" : "s"} into items…`, tone: "info" });
    type Ph = { group: number; isTag: boolean; sku?: string; matches?: { matrixId: string; name: string }[] };
    let photos: Ph[] = [];
    try {
      const images = await Promise.all(entries.map(async (e) => (e.file ? { data: await fileToDataUrl(e.file, 1600) } : { url: e.url })));
      const r = await fetch("/api/studio/group-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const j = (await r.json().catch(() => ({}))) as { photos?: Ph[] };
      if (r.ok && Array.isArray(j.photos)) photos = j.photos;
    } catch {
      /* falls back to "all on this item" */
    }
    if (photos.length !== entries.length) photos = entries.map(() => ({ group: 1, isTag: false }));
    /* Forward only, in shooting order: a new item starts at a tag, or where the
       photos switch to a garment not seen yet — a photo is never sent back to
       an earlier item. */
    {
      let seg = 1;
      let maxSeen = photos[0]?.group ?? 1;
      photos = photos.map((p, i) => {
        if (i > 0 && (p.isTag || p.group > maxSeen)) seg += 1;
        maxSeen = Math.max(maxSeen, p.group);
        return { ...p, group: seg };
      });
    }

    const now = itemsRef.current;
    /* A batch continues where the last one from this item left off (a few
       minutes at most), so a tag's photos keep following it across polls. */
    const prev = streamRef.current.get(fromKey);
    const lead = prev && Date.now() - prev.at < 10 * 60_000 && now.some((x) => x.key === prev.key) ? prev.key : fromKey;
    const from = now.find((x) => x.key === lead);
    const order: number[] = [];
    photos.forEach((p) => {
      if (!order.includes(p.group)) order.push(p.group);
    });
    const byMatrix = new Map(now.filter((x) => x.matrixId).map((x) => [x.matrixId as string, x.key]));
    const added: Item[] = [];
    let fromMatrix: string | null = null;
    const files = new Map<string, { file?: File; url?: string }[]>();
    const notes: string[] = [];
    const groupKeys: string[] = [];
    order.forEach((g, gi) => {
      const idx = photos.map((p, i) => (p.group === g ? i : -1)).filter((i) => i >= 0);
      const tag = idx.map((i) => photos[i]).find((p) => p.isTag);
      const ids = [...new Set((tag?.matches ?? []).map((m) => m.matrixId))];
      const matrixId = ids.length === 1 ? ids[0] : null;
      if (tag && !matrixId) notes.push(ids.length ? `tag ${tag.sku} matches ${ids.length} products` : `tag ${tag.sku || "?"} — no product has that code`);
      let key: string;
      if (matrixId && byMatrix.has(matrixId)) key = byMatrix.get(matrixId) as string;
      else if (gi === 0 && (!tag || (from && !from.matrixId))) {
        key = lead;
        if (matrixId) fromMatrix = matrixId;
      } else {
        key = newKey();
        added.push({ key, matrixId });
      }
      if (matrixId) byMatrix.set(matrixId, key);
      groupKeys.push(key);
      const mine = idx.filter((i) => !photos[i].isTag).map((i) => entries[i]);
      if (mine.length) files.set(key, [...(files.get(key) ?? []), ...mine]);
    });

    setItems((p) => [...p.map((x) => (x.key === lead && fromMatrix && !x.matrixId ? { ...x, matrixId: fromMatrix } : x)), ...added]);
    /* Keep the page's own copy current for the next batch in the chain. */
    itemsRef.current = [...now.map((x) => (x.key === lead && fromMatrix && !x.matrixId ? { ...x, matrixId: fromMatrix } : x)), ...added];
    streamRef.current.set(fromKey, { key: groupKeys[groupKeys.length - 1] ?? lead, at: Date.now() });
    for (const [key, list] of files) {
      setDraft(key, (prev) => ({ ...(prev ?? { files: [] }), files: [...(prev?.files ?? []), ...list.map((e) => ({ ...e, view: "general" as const }))] }));
    }
    const count = (k: string) => files.get(k)?.length ?? 0;
    setBarMsg({
      text:
        `${entries.length} photo${entries.length === 1 ? "" : "s"} sorted` +
        (added.length ? ` — ${added.length} new item${added.length === 1 ? "" : "s"} added (${added.map((a) => `${count(a.key)} photo${count(a.key) === 1 ? "" : "s"}`).join(", ")})` : "") +
        (notes.length ? `. Check: ${notes.join("; ")}.` : "."),
      tone: notes.length ? "warn" : "ok",
    });
    if (added[0]) setScrollTo(added[0].key);
  };
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
              ingest={ingest}
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
  ingest,
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
  ingest: (fromKey: string, entries: { file?: File; url?: string }[]) => Promise<void>;
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
  /* Stable, so the Studio hooks below do not change on every render. */
  const onIngest = useCallback((entries: { file?: File; url?: string }[]) => void ingest(key, entries), [ingest, key]);
  /* Stable per item, so the Studio tab registers once (not on every render). */
  const hooks = useMemo(
    () => ({
      register: (api: BulkStudioApi | null) => register(key, api),
      onStatus: (s: BulkStudioStatus) => report(key, s),
      draft,
      onDraftUsed: () => setDraft(key, null),
      ingest: onIngest,
    }),
    [key, register, report, draft, setDraft, onIngest],
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
        <span className="font-mono text-[0.78rem] font-bold uppercase tracking-wide text-[var(--wms-fg)]">Item {index + 1}:</span>
        {item.matrixId ? (
          /* Scanned: the field gives way to the product, with its ✕ beside it. */
          <div className="flex min-w-0 items-center gap-3">
            <p className="min-w-0 font-mono text-[0.72rem] text-[var(--wms-muted)]">
              <span className="text-sm font-semibold text-[var(--wms-fg)]">
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
            <div className="w-full max-w-md">
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
        <DraftForm draft={draft ?? { files: [] }} update={(d) => setDraft(key, d)} onIngest={onIngest} />
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
            ? "w-full rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none max-md:min-h-11 max-md:text-base"
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
function DraftThumb({ file, stored, onRemove }: { file?: File; stored?: string; onRemove: () => void }) {
  const local = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);
  useEffect(() => () => {
    if (local) URL.revokeObjectURL(local);
  }, [local]);
  const url = local || (stored ? (/r2\.cloudflarestorage\.com/i.test(stored) ? `/api/studio/ref-image?u=${encodeURIComponent(stored)}` : stored) : "");
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
  onIngest,
}: {
  draft: BulkStudioDraft;
  update: (d: DraftUpdate) => void;
  /** Photos go to the page, which splits them into products by their hang tags. */
  onIngest: (entries: { file?: File; url?: string }[]) => void;
}) {
  const onChange = (d: BulkStudioDraft) => update(d);
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
  const add = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) onIngest(files.map((file) => ({ file })));
  };
  const zone = (
    view: BulkStudioDraft["files"][number]["view"],
    title: string,
    sub: string | null,
    extra?: ReactNode,
    after?: ReactNode,
  ) => {
    const mine = draft.files.filter((f) => f.view === view || (view === "general" && f.view === "styling"));
    return (
      <div className={zoneCls}>
        <p className={ztitle}>{title}</p>
        {sub ? <p className={zsub}>{sub}</p> : <div className="mb-2" />}
        {extra}
        {mine.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {mine.map((f, i) => (
              <DraftThumb
                key={`${f.url ?? `${f.file?.name}-${f.file?.lastModified}`}-${i}`}
                file={f.file}
                stored={f.url}
                onRemove={() => onChange({ ...draft, files: draft.files.filter((x) => x !== f) })}
              />
            ))}
          </div>
        ) : null}
        {view === "general" ? (
          <div className="flex flex-wrap gap-2">
            <label className={chip}>
              ＋ Upload
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }} />
            </label>
            <button type="button" className={chip} onClick={() => void startPhone()} title="Take the photos with your phone (scan the QR code)">
              📱 Phone camera
            </button>
          </div>
        ) : null}
        {after ? <div className="mt-2">{after}</div> : null}
      </div>
    );
  };
  const [phone, setPhone] = useState<{ sessionId: string; qr: string; scanUrl: string } | null>(null);
  const [phoneErr, setPhoneErr] = useState("");
  const phoneSeen = useRef<Set<string>>(new Set());
  const startPhone = async () => {
    setPhoneErr("");
    if (phone) return; // already open
    try {
      const r = await fetch("/api/image-handoff/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId: null }),
      });
      const j = (await r.json().catch(() => ({}))) as { sessionId?: string; qrCodeUrl?: string; scanUrl?: string; error?: string };
      if (!r.ok || !j.sessionId || !j.qrCodeUrl) throw new Error(j.error || "Could not start the phone camera.");
      phoneSeen.current = new Set();
      setPhone({ sessionId: j.sessionId, qr: j.qrCodeUrl, scanUrl: j.scanUrl || "" });
    } catch (e) {
      setPhoneErr(e instanceof Error ? e.message : "Could not start the phone camera.");
    }
  };
  const pollPhone = useCallback(
    async (sessionId: string, all = false) => {
      const r = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}${all ? "?all=1" : ""}`, { cache: "no-store" });
      if (r.status === 404) return "gone" as const;
      const j = (await r.json().catch(() => ({}))) as { images?: { imageUrl: string }[] };
      const fresh = (j.images ?? []).map((x) => x.imageUrl).filter((u) => u && !phoneSeen.current.has(u));
      if (!fresh.length) return "ok" as const;
      fresh.forEach((u) => phoneSeen.current.add(u));
      onIngest(fresh.map((url) => ({ url })));
      return "ok" as const;
    },
    [onIngest],
  );
  useEffect(() => {
    if (!phone) return;
    const t = window.setInterval(() => {
      void pollPhone(phone.sessionId).then((st) => {
        if (st === "gone") setPhone(null);
      });
    }, 2500);
    return () => window.clearInterval(t);
  }, [phone, pollPhone]);
  const backHasPhotos = draft.files.some((f) => f.view === "back");
  return (
    <div className="grid gap-2 px-3 pb-3 md:grid-cols-3">
      {phone ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-surface)] p-3 md:col-span-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote QR image */}
          <img src={phone.qr} alt="QR code for the phone camera" className="h-32 w-32 rounded bg-white p-1" />
          <div className="min-w-0 flex-1 font-mono text-[0.72rem] text-[var(--wms-muted)]">
            <p className="text-[var(--wms-fg)]">Scan with your phone and take the photos — each hang tag starts its product.</p>
            {phone.scanUrl ? <p className="mt-1 break-all">{phone.scanUrl}</p> : null}
          </div>
          <button
            type="button"
            className={chip}
            onClick={() => {
              const s0 = phone;
              void pollPhone(s0.sessionId, true).finally(() => setPhone(null));
            }}
          >
            Done
          </button>
        </div>
      ) : null}
      {phoneErr ? <p className="font-mono text-[0.72rem] text-[var(--wms-status-danger-fg)] md:col-span-3">{phoneErr}</p> : null}
      {zone("general", "Accessories · General · Style with", "Accessories, flats, any view — works exactly as before.")}
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
