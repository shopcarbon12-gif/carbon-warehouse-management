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

function b64ToFile(b64: string, name: string): File {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: "image/png" });
}

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
    setCrops([]);
    const chosen = [...panels].sort((a, b) => a - b);
    const all: Crop[] = [];
    try {
      for (let i = 0; i < chosen.length; i += 1) {
        const panel = chosen[i];
        setProgress(`Generating panel ${panel} (${i + 1}/${chosen.length})…`);
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
          all.push({
            id: `p${panel}-err`,
            b64: "",
            label: `Panel ${panel}: ${(typeof e === "string" ? e : (e as { message?: string })?.message) || json.warning || "failed"}`,
            selected: false,
          });
          continue;
        }
        const { left, right } = await splitPanelToThreeByFour(json.imageBase64);
        all.push({ id: `p${panel}-l`, b64: left, label: `P${panel} · Pose ${poseA}`, selected: true });
        all.push({ id: `p${panel}-r`, b64: right, label: `P${panel} · Pose ${poseB}`, selected: true });
        setCrops([...all]);
      }
      setProgress("");
      setMsg(`Generated ${all.filter((c) => c.b64).length} crop(s). Select what to keep, then push.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(null);
      setProgress("");
    }
  }, [model, itemRefs, panels, itemType]);

  const push = useCallback(async () => {
    const target = colors.find((c) => c.color === color)?.variant;
    if (!target?.shopify_variant_id) return setErr("Pick a published colour.");
    const chosen = crops.filter((c) => c.selected && c.b64);
    if (!chosen.length) return setErr("Select at least one crop.");
    setBusy("push");
    setErr(null);
    setMsg(`Pushing ${chosen.length} image(s) to Shopify…`);
    try {
      let ok = 0;
      for (const c of chosen) {
        const fd = new FormData();
        fd.append("matrixId", matrixId);
        fd.append("customSkuId", target.id);
        fd.append("force", "1");
        fd.append("alt", `${color} on-model`);
        fd.append("file", b64ToFile(c.b64, `carbon-studio-${c.id}.png`));
        const r = await fetch("/api/shopify/image-upload", { method: "POST", body: fd });
        if (r.ok) ok += 1;
      }
      setMsg(`Pushed ${ok}/${chosen.length} image(s) to Shopify (${color}). See the Images tab.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(null);
    }
  }, [colors, color, crops, matrixId]);

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
          {busy === "generate" ? "Generating…" : `✦ Generate ${panels.length} panel(s)`}
        </button>
        {crops.some((c) => c.selected && c.b64) ? (
          <button
            type="button"
            disabled={!canManage || busy !== null}
            onClick={() => void push()}
            className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
          >
            {busy === "push" ? "Pushing…" : `⤴ Push to Shopify (${color})`}
          </button>
        ) : null}
        {progress ? <span className="font-mono text-[0.6rem] text-[var(--wms-accent)]">{progress}</span> : null}
        {msg ? <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">{msg}</span> : null}
        {err ? <span className="font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>

      {crops.length ? (
        <div className="flex flex-wrap gap-3">
          {crops.map((c) =>
            c.b64 ? (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setCrops((prev) => prev.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)))
                }
                className={`overflow-hidden rounded-md border ${
                  c.selected ? "border-[var(--wms-accent)] ring-1 ring-[var(--wms-accent)]" : "border-[var(--wms-border)]"
                }`}
              >
                <img src={`data:image/png;base64,${c.b64}`} alt={c.label} className="h-48 w-36 object-cover" />
                <span className="block px-1 py-0.5 text-center font-mono text-[0.55rem] text-[var(--wms-muted)]">
                  {c.label} {c.selected ? "✓" : ""}
                </span>
              </button>
            ) : (
              <span key={c.id} className="max-w-[240px] font-mono text-[0.55rem] text-[var(--wms-status-danger-fg)]">
                {c.label}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
