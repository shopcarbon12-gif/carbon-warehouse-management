"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { splitPanelToHalves } from "@/lib/panelGeneration";
import {
  arrange,
  blockColourAt,
  classifyViews,
  galleryColourOrder,
  liveColours,
  mainPictureColours,
  picKey,
  poseRank,
  poseView,
  whichColour,
  type GalleryCard,
} from "@/lib/studio/gallery-order";

/**
 * Bulk Studio › Upload (owner, 2026-10-20).
 *
 * Every night-batch run that has come back shows here on its own — no "Load
 * results" click — one row per product with its generated pictures, already
 * in the owner's gallery order:
 *  - one block per colour, in the product's colour order;
 *  - each block: full-length front first (that colour's ★ main picture), then
 *    the other fronts, front close-ups, side / three-quarter, details, seated,
 *    back close-up, and the full back last (analysed on every active product,
 *    men and women alike, 2026-10-20);
 *  - the product's current Shopify pictures stay in, in their colour's block,
 *    unless "include current Shopify pictures" is unticked.
 * Cards can be unselected, dragged (left = first picture in Shopify), starred,
 * made the hero, downloaded and given alt text; Publish pushes the approved
 * rows and the runs leave this tab.
 */

type Run = {
  id: string;
  addedAt?: string;
  matrixId: string;
  productName: string | null;
  status: string;
  modelName: string | null;
  modelGender: string | null;
  itemColour: string | null;
  itemType: string | null;
  panels: number[];
  ready: number[];
};
type Variant = { color: string | null; shopify_variant_id?: string | null; shopify_image_url?: string | null; archived?: boolean };
type Card = GalleryCard;
type Row = {
  matrixId: string;
  name: string;
  upc: string;
  shopifyProductId: string | null;
  itemType: string;
  modelName: string;
  colours: string[];
  variantIdsByColour: Record<string, string[]>;
  runs: Run[];
  cards: Card[];
  existing: Card[];
  approved: boolean;
  state: "loading" | "ready" | "publishing" | "published" | "error";
  msg: string;
};

/** Shopify's green bag, for "View in Shopify". */
function ShopifyBag() {
  return (
    <svg viewBox="0 0 24 27" width="16" height="18" aria-hidden="true">
      <path fill="#95BF47" d="M20.6 5.2c0-.1-.1-.2-.3-.2l-2.3-.2-1.7-1.6c-.2-.2-.5-.1-.6-.1l-.8.3C14.4 2.2 13.6 1 12.2 1h-.1C11.7.5 11.2.3 10.8.3 7.4.3 5.8 4.5 5.3 6.7l-2.4.7c-.7.2-.8.3-.9 1L0 24.1 15.3 27 23.6 25.2S20.6 5.3 20.6 5.2Zm-6.4-1.6-1.3.4v-.3c0-.9-.1-1.6-.3-2.2.7.1 1.2.9 1.6 2.1Zm-2.6-1.8c.2.6.4 1.4.4 2.5v.2l-2.7.8c.5-2 1.5-3 2.3-3.5Zm-1-.9c.1 0 .3 0 .4.1-1.1.5-2.3 1.8-2.8 4.4l-2.1.7C6.7 4.1 8.1.9 10.6.9Z" />
      <path fill="#5E8E3E" d="M20.3 5c-.1 0-2.3-.2-2.3-.2l-1.7-1.6c-.1-.1-.1-.1-.2-.1L15.3 27l8.3-1.8S20.6 5.3 20.6 5.2c0-.1-.2-.2-.3-.2Z" />
      <path fill="#fff" d="m12.2 9.3-1 3s-.9-.5-2-.5c-1.6 0-1.7 1-1.7 1.3 0 1.4 3.6 1.9 3.6 5.1 0 2.5-1.6 4.2-3.8 4.2-2.6 0-3.9-1.6-3.9-1.6l.7-2.3s1.4 1.2 2.5 1.2c.8 0 1.1-.6 1.1-1 0-1.8-2.9-1.9-2.9-4.8 0-2.5 1.8-4.9 5.4-4.9 1.4 0 2 .4 2 .4Z" />
    </svg>
  );
}

/** Download: a tray with an arrow into it. */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

const newKey = () => Math.random().toString(36).slice(2, 10);
const btn =
  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11";

async function getJson<T>(u: string): Promise<T> {
  const r = await fetch(u, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** PNG base64 → JPEG base64 (much smaller to publish; Shopify recompresses anyway). */
async function toJpeg(pngB64: string): Promise<string> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngB64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")?.drawImage(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.93).replace(/^data:image\/jpeg;base64,/, "");
}

/** A local file → JPEG base64 (long side ≤ 2048). */
async function fileToJpeg(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.92).replace(/^data:image\/jpeg;base64,/, "");
}

async function download(card: Card, name: string) {
  try {
    const blob = card.b64
      ? await (await fetch(`data:image/jpeg;base64,${card.b64}`)).blob()
      : await (await fetch(card.src, { mode: "cors" })).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${blob.type.includes("png") ? "png" : "jpg"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch {
    window.open(card.src, "_blank");
  }
}

export function BulkUploadTab({ active }: { active: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [include, setInclude] = useState(true);
  const includeRef = useRef(true);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "info" | "ok" | "warn" | "err" } | null>(null);
  const [busy, setBusy] = useState<null | "alt" | "publish">(null);
  /** Each finished run's pictures and the colour block they go in (changeable). */
  const runCards = useRef(new Map<string, { matrixId: string; colour: string; cards: Card[] }>());
  const genFor = (matrixId: string) => {
    const gen = new Map<string, Card[]>();
    for (const rc of runCards.current.values()) {
      if (rc.matrixId !== matrixId) continue;
      gen.set(rc.colour, [...(gen.get(rc.colour) ?? []), ...rc.cards.map((c) => ({ ...c, label: c.label.replace(/^[^·]*·/, `${rc.colour} ·`) }))]);
    }
    for (const [c, list] of gen) gen.set(c, list.sort((a, b) => (rankRef.current.get(a.key) ?? 9) - (rankRef.current.get(b.key) ?? 9)));
    return gen;
  };
  /** Gallery rank of every generated card, so several runs of one colour sort together. */
  const rankRef = useRef(new Map<string, number>());
  const seenRuns = useRef(new Set<string>());
  /** Older finished runs of a colour that has a newer one — removed with their row. */
  const older = useRef<Run[]>([]);
  /* Three products load at a time, top of the list first. */
  const queue = useRef<[string, Run[]][]>([]);
  const running = useRef(0);
  const pump = () => {
    while (running.current < 3 && queue.current.length) {
      const [matrixId, runs] = queue.current.shift() as [string, Run[]];
      running.current++;
      void buildRow(matrixId, runs).finally(() => {
        running.current--;
        pump();
      });
    }
  };

  const patchRow = useCallback((matrixId: string, fn: (r: Row) => Row) => {
    setRows((p) => p.map((r) => (r.matrixId === matrixId ? fn(r) : r)));
  }, []);

  /* Finished runs come in by themselves: every 2 minutes, and whenever the tab opens. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await getJson<{ items?: Run[] }>("/api/studio/batch");
      /* Every finished run belongs here until it is published or removed — also
         the ones already opened in the Studio ("loaded"); of several runs of the
         same product + colour only the newest shows. */
      const finished = (j.items ?? []).filter((x) => (x.status === "ready" || x.status === "loaded") && x.ready.length > 0);
      const newest = new Map<string, Run>();
      for (const x of finished) {
        const k = `${x.matrixId}|${(x.itemColour || "").trim().toUpperCase()}`;
        const at = newest.get(k);
        if (!at || String(x.addedAt ?? "") > String(at.addedAt ?? "")) newest.set(k, x);
      }
      older.current = finished.filter((x) => !Array.from(newest.values()).includes(x));
      const ready = [...newest.values()].filter((x) => !seenRuns.current.has(x.id));
      if (!ready.length) return;
      ready.forEach((x) => seenRuns.current.add(x.id));
      const byMatrix = new Map<string, Run[]>();
      for (const r of ready) byMatrix.set(r.matrixId, [...(byMatrix.get(r.matrixId) ?? []), r]);
      for (const [matrixId, runs] of byMatrix) {
        setRows((p) => {
          const at = p.find((r) => r.matrixId === matrixId);
          if (at) return p.map((r) => (r.matrixId === matrixId ? { ...r, runs: [...r.runs, ...runs], state: "loading" } : r));
          return [
            ...p,
            {
              matrixId,
              name: runs[0].productName ?? "Product",
              upc: "",
              shopifyProductId: null,
              itemType: runs[0].itemType ?? "",
              modelName: runs[0].modelName ?? "",
              colours: [],
              variantIdsByColour: {},
              runs,
              cards: [],
              existing: [],
              approved: false,
              state: "loading",
              msg: "Loading the pictures…",
            },
          ];
        });
        queue.current.push([matrixId, runs]);
      }
      pump();
    } catch (e) {
      setMsg({ text: `Could not load the finished runs (${e instanceof Error ? e.message : "error"}).`, tone: "err" });
    } finally {
      setLoading(false);
    }
    // buildRow only uses refs and stable setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildRow = async (matrixId: string, runs: Run[]) => {
    try {
      const d = await getJson<{ matrix: { description: string | null; upc: string | null; shopify_product_id?: string | null }; variants: Variant[] }>(
        `/api/inventory/catalog/matrices/${matrixId}`,
      );
      const live = d.variants.filter((v) => !v.archived);
      const colours = liveColours(live);
      const variantIdsByColour: Record<string, string[]> = {};
      for (const v of live) {
        const c = (v.color || "").trim();
        if (c && v.shopify_variant_id) variantIdsByColour[c] = [...(variantIdsByColour[c] ?? []), v.shopify_variant_id];
      }
      /* Current Shopify pictures, each colour's main picture marked. */
      let existing: Card[] = [];
      if (d.matrix.shopify_product_id) {
        const mj = await getJson<{ media?: { id: string; url: string; alt: string | null }[] }>(`/api/shopify/media?matrixId=${matrixId}`);
        const mainOf = mainPictureColours(live);
        const media = mj.media ?? [];
        const views = await classifyViews(media.map((m) => m.url));
        existing = media.map((m, i) => ({
          view: views[i] ?? "other",
          key: `ex-${m.id}`,
          kind: "existing" as const,
          mediaId: m.id,
          src: m.url,
          alt: m.alt ?? "",
          color: mainOf.get(picKey(m.url)) ?? "",
          selected: true,
          label: `Shopify ${i + 1}`,
        }));
      }
      /* Generated pictures: each finished panel split into its two 4:5 pictures. */
      const notes: string[] = [];
      for (const run of runs) {
        const rj = await getJson<{ accessory?: boolean; panels: { panel: number; poseA: number; poseB: number; imageBase64?: string; mime?: string }[] }>(
          `/api/studio/batch/${run.id}?jpeg=1`,
        );
        const female = (run.modelGender || "").toLowerCase() === "female";
        const colour = (run.itemColour || colours[0] || "").trim();
        const list: { card: Card; rank: number }[] = [];
        for (const p of rj.panels) {
          if (!p.imageBase64) continue;
          const { left, right } = await splitPanelToHalves(p.imageBase64, p.mime || "image/png");
          for (const [b64png, pose] of [[left, p.poseA], [right, p.poseB]] as const) {
            const b64 = await toJpeg(b64png);
            const rank = poseRank(pose, female, !!rj.accessory);
            const view = poseView(pose, female, !!rj.accessory);
            list.push({
              rank,
              card: {
                key: `gen-${run.id}-${pose}`,
                kind: "new",
                b64,
                src: `data:image/jpeg;base64,${b64}`,
                alt: "",
                color: "",
                selected: true,
                label: `${colour} · ${run.modelName ?? ""} · ${view}`,
              },
            });
          }
        }
        for (const x of list) rankRef.current.set(x.card.key, x.rank);
        /* The colour the pictures actually show decides their block. */
        let shown = colour;
        if (colours.length > 1 && list[0]) {
          const hero = list.slice().sort((a, b) => a.rank - b.rank)[0].card;
          const wc = await whichColour(hero.src, colours, d.matrix.description ?? "");
          if (wc && wc.toUpperCase() !== colour.toUpperCase()) {
            shown = wc;
            notes.push(`${run.modelName ?? "The"} run was requested as ${colour} but the pictures show ${wc} — they are in ${wc}'s block (change it at the top of the row).`);
          }
        }
        runCards.current.set(run.id, { matrixId, colour: shown, cards: list.map((x) => x.card) });
      }
      const gen = genFor(matrixId);
      /* Blocks follow the colour order the Shopify gallery already has (the
         owner's option order); colours not on Shopify yet follow. */
      const colourOrder = galleryColourOrder(existing, colours);
      patchRow(matrixId, (r) => ({
        ...r,
        name: d.matrix.description ?? r.name,
        upc: d.matrix.upc ?? "",
        shopifyProductId: d.matrix.shopify_product_id ?? null,
        colours: colourOrder,
        variantIdsByColour,
        existing,
        cards: arrange(gen, existing, includeRef.current, colourOrder),
        state: "ready",
        msg: notes.join(" "),
      }));
    } catch (e) {
      patchRow(matrixId, (r) => ({ ...r, state: "error", msg: `Could not load this product's pictures (${e instanceof Error ? e.message : "error"}).` }));
    }
  };

  useEffect(() => {
    if (!active) return;
    void load();
    const t = window.setInterval(() => void load(), 120_000);
    return () => window.clearInterval(t);
  }, [active, load]);

  /* "Include current Shopify pictures" (ticked by default): put them back in, or take them out. */
  const toggleInclude = (next: boolean) => {
    setInclude(next);
    includeRef.current = next;
    setRows((p) =>
      p.map((r) => {
        if (r.state !== "ready") return r;
        if (!next) return { ...r, cards: r.cards.filter((c) => c.kind !== "existing") };
        /* Back in, each in its colour's block and in order. */
        const ups = r.cards.filter((c) => c.key.startsWith("up-"));
        return { ...r, cards: [...arrange(genFor(r.matrixId), r.existing, true, r.colours), ...ups] };
      }),
    );
  };

  /* ── card actions ─────────────────────────────────────────────────────── */
  const setCards = (matrixId: string, fn: (cards: Card[], r: Row) => Card[]) => patchRow(matrixId, (r) => ({ ...r, cards: fn(r.cards, r) }));
  const toggleSel = (matrixId: string, key: string) =>
    setCards(matrixId, (cs) => cs.map((c) => (c.key === key ? { ...c, selected: !c.selected } : c)));
  const star = (matrixId: string, key: string) =>
    setCards(matrixId, (cs, r) => {
      const idx = cs.findIndex((c) => c.key === key);
      const card = cs[idx];
      if (card.color) return cs.map((c) => (c.key === key ? { ...c, color: "" } : c));
      const colour = blockColourAt(cs, idx - 1, r.colours) || r.colours[0] || "";
      return cs.map((c) => (c.key === key ? { ...c, color: colour } : c.color === colour ? { ...c, color: "" } : c));
    });
  const setStarColour = (matrixId: string, key: string, colour: string) =>
    setCards(matrixId, (cs) => cs.map((c) => (c.key === key ? { ...c, color: colour } : colour && c.color === colour ? { ...c, color: "" } : c)));
  const makeHero = (matrixId: string, key: string) =>
    setCards(matrixId, (cs) => {
      const c = cs.find((x) => x.key === key);
      return c ? [c, ...cs.filter((x) => x.key !== key)] : cs;
    });
  const removeCard = (matrixId: string, key: string) => setCards(matrixId, (cs) => cs.filter((c) => c.key !== key));
  const setAlt = (matrixId: string, key: string, alt: string) =>
    setCards(matrixId, (cs) => cs.map((c) => (c.key === key ? { ...c, alt } : c)));
  const drag = useRef<{ matrixId: string; key: string } | null>(null);
  const dropBefore = (matrixId: string, targetKey: string | null) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.matrixId !== matrixId || d.key === targetKey) return;
    setCards(matrixId, (cs) => {
      const moving = cs.find((c) => c.key === d.key);
      if (!moving) return cs;
      const rest = cs.filter((c) => c.key !== d.key);
      const at = targetKey ? rest.findIndex((c) => c.key === targetKey) : rest.length;
      return [...rest.slice(0, at), moving, ...rest.slice(at)];
    });
  };
  const addFiles = async (matrixId: string, files: FileList | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    const cards: Card[] = [];
    for (const f of list) {
      const b64 = await fileToJpeg(f);
      cards.push({ key: `up-${newKey()}`, kind: "new", b64, src: `data:image/jpeg;base64,${b64}`, alt: "", color: "", selected: true, label: `Uploaded · ${f.name}` });
    }
    if (cards.length) setCards(matrixId, (cs) => [...cs, ...cards]);
  };

  /* ── Alt all: only the pictures that have no alt yet ──────────────────── */
  const altAll = async () => {
    setBusy("alt");
    const jobs: { matrixId: string; key: string; src: string; itemType: string }[] = [];
    for (const r of rows) for (const c of r.cards) if (c.selected && !c.alt.trim()) jobs.push({ matrixId: r.matrixId, key: c.key, src: c.src, itemType: r.itemType });
    setMsg({ text: `Writing alt text for ${jobs.length} picture${jobs.length === 1 ? "" : "s"} (the others already have one)…`, tone: "info" });
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        try {
          const res = await fetch("/api/openai/image-alt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: j.src, itemType: j.itemType }),
          });
          const out = (await res.json().catch(() => ({}))) as { altText?: string; alt?: string };
          const alt = (out.altText || out.alt || "").trim();
          if (alt) {
            setAlt(j.matrixId, j.key, alt);
            done++;
          }
        } catch {
          /* left empty — press again */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    setBusy(null);
    setMsg({ text: `Alt text written for ${done} of ${jobs.length} picture${jobs.length === 1 ? "" : "s"}.`, tone: done === jobs.length ? "ok" : "warn" });
  };

  /* ── Publish ───────────────────────────────────────────────────────────── */
  const publishRow = async (r: Row): Promise<boolean> => {
    patchRow(r.matrixId, (x) => ({ ...x, state: "publishing", msg: "Publishing to Shopify…" }));
    try {
      const chosen = r.cards.filter((c) => c.selected);
      const single = r.colours.length === 1 ? r.colours[0] : null;
      const anyStar = chosen.some((c) => c.color);
      const items = chosen.map((c, idx) => {
        const colour = single ? (anyStar ? c.color : idx === 0 ? single : "") : c.color;
        const variantIds = colour ? r.variantIdsByColour[colour] : undefined;
        return c.kind === "existing"
          ? { kind: "existing", mediaId: c.mediaId, alt: c.alt, variantIds }
          : { kind: "new", b64: c.b64, alt: c.alt, variantIds };
      });
      const res = await fetch("/api/shopify/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId: r.matrixId, items, studioModelName: r.modelName }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const hard = (j.warnings ?? []).filter((w) => /^(stage|create)/i.test(w) || /FAILED/i.test(w));
      if (hard.length) throw new Error(hard.join("; "));
      for (const run of r.runs) await fetch(`/api/studio/batch/${run.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "published" }) });
      for (const run of older.current.filter((x) => x.matrixId === r.matrixId))
        await fetch(`/api/studio/batch/${run.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "dismissed" }) }).catch(() => {});
      patchRow(r.matrixId, (x) => ({ ...x, state: "published", approved: false, msg: `Published — ${items.length} picture${items.length === 1 ? "" : "s"} on Shopify.` }));
      return true;
    } catch (e) {
      patchRow(r.matrixId, (x) => ({ ...x, state: "ready", msg: `Not published: ${e instanceof Error ? e.message : "error"}` }));
      return false;
    }
  };
  const publishApproved = async () => {
    const list = rows.filter((r) => r.approved && r.state === "ready");
    if (!list.length) return;
    setBusy("publish");
    setMsg({ text: `Publishing ${list.length} product${list.length === 1 ? "" : "s"} to Shopify…`, tone: "info" });
    let ok = 0;
    for (const r of list) if (await publishRow(r)) ok++;
    setBusy(null);
    setMsg({ text: `Published ${ok} of ${list.length} product${list.length === 1 ? "" : "s"}.`, tone: ok === list.length ? "ok" : "warn" });
  };

  /* "Remove from list": handled elsewhere — its runs (older ones too) leave this tab. */
  const dismissRow = async (r: Row) => {
    const runs = [...r.runs, ...older.current.filter((x) => x.matrixId === r.matrixId)];
    for (const run of runs) await fetch(`/api/studio/batch/${run.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "dismissed" }) }).catch(() => {});
    setRows((p) => p.filter((x) => x.matrixId !== r.matrixId));
  };

  /* A run's pictures came out as another colour: move the whole set to that colour's block. */
  const setRunColour = (r: Row, runId: string, colour: string) => {
    const rc = runCards.current.get(runId);
    if (!rc) return;
    rc.colour = colour;
    patchRow(r.matrixId, (x) => ({ ...x, cards: arrange(genFor(r.matrixId), x.existing, includeRef.current, x.colours), msg: `Moved to ${colour} — the order was rebuilt.` }));
  };

  /* Click a card: the picture big, ← → to step through the row, Esc to close. */
  const [zoom, setZoom] = useState<{ matrixId: string; idx: number } | null>(null);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
      if (e.key === "ArrowRight") setZoom((z) => (z ? { ...z, idx: z.idx + 1 } : z));
      if (e.key === "ArrowLeft") setZoom((z) => (z ? { ...z, idx: Math.max(0, z.idx - 1) } : z));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  const zoomRow = zoom ? rows.find((x) => x.matrixId === zoom.matrixId) : null;
  const zoomCard = zoomRow ? zoomRow.cards[Math.min(zoom?.idx ?? 0, zoomRow.cards.length - 1)] : null;

  const openOnline = async (matrixId: string) => {
    const w = window.open("about:blank", "_blank");
    try {
      const j = await getJson<{ url?: string }>(`/api/shopify/product-url?matrixId=${matrixId}`);
      if (j.url && w) w.location.href = j.url;
      else w?.close();
    } catch {
      w?.close();
    }
  };

  const approvedCount = rows.filter((r) => r.approved && r.state === "ready").length;
  const shown = rows.filter((r) => r.state !== "published" || r.msg);
  const tone = { info: "text-[var(--wms-muted)]", ok: "text-[var(--wms-status-success-fg)]", warn: "text-[var(--wms-status-warning-fg)]", err: "text-[var(--wms-status-danger-fg)]" } as const;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Command line */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 bg-[var(--wms-bg)] py-1.5">
        <button type="button" disabled={loading} onClick={() => void load()} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
          {loading ? "Checking…" : "↻ Refresh"}
        </button>
        <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.74rem] text-[var(--wms-fg)] max-md:min-h-11">
          <input type="checkbox" className="h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5" checked={include} onChange={(e) => toggleInclude(e.target.checked)} />
          include current Shopify pictures
        </label>
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy !== null || !rows.some((r) => r.cards.some((c) => c.selected && !c.alt.trim()))}
          onClick={() => void altAll()}
          className={`${btn} border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]`}
        >
          {busy === "alt" ? "Writing…" : "✨ Alt all"}
        </button>
        <button
          type="button"
          disabled={busy !== null || approvedCount === 0}
          onClick={() => void publishApproved()}
          className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)] hover:brightness-110`}
        >
          {busy === "publish" ? "Publishing…" : `⤴ Publish to Shopify${approvedCount ? ` (${approvedCount})` : ""}`}
        </button>
        {msg ? <p className={`basis-full font-mono text-[0.74rem] ${tone[msg.tone]}`}>{msg.text}</p> : null}
      </div>

      {!shown.length ? (
        <p className="rounded-md border border-dashed border-[var(--wms-border)] p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
          {loading ? "Checking for finished runs…" : "No finished runs yet — they show up here by themselves when the batch comes back."}
        </p>
      ) : null}

      {shown.map((r) => (
        <section key={r.matrixId} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-fg)] max-md:min-h-11">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                disabled={r.state !== "ready"}
                checked={r.approved}
                onChange={(e) => patchRow(r.matrixId, (x) => ({ ...x, approved: e.target.checked }))}
              />
              Approve
            </label>
            <p className="min-w-0 font-mono text-[0.72rem] text-[var(--wms-muted)]">
              <span className="text-sm font-semibold text-[var(--wms-fg)]">{r.name}</span>
              {r.upc ? ` · UPC ${r.upc}` : ""}
            </p>
            {r.runs.map((run) => (
              <label key={run.id} className="flex items-center gap-1 font-mono text-[0.68rem] text-[var(--wms-muted)]" title="The colour these pictures show — change it if the pictures came out as another colour">
                {run.modelName}:
                <select
                  value={runCards.current.get(run.id)?.colour ?? run.itemColour ?? ""}
                  disabled={r.state !== "ready" || r.colours.length < 2}
                  onChange={(e) => setRunColour(r, run.id, e.target.value)}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1 py-0.5 font-mono text-[0.68rem] text-[var(--wms-fg)] max-md:min-h-11"
                >
                  {[...new Set([run.itemColour ?? "", ...r.colours])].filter(Boolean).map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="flex-1" />
            {r.existing.length && r.cards.some((c) => c.kind === "existing") ? (
              <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.7rem] text-[var(--wms-fg)] max-md:min-h-11" title="Untick to untick every current Shopify picture of this product (they are removed on publish)">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                  checked={r.cards.some((c) => c.kind === "existing" && c.selected)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setCards(r.matrixId, (cs) => cs.map((c) => (c.kind === "existing" ? { ...c, selected: on } : c)));
                  }}
                />
                include current Shopify pictures
              </label>
            ) : null}
            <label className={`${btn} cursor-pointer border-dashed border-[var(--wms-border)] text-[var(--wms-accent)]`} title="Add your own pictures to this product">
              ＋ Upload
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
                void addFiles(r.matrixId, e.target.files);
                e.target.value = "";
              }} />
            </label>
            {r.shopifyProductId ? (
              <a
                href={`https://admin.shopify.com/store/shopcarbon1/products/${String(r.shopifyProductId).split("/").pop()}`}
                target="_blank"
                rel="noreferrer"
                title="View in Shopify"
                className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}
              >
                <ShopifyBag />
              </a>
            ) : null}
            <button type="button" title="View online" onClick={() => void openOnline(r.matrixId)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
              🌐
            </button>
            {r.state === "ready" ? (
              <button type="button" disabled={busy !== null} onClick={() => void publishRow(r)} className={`${btn} border-[var(--wms-accent)] text-[var(--wms-accent)]`}>
                ⤴ Publish
              </button>
            ) : null}
            {r.state !== "publishing" ? (
              <button
                type="button"
                title="Remove from this list (nothing is published; the pictures stay in Dropbox)"
                onClick={() => void dismissRow(r)}
                className={`${btn} border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`}
              >
                ✕
              </button>
            ) : null}
          </div>
          {r.msg ? (
            <p className={`px-3 pb-1 font-mono text-[0.72rem] ${r.state === "error" || r.msg.startsWith("Not published") ? tone.err : r.state === "published" ? tone.ok : tone.info}`}>{r.msg}</p>
          ) : null}
          {r.state !== "published" ? (
            <div
              className="flex gap-2 overflow-x-auto px-3 pb-3"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                dropBefore(r.matrixId, null);
              }}
            >
              {r.cards.map((c, i) => {
                const blockColour = blockColourAt(r.cards, i, r.colours);
                return (
                  <div
                    key={c.key}
                    draggable
                    onDragStart={() => (drag.current = { matrixId: r.matrixId, key: c.key })}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      dropBefore(r.matrixId, c.key);
                    }}
                    className={`relative w-40 shrink-0 rounded-md border p-1.5 ${c.selected ? "border-[var(--wms-accent)]/60" : "border-[var(--wms-border)] opacity-50"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- generated / Shopify picture preview */}
                    <img
                      src={c.src}
                      alt={c.alt}
                      draggable={false}
                      title="Click to see it big"
                      onClick={() => setZoom({ matrixId: r.matrixId, idx: i })}
                      className="aspect-[4/5] w-full cursor-zoom-in rounded object-cover"
                    />
                    <div className="absolute left-2 top-2 flex flex-col gap-1">
                      {i === 0 ? <span className="rounded bg-black/70 px-1.5 font-mono text-[0.58rem] uppercase text-white">Hero</span> : null}
                      {c.kind === "existing" ? <span className="rounded bg-black/70 px-1.5 font-mono text-[0.58rem] uppercase text-white">Shopify</span> : null}
                    </div>
                    <input
                      type="checkbox"
                      title={c.kind === "existing" && c.selected ? "Untick to remove it from Shopify on publish" : "Include in the publish"}
                      checked={c.selected}
                      onChange={() => toggleSel(r.matrixId, c.key)}
                      className="absolute right-2 top-2 h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                    />
                    <div className="mt-1 flex items-center gap-1">
                      <button
                        type="button"
                        title={c.color ? `★ main picture for ${c.color}` : `Make it the main picture for ${blockColour || "its colour"}`}
                        onClick={() => star(r.matrixId, c.key)}
                        className={`rounded px-1 text-sm ${c.color ? "text-amber-300" : "text-[var(--wms-muted)] hover:text-amber-300"}`}
                      >
                        {c.color ? "★" : "☆"}
                      </button>
                      {c.color && r.colours.length > 1 ? (
                        <select
                          value={c.color}
                          onChange={(e) => setStarColour(r.matrixId, c.key, e.target.value)}
                          className="min-w-0 flex-1 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1 py-0.5 font-mono text-[0.6rem] text-[var(--wms-fg)]"
                        >
                          {r.colours.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-mono text-[0.6rem] text-[var(--wms-muted)]">{c.color || c.label}</span>
                      )}
                      {i > 0 ? (
                        <button type="button" title="Make it the hero (first picture)" onClick={() => makeHero(r.matrixId, c.key)} className="rounded px-1 text-[0.8rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
                          👑
                        </button>
                      ) : null}
                      <button type="button" title="Download" onClick={() => void download(c, `${r.name}-${i + 1}`)} className="rounded px-1 text-[0.8rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
                        <DownloadIcon />
                      </button>
                      {c.kind === "new" ? (
                        <button type="button" title="Remove" onClick={() => removeCard(r.matrixId, c.key)} className="rounded px-1 text-[0.75rem] text-[var(--wms-status-danger-fg)]">
                          ✕
                        </button>
                      ) : null}
                    </div>
                    <textarea
                      value={c.alt}
                      placeholder="alt text"
                      rows={2}
                      onChange={(e) => setAlt(r.matrixId, c.key, e.target.value)}
                      className="mt-1 w-full resize-none rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1 py-0.5 font-mono text-[0.6rem] text-[var(--wms-fg)] max-md:text-base"
                    />
                  </div>
                );
              })}
              {r.state === "loading" ? <p className="self-center font-mono text-xs text-[var(--wms-muted)]">Loading the pictures…</p> : null}
            </div>
          ) : null}
        </section>
      ))}
      {zoom && zoomRow && zoomCard ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- full-size preview */}
          <img src={zoomCard.src} alt={zoomCard.alt} className="max-h-[92vh] max-w-[92vw] rounded object-contain" onClick={(e) => e.stopPropagation()} />
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/70 px-3 py-1 font-mono text-xs text-white">
            {zoomRow.name} · {Math.min(zoom.idx, zoomRow.cards.length - 1) + 1} / {zoomRow.cards.length} · {zoomCard.label}
          </p>
          <button type="button" aria-label="Previous" onClick={(e) => { e.stopPropagation(); setZoom({ ...zoom, idx: Math.max(0, zoom.idx - 1) }); }} className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/15 px-4 py-3 text-2xl text-white hover:bg-white/25">
            ‹
          </button>
          <button type="button" aria-label="Next" onClick={(e) => { e.stopPropagation(); setZoom({ ...zoom, idx: Math.min(zoomRow.cards.length - 1, zoom.idx + 1) }); }} className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/15 px-4 py-3 text-2xl text-white hover:bg-white/25">
            ›
          </button>
          <button type="button" aria-label="Close" onClick={() => setZoom(null)} className="absolute right-4 top-4 rounded-md bg-white/15 px-3 py-1.5 font-mono text-sm text-white hover:bg-white/25">
            ✕ Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
