/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildMasterPanelPrompt,
  getPanelPosePair,
  getPanelButtonLabel,
  splitPanelToThreeByFour,
} from "@/lib/panelGeneration";

/**
 * Carbon Studio (M2) — the OpenAI V2 generator, product-scoped.
 *
 * Drives the exact generation engine (buildMasterPanelPrompt → /api/generate →
 * splitPanelToThreeByFour) using the product's own photos as item references,
 * then pushes the chosen on-model crops to Shopify per colour through the same
 * image pipeline as the Images tab (/api/shopify/image-upload).
 *
 * Prereqs: product published to Shopify + at least one product photo (item ref).
 */
type Model = {
  model_id: string;
  name: string;
  gender: string;
  ref_image_urls: string[];
};
type StudioVariant = {
  id: string;
  color: string | null;
  shopify_variant_id?: string | null;
};
type Crop = { id: string; b64: string; label: string; selected: boolean };

type Props = {
  matrixId: string;
  shopifyProductId: string | null;
  itemRefUrls: string[];
  defaultItemType: string;
  variants: StudioVariant[];
  canManage: boolean;
};

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
  const [panel, setPanel] = useState<number>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [crops, setCrops] = useState<Crop[]>([]);

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

  const model = models.find((m) => m.model_id === modelId) || null;

  const generate = useCallback(async () => {
    if (!model) {
      setErr("Pick a model first.");
      return;
    }
    if (!itemRefUrls.length) {
      setErr("Add at least one product photo (Images tab) to use as the item reference.");
      return;
    }
    setBusy("generate");
    setErr(null);
    setMsg("Generating on-model panel…");
    setCrops([]);
    try {
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
        itemRefs: itemRefUrls,
        itemType,
      });
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          prompt,
          size: "1536x1024",
          modelRefs: model.ref_image_urls,
          itemRefs: itemRefUrls,
          panelQa: {
            panelNumber: panel,
            panelLabel,
            poseA,
            poseB,
            modelName: model.name,
            modelGender: model.gender,
            itemType,
          },
        }),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        imageBase64?: string;
        degraded?: boolean;
        warning?: string;
        error?: unknown;
      };
      if (!resp.ok) {
        const e = json.error;
        throw new Error(
          (typeof e === "string" ? e : (e as { message?: string })?.message) || "Generation failed",
        );
      }
      if (json.degraded) throw new Error(String(json.warning || "Generation returned a degraded image."));
      if (!json.imageBase64) throw new Error("No image returned.");
      const { left, right } = await splitPanelToThreeByFour(json.imageBase64);
      setCrops([
        { id: `p${panel}-l`, b64: left, label: `Pose ${poseA}`, selected: true },
        { id: `p${panel}-r`, b64: right, label: `Pose ${poseB}`, selected: true },
      ]);
      setMsg("Select the crops to keep, then push to the selected colour.");
    } catch (e) {
      setMsg(null);
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(null);
    }
  }, [model, itemRefUrls, panel, itemType]);

  const push = useCallback(async () => {
    const target = colors.find((c) => c.color === color)?.variant;
    if (!target?.shopify_variant_id) {
      setErr("Pick a published colour to attach the image to.");
      return;
    }
    const chosen = crops.filter((c) => c.selected);
    if (!chosen.length) {
      setErr("Select at least one crop.");
      return;
    }
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
        <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span>), then generate
        on-model imagery here.
      </div>
    );
  }

  const label = "block text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
  const field =
    "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]";

  return (
    <div className="space-y-3">
      {!itemRefUrls.length ? (
        <div className="rounded-md border border-[var(--wms-table-clean-border)] bg-[var(--wms-table-clean-bg)] p-3 font-mono text-[0.65rem] text-[var(--wms-table-clean-fg)]">
          Add at least one product photo on the <b>Images</b> tab first — Carbon Studio renders the
          garment from your product photo onto the model.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
        <div>
          <span className={label}>Panel / pose</span>
          <select
            className={field}
            value={panel}
            onChange={(e) => setPanel(Number(e.target.value))}
          >
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                {model ? getPanelButtonLabel(model.gender, p) : `Panel ${p}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canManage || busy !== null || !model || !itemRefUrls.length}
          onClick={() => void generate()}
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "generate" ? "Generating…" : "✦ Generate (gpt-image-1.5)"}
        </button>
        {crops.some((c) => c.selected) ? (
          <button
            type="button"
            disabled={!canManage || busy !== null}
            onClick={() => void push()}
            className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
          >
            {busy === "push" ? "Pushing…" : `⤴ Push to Shopify (${color})`}
          </button>
        ) : null}
        {msg ? <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">{msg}</span> : null}
        {err ? <span className="font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>

      {crops.length ? (
        <div className="flex flex-wrap gap-3">
          {crops.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                setCrops((prev) =>
                  prev.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)),
                )
              }
              className={`overflow-hidden rounded-md border ${
                c.selected ? "border-[var(--wms-accent)] ring-1 ring-[var(--wms-accent)]" : "border-[var(--wms-border)]"
              }`}
              title={c.selected ? "Selected — click to deselect" : "Click to select"}
            >
              <img
                src={`data:image/png;base64,${c.b64}`}
                alt={c.label}
                className="h-48 w-36 object-cover"
              />
              <span className="block px-1 py-0.5 text-center font-mono text-[0.55rem] text-[var(--wms-muted)]">
                {c.label} {c.selected ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
