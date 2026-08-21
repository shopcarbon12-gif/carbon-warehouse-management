/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMasterPanelPrompt,
  getPanelPosePair,
  getPanelButtonLabel,
  pickExpressionDirective,
  splitPanelToThreeByFour,
} from "@/lib/panelGeneration";

/**
 * Carbon Studio (M2) — the OpenAI V2 generator, product-scoped.
 * Upload the item photo here (drag/file or phone-camera via QR), pick a model +
 * colour, choose one or MORE panels, generate, then push the chosen on-model
 * crops to Shopify per colour through the M2 image pipeline.
 */
type Model = { model_id: string; name: string; gender: string; ref_image_urls: string[] };
type StudioVariant = { id: string; color: string | null; shopify_variant_id?: string | null };
type Crop = { id: string; b64: string; label: string; selected: boolean };
/** url = what the generator fetches (may be an auth'd R2 URL); preview = a
 * browser-renderable thumbnail (data URL for uploads, public URL for Shopify). */
type ItemRef = { url: string; preview?: string };
/** A media-manager row: an existing Shopify image or a new crop to add.
 * `color` = the variant colour this image is the MAIN pic for (all sizes). */
type MediaItem = {
  key: string;
  kind: "existing" | "new";
  mediaId?: string;
  b64?: string;
  url: string; // display src (cdn url for existing, data-url for new)
  alt: string;
  color: string;
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.readAsDataURL(file);
  });
}

type Props = {
  matrixId: string;
  shopifyProductId: string | null;
  itemRefUrls: string[];
  defaultItemType: string;
  /** Merchandise category (e.g. "WOMEN" / "MEN") — used to filter models by gender. */
  category?: string;
  variants: StudioVariant[];
  canManage: boolean;
};

const PANELS = [1, 2, 3, 4];

/** Derive the item's gender from its category/type text. Women-first because
 * "WOMEN" contains "MEN". Returns null when it can't be determined (show all). */
function deriveGender(...text: (string | undefined)[]): "male" | "female" | null {
  const s = text.filter(Boolean).join(" ").toLowerCase();
  if (/(women|woman|female|ladies|lady|girl)/.test(s)) return "female";
  if (/\b(men|man|male|boy|mens|guys?)\b/.test(s) || /\bmen('s)?\b/.test(s)) return "male";
  return null;
}

/** Download an image (data-url or remote url) as a file. */
function downloadImage(src: string, name: string) {
  const a = document.createElement("a");
  a.href = src;
  a.download = name;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function CarbonStudioTab({
  matrixId,
  shopifyProductId,
  itemRefUrls,
  defaultItemType,
  category,
  variants,
  canManage,
}: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [itemType, setItemType] = useState<string>(defaultItemType);
  const [instruction, setInstruction] = useState<string>("");
  const [panels, setPanels] = useState<number[]>([...PANELS]);
  const [itemRefs, setItemRefs] = useState<ItemRef[]>(
    (itemRefUrls || []).map((u) => ({ url: u, preview: u })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [mediaDragKey, setMediaDragKey] = useState<string | null>(null);
  const [mediaSel, setMediaSel] = useState<Set<string>>(new Set());

  const toggleMediaSel = (key: string) =>
    setMediaSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [qr, setQr] = useState<{ url: string; scanUrl: string; sessionId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const colors = useMemo(() => {
    // All colours (independent of link status); prefer a linked variant when one
    // exists so the push has a target, but never hide colours from generation.
    const seen = new Map<string, StudioVariant>();
    for (const v of variants) {
      const key = (v.color || "").trim() || "—";
      const existing = seen.get(key);
      if (!existing || (!existing.shopify_variant_id && v.shopify_variant_id)) seen.set(key, v);
    }
    return Array.from(seen.entries()).map(([color, v]) => ({ color, variant: v }));
  }, [variants]);
  const [color, setColor] = useState<string>("");

  // Per-colour image assignment (matches Images tab): one colour → every size's
  // variant. Used to set a generated pic as the MAIN pic for a variant colour.
  const colorOpts = useMemo(() => {
    const byColor = new Map<string, string[]>();
    for (const v of variants) {
      const c = (v.color || "").trim();
      if (!c) continue;
      const arr = byColor.get(c) || [];
      if (v.shopify_variant_id) arr.push(v.shopify_variant_id);
      byColor.set(c, arr);
    }
    return Array.from(byColor.entries())
      .filter(([, ids]) => ids.length > 0)
      .map(([c, variantIds]) => ({ color: c, variantIds }));
  }, [variants]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/models/list");
        const j = (await r.json().catch(() => ({}))) as { models?: Model[] };
        if (!alive) return;
        const list = (j.models || []).filter((m) => (m.ref_image_urls || []).length >= 3);
        setModels(list);
        if (list[0]) setModelId(list[0].model_id);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!color && colors[0]) setColor(colors[0].color);
  }, [colors, color]);

  // Poll the phone-camera hand-off while a QR is showing.
  useEffect(() => {
    if (!qr) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/image-handoff/session/${qr.sessionId}`);
        if (!r.ok) return;
        const j = (await r.json().catch(() => ({}))) as {
          ready?: boolean;
          images?: { imageUrl: string; previewUrl?: string }[];
          imageUrl?: string;
          previewUrl?: string;
        };
        // Keep the QR open so the phone can send more; a burst of up to 6 photos
        // all arrive in one tick via `images`.
        if (alive && j.ready) {
          const batch = j.images?.length
            ? j.images.map((im) => ({ url: im.imageUrl, preview: im.previewUrl }))
            : j.imageUrl
              ? [{ url: j.imageUrl, preview: j.previewUrl }]
              : [];
          if (batch.length) {
            setItemRefs((prev) => [...prev, ...batch]);
            setMsg(`Received ${batch.length} photo${batch.length === 1 ? "" : "s"} from phone.`);
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    const stop = setTimeout(() => setQr(null), 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [qr]);

  // Show only models whose gender matches the item (men→male, women→female).
  // Falls back to all models when the item's gender can't be determined.
  const itemGender = useMemo(
    () => deriveGender(category, defaultItemType, itemType),
    [category, defaultItemType, itemType],
  );
  const visibleModels = useMemo(
    () => (itemGender ? models.filter((m) => (m.gender || "").toLowerCase() === itemGender) : models),
    [models, itemGender],
  );
  useEffect(() => {
    if (visibleModels.length && !visibleModels.some((m) => m.model_id === modelId)) {
      setModelId(visibleModels[0].model_id);
    }
  }, [visibleModels, modelId]);

  const model = models.find((m) => m.model_id === modelId) || null;

  const uploadItem = useCallback(async (file: File) => {
    setBusy("upload");
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const preview = await readAsDataUrl(file);
      const r = await fetch("/api/models/upload", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error ?? "Upload failed");
      setItemRefs((prev) => [...prev, { url: j.url as string, preview }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const startPhoneCamera = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/image-handoff/session", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        sessionId?: string;
        scanUrl?: string;
        qrCodeUrl?: string;
      };
      if (!r.ok || !j.sessionId || !j.qrCodeUrl) throw new Error("Could not start phone camera.");
      setQr({ url: j.qrCodeUrl, scanUrl: j.scanUrl || "", sessionId: j.sessionId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Phone camera failed");
    }
  }, []);

  const togglePanel = useCallback((p: number) => {
    setPanels((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p].sort()));
  }, []);

  const generate = useCallback(async () => {
    if (!model) return setErr("Pick a model first.");
    if (!itemRefs.length) return setErr("Add at least one item photo (upload or phone camera).");
    if (!panels.length) return setErr("Select at least one panel.");
    const refUrls = itemRefs.map((r) => r.url);
    setBusy("generate");
    setErr(null);
    setMsg(null);
    // Regenerate flow (carbon-gen): keep the crops you selected, append fresh
    // ones below; unselected old crops are dropped. runTag keeps ids unique.
    const kept = crops.length > 0 ? crops.filter((c) => c.selected && c.b64) : [];
    const runTag = Date.now().toString(36);
    const chosen = [...panels].sort((a, b) => a - b);
    // One facial expression per run so the model doesn't look robotic across
    // products; kept consistent across this run's panels for set coherence.
    const expressionDirective = pickExpressionDirective();
    setProgress(`Generating ${chosen.length} panel(s) in parallel…`);

    const genOnePanel = async (panel: number): Promise<Crop[]> => {
      const [poseA, poseB] = getPanelPosePair(model.gender, panel);
      const panelLabel = getPanelButtonLabel(model.gender, panel);
      const prompt = buildMasterPanelPrompt({
        panelNumber: panel,
        panelLabel,
        poseA,
        poseB,
        modelName: model.name,
        modelGender: model.gender,
        modelRefs: model.ref_image_urls,
        itemRefs: refUrls,
        itemType,
        itemStyleInstructions: instruction,
        expressionDirective,
      });
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          prompt,
          size: "1536x1024",
          modelRefs: model.ref_image_urls,
          itemRefs: refUrls,
          panelQa: { panelNumber: panel, panelLabel, poseA, poseB, modelName: model.name, modelGender: model.gender, itemType },
        }),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        imageBase64?: string;
        degraded?: boolean;
        warning?: string;
        error?: unknown;
      };
      if (!resp.ok || json.degraded || !json.imageBase64) {
        const e = json.error;
        return [
          {
            id: `p${panel}-err-${runTag}`,
            b64: "",
            label: `Panel ${panel}: ${(typeof e === "string" ? e : (e as { message?: string })?.message) || json.warning || "failed"}`,
            selected: false,
          },
        ];
      }
      const { left, right } = await splitPanelToThreeByFour(json.imageBase64);
      return [
        { id: `p${panel}-l-${runTag}`, b64: left, label: `P${panel} · Pose ${poseA}`, selected: true },
        { id: `p${panel}-r-${runTag}`, b64: right, label: `P${panel} · Pose ${poseB}`, selected: true },
      ];
    };

    try {
      // Fire every selected panel AT ONCE (like carbon-gen), not one at a time.
      const settled = await Promise.allSettled(chosen.map((p) => genOnePanel(p)));
      const all: Crop[] = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") all.push(...s.value);
        else
          all.push({
            id: `p${chosen[i]}-fail-${runTag}`,
            b64: "",
            label: `Panel ${chosen[i]}: ${s.reason instanceof Error ? s.reason.message : "failed"}`,
            selected: false,
          });
      });
      setCrops([...kept, ...all]);
      setMsg(`Generated ${all.filter((c) => c.b64).length} crop(s). Select what to keep, then push${kept.length ? ` (kept ${kept.length})` : ""}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(null);
      setProgress("");
    }
  }, [model, itemRefs, panels, itemType, instruction, crops]);

  // ---- Media manager (matches carbon-gen's Publish step) ----
  const openMediaManager = useCallback(async () => {
    setMediaBusy("load");
    setErr(null);
    try {
      const r = await fetch(`/api/shopify/media?matrixId=${matrixId}`);
      const j = (await r.json().catch(() => ({}))) as { media?: Array<{ id: string; url: string; alt: string }> };
      const existing: MediaItem[] = (j.media || []).map((m) => ({
        key: `ex-${m.id}`,
        kind: "existing",
        mediaId: m.id,
        url: m.url,
        alt: m.alt || "",
        color: "",
      }));
      // New crops were generated for the selected colour → pre-assign it (the
      // user can still change or clear the colour per image before publishing).
      const news: MediaItem[] = crops
        .filter((c) => c.selected && c.b64)
        .map((c) => ({ key: `new-${c.id}`, kind: "new", b64: c.b64, url: `data:image/png;base64,${c.b64}`, alt: "", color: color || "" }));
      setMediaItems([...existing, ...news]);
      setShowMedia(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load media");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, crops, color]);

  const genAlt = useCallback(
    async (key: string) => {
      const item = mediaItems.find((m) => m.key === key);
      if (!item) return;
      setMediaBusy(`alt-${key}`);
      try {
        const r = await fetch("/api/openai/image-alt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: item.url }),
        });
        const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
        const alt = (j.alt || j.altText || "").trim();
        if (alt) setMediaItems((prev) => prev.map((m) => (m.key === key ? { ...m, alt } : m)));
      } catch {
        /* ignore */
      } finally {
        setMediaBusy(null);
      }
    },
    [mediaItems],
  );

  const genAllAlts = useCallback(async () => {
    if (!mediaItems.length) return;
    setMediaBusy("alt-all");
    setErr(null);
    try {
      const results = await Promise.allSettled(
        mediaItems.map(async (m) => {
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
      for (const res of results) {
        if (res.status === "fulfilled" && res.value.alt) alts.set(res.value.key, res.value.alt);
      }
      setMediaItems((prev) => prev.map((m) => (alts.has(m.key) ? { ...m, alt: alts.get(m.key) as string } : m)));
      setMsg(`Generated alt text for ${alts.size}/${mediaItems.length} image(s).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Alt generation failed");
    } finally {
      setMediaBusy(null);
    }
  }, [mediaItems]);

  const moveMedia = (key: string, dir: -1 | 1) =>
    setMediaItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const makeHero = (key: string) =>
    setMediaItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      if (i <= 0) return prev;
      const copy = [...prev];
      const [it] = copy.splice(i, 1);
      copy.unshift(it);
      return copy;
    });
  // Drop reorder — moves the whole multi-selection together when the dragged row
  // is selected, otherwise just the dragged row; inserted before the drop target.
  const dropOnMedia = (targetKey: string) =>
    setMediaItems((prev) => {
      if (!mediaDragKey) return prev;
      const movingKeys =
        mediaSel.has(mediaDragKey) && mediaSel.size > 0 ? new Set(mediaSel) : new Set<string>([mediaDragKey]);
      if (movingKeys.has(targetKey)) return prev;
      const moved = prev.filter((m) => movingKeys.has(m.key));
      const rest = prev.filter((m) => !movingKeys.has(m.key));
      const ti = rest.findIndex((m) => m.key === targetKey);
      if (ti < 0 || moved.length === 0) return prev;
      return [...rest.slice(0, ti), ...moved, ...rest.slice(ti)];
    });
  const removeMedia = (key: string) => setMediaItems((prev) => prev.filter((m) => m.key !== key));

  const publishMedia = useCallback(async () => {
    setMediaBusy("publish");
    setErr(null);
    setMsg(null);
    try {
      // Each image can be set as the MAIN pic for a variant colour → attach it
      // to every size's variant of that colour (variantIds).
      const items = mediaItems.map((m) => {
        const variantIds = m.color ? colorOpts.find((o) => o.color === m.color)?.variantIds : undefined;
        return m.kind === "existing"
          ? { kind: "existing", mediaId: m.mediaId, alt: m.alt, variantIds }
          : { kind: "new", b64: m.b64, alt: m.alt, variantIds };
      });
      const r = await fetch("/api/shopify/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, items }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        media?: Array<{ id: string; url: string; alt: string }>;
        warnings?: string[];
      };
      if (!r.ok) throw new Error(j.error ?? "Publish failed");
      const newCount = mediaItems.filter((m) => m.kind === "new").length;
      setMediaItems(
        (j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" })),
      );
      setMediaSel(new Set());
      setCrops((prev) => prev.filter((c) => !c.selected)); // pushed crops consumed
      if (j.warnings?.length) {
        // Surface WHY images may not have pushed (e.g. staging/create failures).
        setErr(`Some images failed: ${j.warnings.slice(0, 3).join(" · ")}`);
        setMsg(null);
      } else {
        setErr(null);
        setMsg(`Saved to Shopify — ${(j.media || []).length} image(s) live${newCount ? `, ${newCount} new` : ""}.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, mediaItems, colorOpts]);

  const label = "block text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
  const field =
    "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]";

  return (
    <div className="space-y-3">
      {/* Item photos */}
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-3">
        <span className={label}>Item photo(s) — the garment reference</span>
        <div className="flex flex-wrap items-center gap-2">
          {itemRefs.map((ref, i) => (
            <div key={ref.url + i} className="relative">
              {ref.preview ? (
                <img src={ref.preview} alt="item ref" className="h-16 w-14 rounded border border-[var(--wms-border)] object-cover" />
              ) : (
                <div className="flex h-16 w-14 items-center justify-center rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] text-center font-mono text-[0.5rem] text-[var(--wms-status-success-fg)]">
                  ✓ photo
                </div>
              )}
              <button
                type="button"
                onClick={() => setItemRefs((p) => p.filter((x) => x.url !== ref.url))}
                className="absolute -right-1 -top-1 rounded-full bg-[var(--wms-surface)] px-1 text-[0.6rem] text-[var(--wms-status-danger-fg)]"
              >
                ✕
              </button>
            </div>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadItem(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={!canManage || busy === "upload"}
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
          >
            {busy === "upload" ? "…" : "＋ Upload"}
          </button>
          <button
            type="button"
            disabled={!canManage}
            onClick={() => void startPhoneCamera()}
            className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
          >
            📱 Phone camera (QR)
          </button>
        </div>
        {qr ? (
          <div className="mt-3 flex items-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
            <img src={qr.url} alt="Scan with your phone" className="h-32 w-32 rounded bg-white p-1" />
            <div className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
              Scan with your phone to take product photos. Each photo you send appears here — send as
              many as you like, then click Done.
              <button
                type="button"
                onClick={() => setQr(null)}
                className="mt-2 block rounded border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-2 py-1 text-[var(--wms-fg)]"
              >
                ✓ Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Options */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <span className={label}>
            Model{itemGender ? <span className="text-[var(--wms-muted)]"> · {itemGender} only</span> : null}
          </span>
          <select className={field} value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {visibleModels.length === 0 ? (
              <option value="">{models.length ? `No ${itemGender ?? ""} models` : "No models"}</option>
            ) : null}
            {visibleModels.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.name} ({m.gender})
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={label}>Item type</span>
          <input className={field} value={itemType} onChange={(e) => setItemType(e.target.value)} />
        </div>
        <div>
          <span className={label}>Colour</span>
          <select className={field} value={color} onChange={(e) => setColor(e.target.value)}>
            {colors.map((c) => (
              <option key={c.color} value={c.color}>
                {c.color}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <span className={label}>Item instruction (optional)</span>
        <input
          className={field}
          placeholder="e.g. oversized cut, super skinny fit, high-waist…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

      {/* Panels */}
      <div>
        <span className={label}>Panels / poses (choose one or more)</span>
        <div className="flex flex-wrap gap-2">
          {PANELS.map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-md border px-2 py-1 font-mono text-[0.6rem] ${
                panels.includes(p)
                  ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]"
                  : "border-[var(--wms-border)] text-[var(--wms-muted)]"
              }`}
            >
              <input
                type="checkbox"
                className="mr-1 align-middle"
                checked={panels.includes(p)}
                onChange={() => togglePanel(p)}
              />
              {model ? getPanelButtonLabel(model.gender, p) : `Panel ${p}`}
            </label>
          ))}
          <button
            type="button"
            onClick={() => setPanels(panels.length === PANELS.length ? [] : [...PANELS])}
            className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.6rem] text-[var(--wms-muted)]"
          >
            {panels.length === PANELS.length ? "Clear" : "All"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canManage || busy !== null || !model || !itemRefs.length || !panels.length}
          onClick={() => void generate()}
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "generate"
            ? "Generating…"
            : crops.length
              ? `↻ Regenerate ${panels.length}`
              : `✦ Generate ${panels.length} panel(s)`}
        </button>
        <button
          type="button"
          disabled={!canManage || mediaBusy !== null}
          onClick={() => void openMediaManager()}
          title="Arrange images, set the hero, alt text, delete, and publish to Shopify"
          className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
        >
          {mediaBusy === "load" ? "Loading…" : "🖼 Manage & publish images"}
        </button>
        {progress ? <span className="font-mono text-[0.6rem] text-[var(--wms-accent)]">{progress}</span> : null}
        {msg ? <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">{msg}</span> : null}
        {err ? <span className="font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>

      {!shopifyProductId ? (
        <p className="font-mono text-[0.55rem] text-[var(--wms-muted)]">
          Generation &amp; download work here without Shopify. To <b>push</b> images, link this
          product (🔗 Link to Shopify) or ✔ Check &amp; Publish it first.
        </p>
      ) : null}

      {crops.length ? (
        <div className="flex flex-wrap gap-3">
          {crops.map((c) =>
            c.b64 ? (
              <div
                key={c.id}
                className={`relative overflow-hidden rounded-md border ${
                  c.selected ? "border-[var(--wms-accent)] ring-1 ring-[var(--wms-accent)]" : "border-[var(--wms-border)]"
                }`}
              >
                <img
                  src={`data:image/png;base64,${c.b64}`}
                  alt={c.label}
                  className="h-48 w-36 cursor-zoom-in object-cover"
                  title="Click to view full size"
                  onClick={() => setZoom(`data:image/png;base64,${c.b64}`)}
                />
                <label
                  className="absolute left-1 top-1 flex cursor-pointer items-center gap-1 rounded bg-black/60 px-1 py-0.5 text-[0.6rem] text-white"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() =>
                      setCrops((prev) => prev.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)))
                    }
                    className="h-3 w-3 accent-[var(--wms-accent)]"
                  />
                  keep
                </label>
                <button
                  type="button"
                  title="Download"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadImage(`data:image/png;base64,${c.b64}`, `carbon-studio-${c.id}.png`);
                  }}
                  className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[0.7rem] leading-none text-white"
                >
                  ⬇
                </button>
                <span className="block px-1 py-0.5 text-center font-mono text-[0.55rem] text-[var(--wms-muted)]">
                  {c.label} {c.selected ? "✓" : ""}
                </span>
              </div>
            ) : (
              <span key={c.id} className="max-w-[240px] font-mono text-[0.55rem] text-[var(--wms-status-danger-fg)]">
                {c.label}
              </span>
            ),
          )}
        </div>
      ) : null}

      {showMedia ? (
        <div className="rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-surface-elevated)]/40 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)]">Manage images</span>
            <span className="font-mono text-[0.55rem] text-[var(--wms-muted)]">
              first = hero · drag or ↑↓ reorder · ☑ select many + drag together · ★ hero · colour = variant main pic (all sizes) · ✨ alt · ✕ remove
            </span>
            <div className="flex-1" />
            <button
              type="button"
              disabled={!canManage || mediaBusy !== null || mediaItems.length === 0}
              onClick={() => void genAllAlts()}
              title="Generate alt text for every image"
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              {mediaBusy === "alt-all" ? "Generating alt…" : "✨ Alt all"}
            </button>
            <button
              type="button"
              disabled={!canManage || mediaBusy !== null}
              onClick={() => void publishMedia()}
              className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
            >
              {mediaBusy === "publish" ? "Publishing…" : "⤴ Publish to Shopify"}
            </button>
            <button
              type="button"
              onClick={() => setShowMedia(false)}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-fg)]"
            >
              Close
            </button>
          </div>
          {!shopifyProductId ? (
            <p className="mb-2 rounded border border-[var(--wms-table-clean-border)] bg-[var(--wms-table-clean-bg)] p-2 font-mono text-[0.55rem] text-[var(--wms-table-clean-fg)]">
              This product isn&apos;t on Shopify yet — arrange &amp; download here, but to PUSH images
              you must Link it (🔗 Link to Shopify) or ✔ Check &amp; Publish first.
            </p>
          ) : null}
          {mediaItems.length === 0 ? (
            <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
              No images yet — generate or upload, then manage here.
            </p>
          ) : (
            <div className="space-y-2">
              {mediaItems.map((m, idx) => (
                <div
                  key={m.key}
                  onDragOver={(e) => { if (mediaDragKey) e.preventDefault(); }}
                  onDrop={() => { dropOnMedia(m.key); setMediaDragKey(null); }}
                  className={`flex items-start gap-3 rounded border bg-[var(--wms-surface)] p-2 ${mediaDragKey === m.key || (mediaDragKey && mediaSel.has(mediaDragKey) && mediaSel.has(m.key)) ? "opacity-50" : ""} ${mediaSel.has(m.key) ? "ring-1 ring-[var(--wms-accent)] " : ""}${mediaDragKey && mediaDragKey !== m.key ? "border-dashed border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}
                >
                  <input
                    type="checkbox"
                    checked={mediaSel.has(m.key)}
                    onChange={() => toggleMediaSel(m.key)}
                    title="Select for multi-drag (drag any selected row to move them all)"
                    className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--wms-accent)]"
                  />
                  <div className="relative shrink-0">
                    <img
                      src={m.url}
                      alt={m.alt}
                      className="h-20 w-16 cursor-pointer rounded border border-[var(--wms-border)] object-cover"
                      onClick={() => setZoom(m.url)}
                    />
                    {idx === 0 ? (
                      <span className="absolute left-0 top-0 rounded-br bg-[var(--wms-accent)] px-1 text-[0.5rem] font-bold text-[var(--wms-accent-fg)]">
                        HERO
                      </span>
                    ) : null}
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[0.5rem] text-white">
                      {m.kind === "new" ? "NEW" : "◆"}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <textarea
                      className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[0.6rem] text-[var(--wms-fg)]"
                      rows={2}
                      placeholder="alt text"
                      value={m.alt}
                      onChange={(e) => {
                        const v = e.target.value;
                        setMediaItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, alt: v } : x)));
                      }}
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={mediaBusy !== null}
                        onClick={() => void genAlt(m.key)}
                        className="rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.55rem] text-[var(--wms-accent)] disabled:opacity-50"
                      >
                        {mediaBusy === `alt-${m.key}` ? "…" : "✨ Generate alt"}
                      </button>
                      <label className="font-mono text-[0.55rem] text-[var(--wms-muted)]">main pic for colour:</label>
                      <select
                        className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.55rem] text-[var(--wms-fg)]"
                        value={m.color}
                        title="Sets this image as the main picture for every size of the chosen colour"
                        onChange={(e) => {
                          const v = e.target.value;
                          setMediaItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, color: v } : x)));
                        }}
                      >
                        <option value="">— none —</option>
                        {colorOpts.map((o) => (
                          <option key={o.color} value={o.color}>
                            {o.color} · all {o.variantIds.length} size{o.variantIds.length === 1 ? "" : "s"}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <div draggable onDragStart={() => setMediaDragKey(m.key)} onDragEnd={() => setMediaDragKey(null)} title="Drag to reorder" className="cursor-move select-none rounded border border-[var(--wms-border)] px-1.5 text-center text-[0.7rem] text-[var(--wms-muted)]">⠿</div>
                    <button type="button" onClick={() => moveMedia(m.key, -1)} disabled={idx === 0} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => moveMedia(m.key, 1)} disabled={idx === mediaItems.length - 1} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => makeHero(m.key)} disabled={idx === 0} title="Make hero" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-table-clean-fg)] disabled:opacity-30">★</button>
                    <button type="button" onClick={() => downloadImage(m.url, `${m.kind === "new" ? "carbon-studio" : "shopify"}-${idx + 1}.png`)} title="Download" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)]">⬇</button>
                    <button type="button" onClick={() => removeMedia(m.key)} title="Remove (deletes from Shopify on publish)" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-status-danger-fg)]">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {err ? (
            <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</p>
          ) : msg ? (
            <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-status-success-fg)]">{msg}</p>
          ) : null}
        </div>
      ) : null}

      {zoom ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="Full size" className="max-h-full max-w-full rounded-lg" />
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="absolute right-4 top-4 rounded-md bg-white/10 px-3 py-1.5 font-mono text-xs text-white"
          >
            ✕ Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
