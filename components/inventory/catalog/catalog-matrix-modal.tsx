"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Plus, Printer, X as XIcon, RotateCcw } from "lucide-react";
import { printRfidLabel } from "./print-label";
import { CatalogImageLightbox } from "./catalog-image-lightbox";

/**
 * Lightspeed-style matrix EDITOR. Opens from CatalogItemDetailsModal's "Matrix"
 * button. Fully WMS-owned (Lightspeed retiring), so the operator can:
 *   - edit Shared Values (description / brand / category / subcategory / upc)
 *   - edit Default Values (price + cost) which CASCADE into every variant's
 *     price/cost; the Shared UPC also cascades into every variant's UPC
 *   - add a Color → generates a new variant row per existing size (and v.v.)
 *   - edit / delete (archive) any variant row
 * New rows get blank SKUs the operator fills in; Save blocks empty/dup SKUs.
 * Existing rows save via PATCH; new rows POST; deletes archive. Admin-only.
 */

type Matrix = {
  id: string;
  ls_system_id: string | null;
  description: string;
  brand: string | null;
  vendor: string | null;
  category: string | null;
  subcategory_1: string | null;
  upc: string | null;
  archived: boolean;
  /** Full Shopify product gallery (ordered cdn.shopify.com URLs). */
  image_urls?: string[];
  featured_image_url?: string | null;
};

type Variant = {
  id: string;
  sku: string;
  ls_system_id: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  retail_price: string | null;
  default_cost: string | null;
  archived: boolean;
  active_epc_count: number;
};

type MatrixDetailResp = { matrix: Matrix; variants: Variant[] };

type Props = {
  matrixId: string;
  canManage: boolean;
  onClose: () => void;
  onMutated?: () => void;
};

type MatrixForm = {
  description: string;
  brand: string;
  category: string;
  subcategory_1: string;
  upc: string;
};

/** Editable Group-Items row (existing or staged-new). */
type RowState = {
  key: string;
  id: string | null; // existing custom_sku id, null when new
  isNew: boolean;
  markedDelete: boolean; // archive-on-save (existing) — new rows are dropped instead
  origArchived: boolean;
  hasStock: boolean;
  color: string;
  size: string;
  upc: string;
  retail_price: string;
  default_cost: string;
  sku: string;
  orig: { color: string; size: string; upc: string; retail_price: string; default_cost: string; sku: string } | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<MatrixDetailResp>;
};

function parseMoney(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}
function moneyOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
function money2(s: string | null): string {
  const t = (s ?? "").trim();
  if (t === "") return "";
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n.toFixed(2) : (s ?? "");
}
function fmtPct(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

function matrixForm(m: Matrix): MatrixForm {
  return {
    description: m.description ?? "",
    brand: m.brand ?? "",
    category: m.category ?? "",
    subcategory_1: m.subcategory_1 ?? "",
    upc: m.upc ?? "",
  };
}
function rowFromVariant(v: Variant): RowState {
  const base = {
    color: v.color ?? "",
    size: v.size ?? "",
    upc: v.upc ?? "",
    retail_price: v.retail_price ?? "",
    default_cost: money2(v.default_cost),
    sku: v.sku ?? "",
  };
  return {
    key: v.id,
    id: v.id,
    isNew: false,
    markedDelete: false,
    origArchived: v.archived,
    hasStock: v.active_epc_count > 0,
    ...base,
    orig: { ...base },
  };
}

let tempSeq = 0;
const nextTempKey = () => `new-${(tempSeq += 1)}`;

export function CatalogMatrixModal({ matrixId, canManage, onClose, onMutated }: Props) {
  const { data, error, mutate, isLoading } = useSWR<MatrixDetailResp>(
    `/api/inventory/catalog/matrices/${matrixId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [mForm, setMForm] = useState<MatrixForm | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [defPrice, setDefPrice] = useState("");
  const [defCost, setDefCost] = useState("");
  const [newColor, setNewColor] = useState("");
  const [newSize, setNewSize] = useState("");

  // Seed local editable state from the fetched data (and after each save).
  useEffect(() => {
    if (!data) return;
    setMForm(matrixForm(data.matrix));
    setRows(data.variants.map(rowFromVariant));
    let p: number | null = null;
    let c: number | null = null;
    for (const v of data.variants) {
      const pp = parseMoney(v.retail_price);
      const cc = parseMoney(v.default_cost);
      if (pp != null) p = p == null ? pp : Math.min(p, pp);
      if (cc != null) c = c == null ? cc : Math.min(c, cc);
    }
    setDefPrice(p == null ? "" : money2(String(p)));
    setDefCost(c == null ? "" : money2(String(c)));
    setNewColor("");
    setNewSize("");
  }, [data]);

  const clearMsgs = () => {
    setOkMsg(null);
  };
  const patchMatrix = (p: Partial<MatrixForm>) => {
    clearMsgs();
    setMForm((f) => (f ? { ...f, ...p } : f));
  };
  const patchRow = (key: string, p: Partial<RowState>) => {
    clearMsgs();
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  };

  // Cascades — Default price/cost and Shared UPC fill every live row.
  const cascadePrice = (v: string) => {
    clearMsgs();
    setDefPrice(v);
    setRows((rs) => rs.map((r) => (r.markedDelete ? r : { ...r, retail_price: v })));
  };
  const cascadeCost = (v: string) => {
    clearMsgs();
    setDefCost(v);
    setRows((rs) => rs.map((r) => (r.markedDelete ? r : { ...r, default_cost: v })));
  };
  const cascadeUpc = (v: string) => {
    patchMatrix({ upc: v });
    setRows((rs) => rs.map((r) => (r.markedDelete ? r : { ...r, upc: v })));
  };

  const colors = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.markedDelete) continue;
      const c = r.color.trim();
      if (c && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out;
  }, [rows]);
  const sizes = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.markedDelete) continue;
      const s = r.size.trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }, [rows]);

  const blankRow = (color: string, size: string): RowState => ({
    key: nextTempKey(),
    id: null,
    isNew: true,
    markedDelete: false,
    origArchived: false,
    hasStock: false,
    color,
    size,
    upc: mForm?.upc ?? "",
    retail_price: defPrice,
    default_cost: defCost,
    sku: "",
    orig: null,
  });

  const addColor = () => {
    const name = newColor.trim();
    if (!name) return;
    if (colors.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setErr(`Color "${name}" already exists.`);
      return;
    }
    setErr(null);
    const targetSizes = sizes.length > 0 ? sizes : [""];
    setRows((rs) => [...rs, ...targetSizes.map((s) => blankRow(name, s))]);
    setNewColor("");
  };
  const addSize = () => {
    const name = newSize.trim();
    if (!name) return;
    if (sizes.some((s) => s.toLowerCase() === name.toLowerCase())) {
      setErr(`Size "${name}" already exists.`);
      return;
    }
    setErr(null);
    const targetColors = colors.length > 0 ? colors : [""];
    setRows((rs) => [...rs, ...targetColors.map((c) => blankRow(c, name))]);
    setNewSize("");
  };

  const [printingId, setPrintingId] = useState<string | null>(null);
  const printRow = async (variantId: string) => {
    setPrintingId(variantId);
    setErr(null);
    setOkMsg(null);
    const res = await printRfidLabel(variantId);
    if (res.ok) setOkMsg(res.message);
    else setErr(res.message);
    setPrintingId(null);
  };

  const deleteRow = (key: string) => {
    clearMsgs();
    setRows((rs) =>
      rs.flatMap((r) => {
        if (r.key !== key) return [r];
        if (r.isNew) return []; // drop unsaved rows outright
        return [{ ...r, markedDelete: !r.markedDelete }];
      }),
    );
  };

  const defPriceN = parseMoney(defPrice);
  const defCostN = parseMoney(defCost);
  const margin =
    defPriceN != null && defCostN != null && defPriceN > 0
      ? ((defPriceN - defCostN) / defPriceN) * 100
      : null;
  const markup =
    defCostN != null && defCostN > 0 && defPriceN != null
      ? ((defPriceN - defCostN) / defCostN) * 100
      : null;

  const dirty = useMemo(() => {
    if (!data || !mForm) return false;
    const m0 = matrixForm(data.matrix);
    if ((Object.keys(mForm) as (keyof MatrixForm)[]).some((k) => mForm[k] !== m0[k])) return true;
    return rows.some((r) => {
      if (r.isNew || r.markedDelete) return true;
      if (!r.orig) return false;
      return (
        r.color !== r.orig.color ||
        r.size !== r.orig.size ||
        r.upc !== r.orig.upc ||
        r.retail_price !== r.orig.retail_price ||
        r.default_cost !== r.orig.default_cost ||
        r.sku !== r.orig.sku
      );
    });
  }, [data, mForm, rows]);

  const save = useCallback(async () => {
    if (!canManage || !data || !mForm || !dirty) return;
    if (mForm.description.trim() === "") {
      setErr("Description can't be empty.");
      return;
    }
    for (const r of rows) {
      if (!r.markedDelete && r.sku.trim() === "") {
        setErr("Every variant row needs a Custom SKU before saving.");
        return;
      }
    }

    setBusy("save");
    setErr(null);
    setOkMsg(null);

    const m0 = matrixForm(data.matrix);
    const matrixBody: Record<string, unknown> = {};
    if (mForm.description !== m0.description) matrixBody.description = mForm.description.trim();
    if (mForm.brand !== m0.brand) matrixBody.brand = mForm.brand.trim();
    if (mForm.category !== m0.category) matrixBody.category = mForm.category.trim();
    if (mForm.subcategory_1 !== m0.subcategory_1)
      matrixBody.subcategory_1 = mForm.subcategory_1.trim();
    if (mForm.upc !== m0.upc) matrixBody.upc = mForm.upc.trim();

    try {
      if (Object.keys(matrixBody).length > 0) {
        const res = await fetch(`/api/inventory/catalog/matrices/${matrixId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(matrixBody),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Matrix save failed");
      }

      for (const r of rows) {
        if (r.isNew) {
          const res = await fetch(`/api/inventory/catalog/matrices/${matrixId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sku: r.sku.trim(),
              color_code: r.color.trim(),
              size: r.size.trim(),
              upc: r.upc.trim(),
              retail_price: moneyOrNull(r.retail_price),
              default_cost: moneyOrNull(r.default_cost),
            }),
          });
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(j.error ?? `Create "${r.sku}" failed`);
          continue;
        }
        if (r.markedDelete) {
          if (!r.origArchived && r.id) {
            const res = await fetch(`/api/inventory/catalog/custom-skus/${r.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ archived: true }),
            });
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(j.error ?? "Archive failed");
          }
          continue;
        }
        // existing, changed
        if (!r.orig || !r.id) continue;
        const body: Record<string, unknown> = {};
        if (r.sku.trim() !== r.orig.sku) body.sku = r.sku.trim();
        if (r.color !== r.orig.color) body.color_code = r.color.trim();
        if (r.size !== r.orig.size) body.size = r.size.trim();
        if (r.upc !== r.orig.upc) body.upc = r.upc.trim();
        if (r.retail_price !== r.orig.retail_price)
          body.retail_price = moneyOrNull(r.retail_price);
        if (r.default_cost !== r.orig.default_cost)
          body.default_cost = moneyOrNull(r.default_cost);
        if (Object.keys(body).length === 0) continue;
        const res = await fetch(`/api/inventory/catalog/custom-skus/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Variant save failed");
      }

      await mutate();
      onMutated?.();
      setOkMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }, [canManage, data, mForm, rows, dirty, matrixId, mutate, onMutated]);

  const archiveAll = useCallback(async () => {
    if (!canManage || !data) return;
    const next = !data.matrix.archived;
    const word = next ? "Archive" : "Unarchive";
    if (!confirm(`${word} ALL ${data.variants.length} variant(s) in this matrix?`)) return;
    setBusy("archive");
    setErr(null);
    try {
      const res = await fetch(`/api/inventory/catalog/matrices/${matrixId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Archive failed");
      await mutate();
      onMutated?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setBusy(null);
    }
  }, [canManage, data, matrixId, mutate, onMutated]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/75"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-2 sm:p-4">
        <div className="my-4 w-full max-w-6xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl sm:my-8">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canManage || !dirty || busy !== null}
                onClick={() => void save()}
                title={canManage ? "Save matrix + variant edits" : "Admin scope required"}
                className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "save" ? "Saving…" : "Save Changes"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canManage || busy !== null || !data}
                onClick={() => void archiveAll()}
                className="rounded-md border border-red-500/55 bg-red-950/40 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-red-200 hover:bg-red-900/40 disabled:opacity-50"
                title={
                  canManage
                    ? data?.matrix.archived
                      ? "Unarchive every variant in this matrix"
                      : "Archive every variant in this matrix"
                    : "Admin scope required"
                }
              >
                {busy === "archive"
                  ? "Working…"
                  : data?.matrix.archived
                    ? "Unarchive matrix"
                    : "Archive matrix"}
              </button>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface)] hover:text-[var(--wms-fg)]"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {error ? (
            <p className="border-b border-red-500/30 bg-red-950/30 px-4 py-2 font-mono text-xs text-red-200">
              {(error as Error).message}
            </p>
          ) : null}
          {err ? (
            <p className="border-b border-red-500/30 bg-red-950/30 px-4 py-2 font-mono text-xs text-red-200">
              {err}
            </p>
          ) : null}
          {okMsg ? (
            <p className="border-b border-emerald-500/30 bg-emerald-950/30 px-4 py-2 font-mono text-xs text-emerald-200">
              {okMsg}
            </p>
          ) : null}

          {isLoading || !data || !mForm ? (
            <p className="p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              Loading matrix…
            </p>
          ) : (
            <div className="flex flex-col sm:flex-row">
              <nav className="flex shrink-0 overflow-x-auto border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 py-1 sm:block sm:w-32 sm:border-b-0 sm:border-r sm:py-3">
                <div className="whitespace-nowrap border-transparent px-4 py-1.5 font-mono text-xs text-[var(--wms-muted)] sm:border-l-2">
                  Setup
                </div>
                <div className="whitespace-nowrap border-[var(--wms-accent)] bg-[var(--wms-surface)] px-4 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)] sm:border-l-2">
                  Matrix
                </div>
              </nav>

              <div className="min-w-0 flex-1 space-y-4 p-3 sm:p-5">
                <MatrixGallery
                  urls={data.matrix.image_urls ?? []}
                  title={data.matrix.description}
                />

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr_0.6fr_0.6fr]">
                  {/* Shared Values */}
                  <Section title="Shared Values · applied to all items in this matrix">
                    <EditRow
                      label="Description"
                      value={mForm.description}
                      onChange={(v) => patchMatrix({ description: v })}
                      editable={canManage}
                    />
                    <EditRow
                      label="Category"
                      value={mForm.category}
                      onChange={(v) => patchMatrix({ category: v })}
                      editable={canManage}
                    />
                    <EditRow
                      label="Subcategory"
                      value={mForm.subcategory_1}
                      onChange={(v) => patchMatrix({ subcategory_1: v })}
                      editable={canManage}
                    />
                    <EditRow
                      label="Brand"
                      value={mForm.brand}
                      onChange={(v) => patchMatrix({ brand: v })}
                      editable={canManage}
                    />
                    <EditRow
                      label="UPC"
                      value={mForm.upc}
                      onChange={cascadeUpc}
                      editable={canManage}
                      mono
                      hint="Fills every variant's UPC"
                    />
                  </Section>

                  <div className="space-y-4">
                    <Section title="Matrix Type">
                      <Row label="Attributes" value="Color / Size" />
                    </Section>
                    <Section title="Default Values · fill every variant">
                      <div className="space-y-2 px-3 py-2 font-mono text-xs">
                        <div>
                          <span className="block text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                            Default Price
                          </span>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <MoneyInput value={defPrice} onChange={cascadePrice} editable={canManage} wide />
                            <span className="text-[0.6rem] text-[var(--wms-muted)]">
                              MU {fmtPct(markup)} · MG {fmtPct(margin)}
                            </span>
                          </div>
                        </div>
                        <div>
                          <span className="block text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                            Default Cost
                          </span>
                          <div className="mt-1">
                            <MoneyInput value={defCost} onChange={cascadeCost} editable={canManage} wide />
                          </div>
                        </div>
                      </div>
                    </Section>
                  </div>

                  {/* Color list + add */}
                  <Section title="Color">
                    {colors.length === 0 ? (
                      <p className="px-3 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">(none)</p>
                    ) : (
                      colors.map((c) => (
                        <div
                          key={c}
                          className="border-b border-[var(--wms-border)]/60 px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] last:border-b-0"
                        >
                          {c}
                        </div>
                      ))
                    )}
                    {canManage ? (
                      <AddInput
                        value={newColor}
                        onChange={setNewColor}
                        onAdd={addColor}
                        placeholder="New color…"
                      />
                    ) : null}
                  </Section>

                  {/* Size list + add */}
                  <Section title="Size">
                    {sizes.length === 0 ? (
                      <p className="px-3 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">(none)</p>
                    ) : (
                      sizes.map((s) => (
                        <div
                          key={s}
                          className="border-b border-[var(--wms-border)]/60 px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] last:border-b-0"
                        >
                          {s}
                        </div>
                      ))
                    )}
                    {canManage ? (
                      <AddInput
                        value={newSize}
                        onChange={setNewSize}
                        onAdd={addSize}
                        placeholder="New size…"
                      />
                    ) : null}
                  </Section>
                </div>

                {/* Group Items */}
                <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
                  <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    Group Items
                  </div>
                  <div className="overflow-x-auto">
                    <div className="min-w-[760px]">
                      <div className="grid grid-cols-[64px_150px_70px_100px_100px_150px_160px] gap-2 border-b border-[var(--wms-border)]/60 px-3 py-1.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
                        <span />
                        <span>Color</span>
                        <span>Size</span>
                        <span>Price</span>
                        <span>Cost</span>
                        <span>UPC</span>
                        <span>Custom SKU</span>
                      </div>
                      {rows.map((r) => (
                        <div
                          key={r.key}
                          className={`grid grid-cols-[64px_150px_70px_100px_100px_150px_160px] items-center gap-2 border-b border-[var(--wms-border)]/40 px-3 py-1.5 font-mono text-xs last:border-b-0 ${
                            r.markedDelete ? "opacity-40" : ""
                          } ${r.isNew ? "bg-[var(--wms-accent)]/5" : ""}`}
                        >
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={!canManage}
                              onClick={() => deleteRow(r.key)}
                              title={
                                r.isNew
                                  ? "Remove this new row"
                                  : r.markedDelete
                                    ? "Undo delete"
                                    : r.hasStock
                                      ? "Archive row (has live stock — history kept)"
                                      : "Delete (archive) row"
                              }
                              className={`flex h-6 w-6 items-center justify-center rounded border text-[var(--wms-muted)] disabled:opacity-40 ${
                                r.markedDelete
                                  ? "border-[var(--wms-border)] hover:bg-[var(--wms-surface)]"
                                  : "border-red-500/40 hover:bg-red-950/40 hover:text-red-200"
                              }`}
                            >
                              {r.markedDelete ? (
                                <RotateCcw className="h-3.5 w-3.5" />
                              ) : (
                                <XIcon className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={!canManage || r.isNew || r.markedDelete || !r.id || printingId !== null}
                              onClick={() => r.id && void printRow(r.id)}
                              title={
                                r.isNew
                                  ? "Save the row first, then you can print its tag"
                                  : "Print one RFID tag for this variant to 192.168.1.3 (status: unknown)"
                              }
                              className="flex h-6 w-6 items-center justify-center rounded border border-[var(--wms-border)] text-[var(--wms-muted)] hover:bg-[var(--wms-surface)] hover:text-[var(--wms-fg)] disabled:opacity-40"
                            >
                              {printingId === r.id ? (
                                <span className="text-[0.6rem]">…</span>
                              ) : (
                                <Printer className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                          <Cell value={r.color} onChange={(x) => patchRow(r.key, { color: x })} editable={canManage} />
                          <Cell value={r.size} onChange={(x) => patchRow(r.key, { size: x })} editable={canManage} />
                          <Cell value={r.retail_price} onChange={(x) => patchRow(r.key, { retail_price: x })} editable={canManage} numeric />
                          <Cell value={r.default_cost} onChange={(x) => patchRow(r.key, { default_cost: x })} editable={canManage} money />
                          <Cell value={r.upc} onChange={(x) => patchRow(r.key, { upc: x })} editable={canManage} />
                          <Cell value={r.sku} onChange={(x) => patchRow(r.key, { sku: x })} editable={canManage} placeholder={r.isNew ? "SKU…" : undefined} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AddInput({
  value,
  onChange,
  onAdd,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        className="min-w-0 flex-1 rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1 text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none"
      />
      <button
        type="button"
        onClick={onAdd}
        title="Add"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Cell({
  value,
  onChange,
  editable,
  numeric,
  money,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  numeric?: boolean;
  money?: boolean;
  placeholder?: string;
}) {
  if (!editable) {
    return (
      <span className="truncate" title={value}>
        {value.trim() || "—"}
      </span>
    );
  }
  return (
    <input
      type="text"
      inputMode={numeric || money ? "decimal" : undefined}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={money ? () => onChange(money2(value)) : undefined}
      className="w-full min-w-0 rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-1.5 py-1 text-left text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none"
    />
  );
}

function MoneyInput({
  value,
  onChange,
  editable,
  wide,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  wide?: boolean;
}) {
  if (!editable) {
    return (
      <span className="text-left font-mono text-xs text-[var(--wms-fg)]">
        {value.trim() === "" ? "—" : `$${money2(value)}`}
      </span>
    );
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onChange(money2(value))}
      className={`${wide ? "w-28" : "w-full"} rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1 text-left font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none`}
    />
  );
}

/**
 * Full Shopify product gallery for the matrix window — every product image
 * Shopify has, in Shopify order. Links are Shopify CDN URLs (never re-hosted).
 * Renders nothing-but-a-hint when the matrix has no synced imagery yet.
 */
function MatrixGallery({ urls, title }: { urls: string[]; title: string }) {
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  if (!urls || urls.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-4 text-center font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
        No Shopify pictures synced for this matrix
      </div>
    );
  }
  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
      <div className="flex items-center justify-between border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5">
        <span className="font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Pictures · from Shopify
        </span>
        <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">{urls.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-5 lg:grid-cols-6">
        {urls.map((u, i) => (
          <button
            key={u}
            type="button"
            onClick={() => setZoomUrl(u)}
            className="block cursor-zoom-in overflow-hidden rounded border border-[var(--wms-border)] bg-white"
            title={`${title} — image ${i + 1} (click to enlarge)`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={u}
              alt={`${title} ${i + 1}`}
              className="aspect-square w-full object-contain"
              loading="lazy"
            />
          </button>
        ))}
      </div>
      {zoomUrl ? (
        <CatalogImageLightbox url={zoomUrl} alt={title} onClose={() => setZoomUrl(null)} />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
      <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {title}
      </div>
      <div className="divide-y divide-[var(--wms-border)]/60">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </span>
      <span className={`${mono ? "font-mono" : ""} text-xs text-[var(--wms-fg)]`}>{value}</span>
    </div>
  );
}

function EditRow({
  label,
  value,
  onChange,
  editable,
  mono,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  mono?: boolean;
  hint?: string;
}) {
  if (!editable) {
    return <Row label={label} value={value.trim() || "—"} mono={mono} />;
  }
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span
        className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]"
        title={hint}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-32 rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1 text-left text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none sm:w-44 ${
          mono ? "font-mono" : ""
        }`}
      />
    </div>
  );
}
