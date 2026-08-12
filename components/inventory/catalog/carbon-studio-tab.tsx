/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMasterPanelPrompt,
  getPanelPosePair,
  getPanelButtonLabel,
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
/** A media-manager row: an existing Shopify image or a new crop to add. */
type MediaItem = {
  key: string;
  kind: "existing" | "new";
  mediaId?: string;
  b64?: string;
  url: string; // display src (cdn url for existing, data-url for new)
  alt: string;
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
  variants: StudioVariant[];
  canManage: boolean;
};

const PANELS = [1, 2, 3, 4];

export function CarbonStudioTab({
  matrixId,
  shopifyProductId,
  itemRefUrls,
  defaultItemType,
  variants,
  canManage,
}: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [itemType, setItemType] = useState<string>(defaultItemType);
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
  const [qr, setQr] = useState<{ url: string; scanUrl: string; sessionId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const colors = useMemo(() => {
    const seen = new Map<string, StudioVariant>();
    for (const v of variants) {
      const key = (v.color || "").trim() || "—";
      if (!seen.has(key) && v.shopify_variant_id) seen.set(key, v);
    }
    return Array.from(seen.entries()).map(([color, v]) => ({ color, variant: v }));
  }, [variants]);
  const [color, setColor] = useState<string>("");

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
        const r = await fetch(`/api/image-handoff/session/${qr.sessionId}?consume=1`);
        if (!r.ok) return;
        const j = (await r.json().catch(() => ({}))) as { ready?: boolean; imageUrl?: string };
        if (alive && j.ready && j.imageUrl) {
          setItemRefs((prev) => [...prev, { url: j.imageUrl as string }]);
          setQr(null);
          setMsg("Photo received from phone.");
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
  }, [model, itemRefs, panels, itemType, crops]);

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
      }));
      const news: MediaItem[] = crops
        .filter((c) => c.selected && c.b64)
        .map((c) => ({ key: `new-${c.id}`, kind: "new", b64: c.b64, url: `data:image/png;base64,${c.b64}`, alt: "" }));
      setMediaItems([...existing, ...news]);
      setShowMedia(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load media");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, crops]);

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
  const removeMedia = (key: string) => setMediaItems((prev) => prev.filter((m) => m.key !== key));

  const publishMedia = useCallback(async () => {
    setMediaBusy("publish");
    setErr(null);
    setMsg(null);
    try {
      const heroVariantId = colors.find((c) => c.color === color)?.variant?.shopify_variant_id || undefined;
      const items = mediaItems.map((m) =>
        m.kind === "existing"
          ? { kind: "existing", mediaId: m.mediaId, alt: m.alt }
          : { kind: "new", b64: m.b64, alt: m.alt },
      );
      const r = await fetch("/api/shopify/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, items, heroVariantId }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        media?: Array<{ id: string; url: string; alt: string }>;
        warnings?: string[];
      };
      if (!r.ok) throw new Error(j.error ?? "Publish failed");
      setMediaItems(
        (j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "" })),
      );
      setCrops((prev) => prev.filter((c) => !c.selected)); // pushed crops consumed
      setMsg(
        `Media saved to Shopify (${(j.media || []).length} image(s))${j.warnings?.length ? ` — ${j.warnings.length} warning(s)` : ""}.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, mediaItems, colors, color]);

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-xs text-[var(--wms-muted)]">
        Publish this product to Shopify first (use{" "}
        <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span>), then generate here.
      </div>
    );
  }

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
              Scan with your phone camera to take a product photo. Waiting for the photo…
              <button type="button" onClick={() => setQr(null)} className="mt-2 block text-[var(--wms-status-danger-fg)]">
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Options */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <span className={label}>Model</span>
          <select className={field} value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.length === 0 ? <option value="">No models</option> : null}
            {models.map((m) => (
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
                  className="h-48 w-36 cursor-pointer object-cover"
                  onClick={() =>
                    setCrops((prev) => prev.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)))
                  }
                />
                <button
                  type="button"
                  title="View full size"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom(`data:image/png;base64,${c.b64}`);
                  }}
                  className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[0.7rem] leading-none text-white"
                >
                  🔍
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
              first = hero · ↑↓ reorder · ★ hero · ✨ alt · ✕ remove
            </span>
            <div className="flex-1" />
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
          {mediaItems.length === 0 ? (
            <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
              No images yet — generate or upload, then manage here.
            </p>
          ) : (
            <div className="space-y-2">
              {mediaItems.map((m, idx) => (
                <div
                  key={m.key}
                  className="flex items-start gap-3 rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2"
                >
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
                    <button
                      type="button"
                      disabled={mediaBusy !== null}
                      onClick={() => void genAlt(m.key)}
                      className="mt-1 rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.55rem] text-[var(--wms-accent)] disabled:opacity-50"
                    >
                      {mediaBusy === `alt-${m.key}` ? "…" : "✨ Generate alt"}
                    </button>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button type="button" onClick={() => moveMedia(m.key, -1)} disabled={idx === 0} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => moveMedia(m.key, 1)} disabled={idx === mediaItems.length - 1} className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-fg)] disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => makeHero(m.key)} disabled={idx === 0} title="Make hero" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-table-clean-fg)] disabled:opacity-30">★</button>
                    <button type="button" onClick={() => removeMedia(m.key)} title="Remove (deletes from Shopify on publish)" className="rounded border border-[var(--wms-border)] px-1.5 text-[0.7rem] text-[var(--wms-status-danger-fg)]">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
