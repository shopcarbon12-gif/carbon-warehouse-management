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

function readB64(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || "").split(",")[1] || "");
    r.readAsDataURL(file);
  });
}
function readDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.readAsDataURL(file);
  });
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
      setItems(
        (j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" })),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load images");
    } finally {
      setBusy(null);
      setLoaded(true);
    }
  }, [matrixId, shopifyProductId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("upload");
    try {
      const added: MediaItem[] = [];
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        const [b64, dataUrl] = await Promise.all([readB64(f), readDataUrl(f)]);
        added.push({ key: `new-${f.name}-${added.length}-${b64.length}`, kind: "new", b64, url: dataUrl, alt: "", color: "" });
      }
      setItems((prev) => [...prev, ...added]);
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
  const dropOn = (targetKey: string) =>
    setItems((prev) => {
      if (!dragKey || dragKey === targetKey) return prev;
      const from = prev.findIndex((m) => m.key === dragKey);
      const to = prev.findIndex((m) => m.key === targetKey);
      if (from < 0 || to < 0) return prev;
      const copy = [...prev];
      const [it] = copy.splice(from, 1);
      copy.splice(to, 0, it);
      return copy;
    });
  const remove = (key: string) => setItems((prev) => prev.filter((m) => m.key !== key));

  const publish = useCallback(async () => {
    setBusy("publish");
    setErr(null);
    setMsg(null);
    try {
      const payload = items.map((m) => {
        const variantIds = m.color ? colorOpts.find((o) => o.color === m.color)?.variantIds : undefined;
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
      };
      if (!r.ok) throw new Error(j.error ?? "Publish failed");
      setItems((j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" })));
      if (j.warnings?.length) setErr(`Some images failed: ${j.warnings.slice(0, 3).join(" · ")}`);
      else setMsg(`Saved — ${(j.media || []).length} image(s) live on Shopify.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setBusy(null);
    }
  }, [items, matrixId, colorOpts]);

  const field =
    "rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.55rem] text-[var(--wms-fg)]";

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-xs text-[var(--wms-muted)]">
        This product isn&apos;t on Shopify yet. Use <span className="text-[var(--wms-accent)]">🔗 Link to Shopify</span>{" "}
        (if it already exists there) or <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span> first, then
        manage its images here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)]">Images</span>
        <span className="font-mono text-[0.55rem] text-[var(--wms-muted)]">first = hero · drag or ↑↓ order · ★ hero · colour → all its sizes · ✨ alt</span>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" disabled={!canManage || busy !== null} onClick={() => fileRef.current?.click()} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50">
          {busy === "upload" ? "…" : "＋ Upload"}
        </button>
        <button type="button" disabled={!canManage || busy !== null || items.length === 0} onClick={() => void genAllAlts()} className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50">
          {busy === "alt-all" ? "…" : "✨ Alt all"}
        </button>
        <button type="button" disabled={!canManage || busy !== null} onClick={() => void publish()} className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50">
          {busy === "publish" ? "Publishing…" : "⤴ Publish to Shopify"}
        </button>
      </div>

      {loaded && items.length === 0 ? (
        <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">No images. Upload one (＋ Upload) or generate on-model shots in Carbon Studio.</p>
      ) : null}

      <div className="space-y-2">
        {items.map((m, idx) => (
          <div
            key={m.key}
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDrop={() => { dropOn(m.key); setDragKey(null); }}
            className={`flex items-start gap-3 rounded border bg-[var(--wms-surface)] p-2 ${dragKey === m.key ? "opacity-50" : ""} ${dragKey && dragKey !== m.key ? "border-dashed border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}
          >
            <div className="relative shrink-0">
              <img src={m.url} alt={m.alt} className="h-24 w-20 cursor-pointer rounded border border-[var(--wms-border)] object-cover" onClick={() => setZoom(m.url)} />
              {idx === 0 ? <span className="absolute left-0 top-0 rounded-br bg-[var(--wms-accent)] px-1 text-[0.5rem] font-bold text-[var(--wms-accent-fg)]">HERO</span> : null}
              {m.kind === "new" ? <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[0.5rem] text-white">NEW</span> : null}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <textarea className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[0.6rem] text-[var(--wms-fg)]" rows={2} placeholder="alt text" value={m.alt} onChange={(e) => { const v = e.target.value; setItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, alt: v } : x))); }} />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={busy !== null} onClick={() => void genAlt(m.key)} className="rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.55rem] text-[var(--wms-accent)] disabled:opacity-50">{busy === `alt-${m.key}` ? "…" : "✨ alt"}</button>
                <label className="font-mono text-[0.55rem] text-[var(--wms-muted)]">colour:</label>
                <select className={field} value={m.color} onChange={(e) => { const v = e.target.value; setItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, color: v } : x))); }} title="Attaches this image to every size of the chosen colour">
                  <option value="">— none —</option>
                  {colorOpts.map((o) => (<option key={o.color} value={o.color}>{o.color} · all {o.variantIds.length} size{o.variantIds.length === 1 ? "" : "s"}</option>))}
                </select>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <div draggable onDragStart={() => setDragKey(m.key)} onDragEnd={() => setDragKey(null)} title="Drag to reorder" className="cursor-move select-none rounded border border-[var(--wms-border)] px-1.5 text-center text-[0.7rem] text-[var(--wms-muted)]">⠿</div>
              <button type="button" onClick={() => move(m.key, -1)} disabled={idx === 0} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↑</button>
              <button type="button" onClick={() => move(m.key, 1)} disabled={idx === items.length - 1} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↓</button>
              <button type="button" onClick={() => makeHero(m.key)} disabled={idx === 0} title="Make hero" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-table-clean-fg)] disabled:opacity-30">★</button>
              <button type="button" onClick={() => download(m.url, `${m.kind === "new" ? "upload" : "shopify"}-${idx + 1}.png`)} title="Download" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)]">⬇</button>
              <button type="button" onClick={() => remove(m.key)} title="Remove (deletes from Shopify on publish)" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-status-danger-fg)]">✕</button>
            </div>
          </div>
        ))}
      </div>

      {err ? <p className="font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</p> : msg ? <p className="font-mono text-[0.6rem] text-[var(--wms-status-success-fg)]">{msg}</p> : null}

      {zoom ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt="Full size" className="max-h-full max-w-full rounded-lg" />
          <button type="button" onClick={() => setZoom(null)} className="absolute right-4 top-4 rounded-md bg-white/10 px-3 py-1.5 font-mono text-xs text-white">✕ Close</button>
        </div>
      ) : null}
    </div>
  );
}
