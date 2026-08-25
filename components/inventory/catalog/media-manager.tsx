/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Full Shopify media manager for a product (used on the Images tab).
 * See/arrange all images, set the hero (first) + per-image variant/colour,
 * upload new images or delete existing ones, and manage alt text (per image,
 * bulk, or generate) — all without AI generation. Publishes declaratively to
 * /api/shopify/media. Quantity/price/etc. are never touched.
 */
type MVariant = { id: string; color: string | null; size: string | null; shopify_variant_id?: string | null };
type MediaItem = {
  key: string;
  kind: "existing" | "new";
  mediaId?: string;
  b64?: string;
  url: string;
  alt: string;
  color: string; // colour name — the image attaches to every size of that colour
};
type Props = { matrixId: string; shopifyProductId: string | null; variants: MVariant[]; canManage: boolean };

function readDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.readAsDataURL(file);
  });
}
/**
 * Downscale + re-encode an upload to a clean JPEG before it's pushed to Shopify.
 * Raw full-res / iPhone HEIC / mislabeled files can fail to ingest on Shopify;
 * a 2048px JPEG the browser produced always ingests. Undecodable formats (e.g.
 * HEIC on Chrome) throw a clear message instead of silently pushing a bad file.
 * Returns { b64, dataUrl } — b64 (no prefix) is what /api/shopify/media wants.
 */
async function downscaleToParts(
  file: File,
  maxDim = 2048,
  quality = 0.9,
): Promise<{ b64: string; dataUrl: string }> {
  const srcUrl = await readDataUrl(file);
  const type = (file.type || "").toLowerCase();
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode"));
      im.src = srcUrl;
    });
  } catch {
    throw new Error(`${file.name || "image"}: this image format${type ? ` (${type})` : ""} isn't supported — please use JPG or PNG.`);
  }
  const safe = type === "image/jpeg" || type === "image/jpg" || type === "image/png" || type === "image/webp";
  const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
  const scale = Math.min(1, maxDim / longest);
  if (safe && scale >= 1 && file.size <= 2 * 1024 * 1024) {
    return { b64: srcUrl.split(",")[1] || "", dataUrl: srcUrl };
  }
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { b64: srcUrl.split(",")[1] || "", dataUrl: srcUrl };
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const b64 = dataUrl.split(",")[1] || "";
  if (!b64) throw new Error(`${file.name || "image"}: could not process this image — please use JPG or PNG.`);
  return { b64, dataUrl };
}

function download(src: string, name: string) {
  const a = document.createElement("a");
  a.href = src;
  a.download = name;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function MediaManager({ matrixId, shopifyProductId, variants, canManage }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const toggleSel = (key: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const fileRef = useRef<HTMLInputElement>(null);

  // Variant images are assigned per COLOUR: pick one colour and the image is
  // attached to EVERY size's variant under that colour. No per-size picking.
  const colorOpts = useMemo(() => {
    const byColor = new Map<string, string[]>();
    for (const v of variants) {
      const c = (v.color || "").trim();
      if (!c) continue;
      const arr = byColor.get(c) || [];
      if (v.shopify_variant_id) arr.push(v.shopify_variant_id); // all sizes of this colour
      byColor.set(c, arr);
    }
    // Only colours with at least one Shopify-linked size can receive an image.
    return Array.from(byColor.entries())
      .filter(([, variantIds]) => variantIds.length > 0)
      .map(([color, variantIds]) => ({ color, variantIds }));
  }, [variants]);

  // Auto-fill alt text for any image missing it (silent background pass); the
  // operator can still edit/regenerate per image afterwards.
  const autoAltMissing = useCallback(async (list: MediaItem[]) => {
    const missing = list.filter((m) => !m.alt.trim());
    if (!missing.length) return;
    const results = await Promise.allSettled(
      missing.map(async (m) => {
        const r = await fetch("/api/openai/image-alt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: m.url }),
        });
        const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
        return { key: m.key, alt: (j.alt || j.altText || "").trim() };
      }),
    );
    const alts = new Map<string, string>();
    for (const res of results) if (res.status === "fulfilled" && res.value.alt) alts.set(res.value.key, res.value.alt);
    if (alts.size) setItems((prev) => prev.map((m) => (alts.has(m.key) && !m.alt.trim() ? { ...m, alt: alts.get(m.key) as string } : m)));
  }, []);

  const load = useCallback(async () => {
    if (!shopifyProductId) {
      setLoaded(true);
      return;
    }
    setBusy("load");
    setErr(null);
    try {
      const r = await fetch(`/api/shopify/media?matrixId=${matrixId}`);
      const j = (await r.json().catch(() => ({}))) as { media?: Array<{ id: string; url: string; alt: string }> };
      const mapped: MediaItem[] = (j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" }));
      setItems(mapped);
      void autoAltMissing(mapped);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load images");
    } finally {
      setBusy(null);
      setLoaded(true);
    }
  }, [matrixId, shopifyProductId, autoAltMissing]);

  useEffect(() => {
    void load();
  }, [load]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("upload");
    setErr(null);
    try {
      const added: MediaItem[] = [];
      const failed: string[] = [];
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        try {
          const { b64, dataUrl } = await downscaleToParts(f);
          added.push({ key: `new-${f.name}-${added.length}-${b64.length}`, kind: "new", b64, url: dataUrl, alt: "", color: "" });
        } catch (e) {
          failed.push(e instanceof Error ? e.message : `${f.name}: unreadable image`);
        }
      }
      if (added.length) setItems((prev) => [...prev, ...added]);
      if (failed.length) setErr(failed.slice(0, 3).join(" · "));
    } finally {
      setBusy(null);
    }
  }, []);

  const genAlt = useCallback(async (key: string) => {
    const item = items.find((m) => m.key === key);
    if (!item) return;
    setBusy(`alt-${key}`);
    try {
      const r = await fetch("/api/openai/image-alt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: item.url }),
      });
      const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
      const alt = (j.alt || j.altText || "").trim();
      if (alt) setItems((prev) => prev.map((m) => (m.key === key ? { ...m, alt } : m)));
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }, [items]);

  const genAllAlts = useCallback(async () => {
    if (!items.length) return;
    setBusy("alt-all");
    try {
      const results = await Promise.allSettled(
        items.map(async (m) => {
          const r = await fetch("/api/openai/image-alt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: m.url }),
          });
          const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
          return { key: m.key, alt: (j.alt || j.altText || "").trim() };
        }),
      );
      const alts = new Map<string, string>();
      for (const res of results) if (res.status === "fulfilled" && res.value.alt) alts.set(res.value.key, res.value.alt);
      setItems((prev) => prev.map((m) => (alts.has(m.key) ? { ...m, alt: alts.get(m.key) as string } : m)));
      setMsg(`Generated alt for ${alts.size}/${items.length} image(s).`);
    } finally {
      setBusy(null);
    }
  }, [items]);

  const move = (key: string, dir: -1 | 1) =>
    setItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const makeHero = (key: string) =>
    setItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      if (i <= 0) return prev;
      const copy = [...prev];
      const [it] = copy.splice(i, 1);
      copy.unshift(it);
      return copy;
    });
  // Drop reorder. If the dragged row is part of a multi-selection, the WHOLE
  // selection moves together (kept in their existing order), inserted before the
  // drop target; otherwise just the dragged row moves.
  const dropOn = (targetKey: string) =>
    setItems((prev) => {
      if (!dragKey) return prev;
      const movingKeys =
        sel.has(dragKey) && sel.size > 0 ? new Set(sel) : new Set<string>([dragKey]);
      if (movingKeys.has(targetKey)) return prev;
      const moved = prev.filter((m) => movingKeys.has(m.key));
      const rest = prev.filter((m) => !movingKeys.has(m.key));
      const ti = rest.findIndex((m) => m.key === targetKey);
      if (ti < 0 || moved.length === 0) return prev;
      return [...rest.slice(0, ti), ...moved, ...rest.slice(ti)];
    });
  // Drop onto the tail zone → move to the very end (per-row drop always inserts
  // BEFORE a row, so it can never reach the bottom).
  const dropAtEnd = () =>
    setItems((prev) => {
      if (!dragKey) return prev;
      const movingKeys = sel.has(dragKey) && sel.size > 0 ? new Set(sel) : new Set<string>([dragKey]);
      const moved = prev.filter((m) => movingKeys.has(m.key));
      if (moved.length === 0) return prev;
      const rest = prev.filter((m) => !movingKeys.has(m.key));
      return [...rest, ...moved];
    });
  const remove = (key: string) => setItems((prev) => prev.filter((m) => m.key !== key));

  const publish = useCallback(async () => {
    setBusy("publish");
    setErr(null);
    setMsg(null);
    try {
      // One colour → hero (index 0) auto-set as its main pic; many colours → the
      // per-image colour the operator picked (each colour used at most once).
      const single = colorOpts.length === 1 ? colorOpts[0] : null;
      const payload = items.map((m, idx) => {
        const colorName = single ? (idx === 0 ? single.color : "") : m.color;
        const variantIds = colorName ? colorOpts.find((o) => o.color === colorName)?.variantIds : undefined;
        return m.kind === "existing"
          ? { kind: "existing", mediaId: m.mediaId, alt: m.alt, variantIds }
          : { kind: "new", b64: m.b64, alt: m.alt, variantIds };
      });
      const r = await fetch("/api/shopify/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, items: payload }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        media?: Array<{ id: string; url: string; alt: string }>;
        warnings?: string[];
        imageWriteback?: { variantsMatched: number; galleryCount: number } | null;
      };
      if (!r.ok) throw new Error(j.error ?? "Publish failed");
      setItems((j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" })));
      setSel(new Set());
      // Distinguish images that FAILED to push (stage/create) from benign notes
      // (reorder/writeback) — a failed image push must never read as success.
      const allWarn = j.warnings ?? [];
      const hardFails = allWarn.filter((w) => /^(stage|create)/.test(w));
      const wb = j.imageWriteback;
      const back = wb ? ` · synced ${wb.galleryCount} link(s) + ${wb.variantsMatched} colour image(s) back to WMS` : "";
      if (hardFails.length) {
        setMsg(null);
        setErr(`${hardFails.length} image(s) could not be pushed: ${hardFails.slice(0, 2).join(" · ")}`);
      } else {
        const note = allWarn.length ? ` · note: ${allWarn.slice(0, 2).join(" · ")}` : "";
        setErr(null);
        setMsg(`Saved — ${(j.media || []).length} image(s) live on Shopify${back}${note}.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setBusy(null);
    }
  }, [items, matrixId, colorOpts]);

  const field =
    "rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-fg)] max-md:py-2 max-md:text-base";
  // One colour → hero is auto-assigned as its main pic; many colours → one image
  // per colour (each pick locks that colour out of the other images).
  const singleColor = colorOpts.length === 1 ? colorOpts[0] : null;

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-[0.85rem] text-[var(--wms-muted)]">
        This product isn&apos;t on Shopify yet. Use <span className="text-[var(--wms-accent)]">🔗 Link to Shopify</span>{" "}
        (if it already exists there) or <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span> first, then
        manage its images here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[0.9rem] uppercase tracking-wide text-[var(--wms-fg)]">Images</span>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" disabled={!canManage || busy !== null} onClick={() => fileRef.current?.click()} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50">
          {busy === "upload" ? "…" : "＋ Upload"}
        </button>
        <button type="button" disabled={!canManage || busy !== null || items.length === 0} onClick={() => void genAllAlts()} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50">
          {busy === "alt-all" ? "…" : "✨ Alt all"}
        </button>
        <button type="button" disabled={!canManage || busy !== null} onClick={() => void publish()} className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50">
          {busy === "publish" ? "Publishing…" : "⤴ Publish to Shopify"}
        </button>
      </div>

      {loaded && items.length === 0 ? (
        <p className="font-mono text-[0.74rem] text-[var(--wms-muted)]">No images. Upload one (＋ Upload) or generate on-model shots in Carbon Studio.</p>
      ) : null}

      <div className="space-y-2">
        {items.map((m, idx) => (
          <div
            key={m.key}
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDrop={() => { dropOn(m.key); setDragKey(null); }}
            className={`flex items-start gap-3 rounded border bg-[var(--wms-surface)] p-2 max-sm:flex-wrap ${dragKey === m.key || (dragKey && sel.has(dragKey) && sel.has(m.key)) ? "opacity-50" : ""} ${sel.has(m.key) ? "ring-1 ring-[var(--wms-accent)] " : ""}${dragKey && dragKey !== m.key ? "border-dashed border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}
          >
            <input
              type="checkbox"
              checked={sel.has(m.key)}
              onChange={() => toggleSel(m.key)}
              title="Select for multi-drag (drag any selected row to move them all)"
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
            />
            <div className="relative shrink-0">
              <img src={m.url} alt={m.alt} className="h-40 w-32 cursor-pointer rounded border border-[var(--wms-border)] object-cover max-sm:h-32 max-sm:w-24" onClick={() => setZoom(m.url)} />
              {idx === 0 ? <span className="absolute left-0 top-0 rounded-br bg-[var(--wms-accent)] px-1 text-[0.62rem] font-bold text-[var(--wms-accent-fg)]">HERO</span> : null}
              {m.kind === "new" ? <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[0.62rem] text-white">NEW</span> : null}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <textarea className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[0.74rem] text-[var(--wms-fg)] max-md:text-base" rows={2} placeholder="alt text" value={m.alt} onChange={(e) => { const v = e.target.value; setItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, alt: v } : x))); }} />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={busy !== null} onClick={() => void genAlt(m.key)} className="rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.68rem] text-[var(--wms-accent)] disabled:opacity-50 max-md:py-2 max-md:px-3">{busy === `alt-${m.key}` ? "…" : "✨ alt"}</button>
                {singleColor ? (
                  idx === 0 ? (
                    <span className="font-mono text-[0.68rem] text-[var(--wms-accent)]">★ main pic for {singleColor.color} (auto)</span>
                  ) : null
                ) : (
                  <>
                    <label className="font-mono text-[0.68rem] text-[var(--wms-muted)]">colour:</label>
                    <select className={field} value={m.color} title="One image per colour — the chosen colour locks out of the other images" onChange={(e) => { const v = e.target.value; setItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, color: v } : x))); }}>
                      <option value="">— none —</option>
                      {colorOpts.filter((o) => o.color === m.color || !items.some((x) => x.key !== m.key && x.color === o.color)).map((o) => (<option key={o.color} value={o.color}>{o.color} · all {o.variantIds.length} size{o.variantIds.length === 1 ? "" : "s"}</option>))}
                    </select>
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1 max-sm:w-full max-sm:flex-row max-sm:flex-wrap">
              <div draggable onDragStart={() => setDragKey(m.key)} onDragEnd={() => setDragKey(null)} title="Drag to reorder" className="cursor-move select-none rounded border border-[var(--wms-border)] px-2 py-1 text-center text-base text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">⠿</div>
              <button type="button" onClick={() => move(m.key, -1)} disabled={idx === 0} className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">↑</button>
              <button type="button" onClick={() => move(m.key, 1)} disabled={idx === items.length - 1} className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">↓</button>
              <button type="button" onClick={() => makeHero(m.key)} disabled={idx === 0} title="Make hero" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-table-clean-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">★</button>
              <button type="button" onClick={() => download(m.url, `${m.kind === "new" ? "upload" : "shopify"}-${idx + 1}.png`)} title="Download" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">⬇</button>
              <button type="button" onClick={() => remove(m.key)} title="Remove (deletes from Shopify on publish)" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-status-danger-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">✕</button>
            </div>
          </div>
        ))}
        {items.length > 0 ? (
          <div
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDrop={() => { dropAtEnd(); setDragKey(null); }}
            className={`rounded border border-dashed py-3 text-center font-mono text-[0.68rem] transition-colors ${dragKey ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/10 text-[var(--wms-accent)]" : "border-transparent text-transparent"}`}
          >
            ⬇ drop here to move to the end
          </div>
        ) : null}
      </div>

      {err ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</p> : msg ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-success-fg)]">{msg}</p> : null}

      {zoom ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt="Full size" className="max-h-full max-w-full rounded-lg" />
          <button type="button" onClick={() => setZoom(null)} className="absolute right-4 top-4 rounded-md bg-white/10 px-3 py-1.5 font-mono text-[0.85rem] text-white">✕ Close</button>
        </div>
      ) : null}
    </div>
  );
}
