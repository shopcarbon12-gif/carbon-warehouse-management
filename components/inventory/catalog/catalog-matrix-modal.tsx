"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { X as XIcon } from "lucide-react";

/**
 * Lightspeed-style matrix popup. Opens from CatalogItemDetailsModal's "Matrix"
 * button. Shows shared (matrix-level) values, derived default pricing, color +
 * size lists, and a Group Items row per variant.
 *
 * Fully editable — Lightspeed is being retired and the WMS is the source of
 * truth. Shared Values save to the matrices row (apply to all variants);
 * Group Items save per-variant to custom_skus. Save is admin-only.
 *   - Archive : flips archived on EVERY custom_sku under this matrix.
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

type MatrixDetailResp = {
  matrix: Matrix;
  variants: Variant[];
};

type Props = {
  matrixId: string;
  canManage: boolean;
  onClose: () => void;
  onMutated?: () => void;
};

/** Editable mirrors (strings for free typing). */
type MatrixForm = {
  description: string;
  brand: string;
  category: string;
  subcategory_1: string;
  upc: string;
};
type VariantForm = {
  color: string;
  size: string;
  upc: string;
  retail_price: string;
  default_cost: string;
  sku: string;
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
/** Normalize a money string to fixed 2-decimal form (blank stays blank). */
function money2(s: string | null): string {
  const t = (s ?? "").trim();
  if (t === "") return "";
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n.toFixed(2) : (s ?? "");
}
function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);
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
function variantForm(v: Variant): VariantForm {
  return {
    color: v.color ?? "",
    size: v.size ?? "",
    upc: v.upc ?? "",
    retail_price: v.retail_price ?? "",
    default_cost: money2(v.default_cost),
    sku: v.sku ?? "",
  };
}

export function CatalogMatrixModal({ matrixId, canManage, onClose, onMutated }: Props) {
  const { data, error, mutate, isLoading } = useSWR<MatrixDetailResp>(
    `/api/inventory/catalog/matrices/${matrixId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Editable local state — seeded from the fetched data and re-seeded after
  // a successful save (mutate() changes `data`, which this effect observes).
  const [mForm, setMForm] = useState<MatrixForm | null>(null);
  const [vForms, setVForms] = useState<Record<string, VariantForm>>({});

  useEffect(() => {
    if (!data) return;
    setMForm(matrixForm(data.matrix));
    setVForms(Object.fromEntries(data.variants.map((v) => [v.id, variantForm(v)])));
  }, [data]);

  const patchMatrix = (p: Partial<MatrixForm>) => {
    setOkMsg(null);
    setMForm((f) => (f ? { ...f, ...p } : f));
  };
  const patchVariant = (id: string, p: Partial<VariantForm>) => {
    setOkMsg(null);
    setVForms((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  };

  const dirty = useMemo(() => {
    if (!data || !mForm) return false;
    const m0 = matrixForm(data.matrix);
    if ((Object.keys(mForm) as (keyof MatrixForm)[]).some((k) => mForm[k] !== m0[k])) {
      return true;
    }
    return data.variants.some((v) => {
      const f = vForms[v.id];
      if (!f) return false;
      const v0 = variantForm(v);
      return (Object.keys(f) as (keyof VariantForm)[]).some((k) => f[k] !== v0[k]);
    });
  }, [data, mForm, vForms]);

  /* Default Values surface the most representative price + cost across all
     variants (LS-style) — MIN of the live edited variant prices/costs. */
  const defaults = useMemo(() => {
    let price: number | null = null;
    let cost: number | null = null;
    for (const f of Object.values(vForms)) {
      const p = parseMoney(f.retail_price);
      const c = parseMoney(f.default_cost);
      if (p != null) price = price == null ? p : Math.min(price, p);
      if (c != null) cost = cost == null ? c : Math.min(cost, c);
    }
    return { price, cost };
  }, [vForms]);

  const onlinePrice = defaults.price;
  const margin =
    defaults.price != null && defaults.cost != null && defaults.price > 0
      ? ((defaults.price - defaults.cost) / defaults.price) * 100
      : null;
  const markup =
    defaults.cost != null && defaults.cost > 0 && defaults.price != null
      ? ((defaults.price - defaults.cost) / defaults.cost) * 100
      : null;

  const colors = useMemo(() => {
    const seen = new Set<string>();
    for (const f of Object.values(vForms)) {
      const c = f.color?.trim();
      if (c) seen.add(c);
    }
    return [...seen];
  }, [vForms]);
  const sizes = useMemo(() => {
    const seen = new Set<string>();
    for (const f of Object.values(vForms)) {
      const s = f.size?.trim();
      if (s) seen.add(s);
    }
    return [...seen];
  }, [vForms]);

  const save = useCallback(async () => {
    if (!canManage || !data || !mForm || !dirty) return;
    if (mForm.description.trim() === "") {
      setErr("Description can't be empty.");
      return;
    }
    setBusy("save");
    setErr(null);
    setOkMsg(null);

    // Matrix-header diff
    const m0 = matrixForm(data.matrix);
    const matrixBody: Record<string, unknown> = {};
    if (mForm.description !== m0.description) matrixBody.description = mForm.description.trim();
    if (mForm.brand !== m0.brand) matrixBody.brand = mForm.brand.trim();
    if (mForm.category !== m0.category) matrixBody.category = mForm.category.trim();
    if (mForm.subcategory_1 !== m0.subcategory_1)
      matrixBody.subcategory_1 = mForm.subcategory_1.trim();
    if (mForm.upc !== m0.upc) matrixBody.upc = mForm.upc.trim();

    // Per-variant diffs
    const variantPatches: { id: string; body: Record<string, unknown> }[] = [];
    for (const v of data.variants) {
      const f = vForms[v.id];
      if (!f) continue;
      const v0 = variantForm(v);
      const body: Record<string, unknown> = {};
      if (f.sku.trim() !== v0.sku) body.sku = f.sku.trim();
      if (f.color !== v0.color) body.color_code = f.color.trim();
      if (f.size !== v0.size) body.size = f.size.trim();
      if (f.upc !== v0.upc) body.upc = f.upc.trim();
      if (f.retail_price !== v0.retail_price) body.retail_price = moneyOrNull(f.retail_price);
      if (f.default_cost !== v0.default_cost) body.default_cost = moneyOrNull(f.default_cost);
      if (Object.keys(body).length > 0) variantPatches.push({ id: v.id, body });
    }

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
      for (const vp of variantPatches) {
        const res = await fetch(`/api/inventory/catalog/custom-skus/${vp.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vp.body),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? `Variant ${vp.id.slice(0, 8)} save failed`);
      }
      await mutate();
      onMutated?.();
      setOkMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }, [canManage, data, mForm, vForms, dirty, matrixId, mutate, onMutated]);

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
          {/* Top bar */}
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
                disabled
                className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-50"
                title="Duplicate not wired yet"
              >
                Duplicate
              </button>
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
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr_0.5fr_0.5fr]">
                  {/* Shared Values — matrix-level, editable */}
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
                      onChange={(v) => patchMatrix({ upc: v })}
                      editable={canManage}
                      mono
                    />
                  </Section>

                  <div className="space-y-4">
                    <Section title="Matrix Type">
                      <Row label="Attributes" value="Color / Size" />
                    </Section>
                    <Section title="Default Values · derived from variants">
                      <PriceHeader />
                      <PriceRow label="Default" amount={defaults.price} markup={markup} margin={margin} />
                      <PriceRow label="Online" amount={onlinePrice} markup={markup} margin={margin} />
                      <Row label="Default Cost" value={fmtMoney(defaults.cost)} mono />
                    </Section>
                  </div>

                  <Section title="Color">
                    {colors.length === 0 ? (
                      <p className="px-3 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                        (none)
                      </p>
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
                  </Section>

                  <Section title="Size">
                    {sizes.length === 0 ? (
                      <p className="px-3 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                        (none)
                      </p>
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
                  </Section>
                </div>

                {/* Group Items — per-variant, editable */}
                <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
                  <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    Group Items
                  </div>
                  <div className="overflow-x-auto">
                  <div className="min-w-[740px]">
                  <div className="grid grid-cols-[150px_70px_100px_100px_150px_160px] gap-2 border-b border-[var(--wms-border)]/60 px-3 py-1.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    <span>Color</span>
                    <span>Size</span>
                    <span className="text-left">Price</span>
                    <span className="text-left">Cost</span>
                    <span>UPC</span>
                    <span>Custom SKU</span>
                  </div>
                  {data.variants.map((v) => {
                    const f = vForms[v.id] ?? variantForm(v);
                    return (
                      <div
                        key={v.id}
                        className="grid grid-cols-[150px_70px_100px_100px_150px_160px] items-center gap-2 border-b border-[var(--wms-border)]/40 px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] last:border-b-0"
                      >
                        <Cell value={f.color} onChange={(x) => patchVariant(v.id, { color: x })} editable={canManage} />
                        <Cell value={f.size} onChange={(x) => patchVariant(v.id, { size: x })} editable={canManage} />
                        <Cell value={f.retail_price} onChange={(x) => patchVariant(v.id, { retail_price: x })} editable={canManage} numeric align="right" />
                        <Cell value={f.default_cost} onChange={(x) => patchVariant(v.id, { default_cost: x })} editable={canManage} money align="right" />
                        <Cell value={f.upc} onChange={(x) => patchVariant(v.id, { upc: x })} editable={canManage} />
                        <div className="flex items-center gap-2">
                          <Cell value={f.sku} onChange={(x) => patchVariant(v.id, { sku: x })} editable={canManage} grow />
                          {v.archived ? (
                            <span className="shrink-0 rounded border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 text-[0.5rem] uppercase tracking-wide text-amber-200">
                              archived
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
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

function Cell({
  value,
  onChange,
  editable,
  numeric,
  money,
  align,
  grow,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  numeric?: boolean;
  money?: boolean;
  align?: "right";
  grow?: boolean;
}) {
  if (!editable) {
    return (
      <span
        className={`truncate ${align === "right" ? "text-left tabular-nums" : ""} ${grow ? "min-w-0 flex-1" : ""}`}
        title={value}
      >
        {value.trim() || "—"}
      </span>
    );
  }
  return (
    <input
      type="text"
      inputMode={numeric || money ? "decimal" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={money ? () => onChange(money2(value)) : undefined}
      className={`w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-1.5 py-1 text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none ${
        align === "right" ? "text-left tabular-nums" : ""
      } ${grow ? "min-w-0 flex-1" : ""}`}
    />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  mono?: boolean;
}) {
  if (!editable) {
    return <Row label={label} value={value.trim() || "—"} mono={mono} />;
  }
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
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

function PriceHeader() {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_1fr] items-center gap-3 bg-[var(--wms-surface-elevated)]/60 px-3 py-1 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
      <span>Name</span>
      <span className="text-left">Price</span>
      <span className="text-left">Markup</span>
      <span className="text-left">Margin</span>
    </div>
  );
}

function PriceRow({
  label,
  amount,
  markup,
  margin,
}: {
  label: string;
  amount: number | null;
  markup: number | null;
  margin: number | null;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_1fr] items-center gap-3 px-3 py-1.5 font-mono text-xs">
      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </span>
      <span className="text-left text-[var(--wms-fg)]">{fmtMoney(amount)}</span>
      <span className="text-left text-[var(--wms-muted)]">{fmtPct(markup)}</span>
      <span className="text-left text-[var(--wms-muted)]">{fmtPct(margin)}</span>
    </div>
  );
}
