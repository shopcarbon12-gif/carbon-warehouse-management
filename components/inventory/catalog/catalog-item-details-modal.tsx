"use client";

import { useCallback, useMemo, useState } from "react";
import { X as XIcon } from "lucide-react";
import type { CatalogGridRow } from "@/lib/server/inventory-catalog";
import { CatalogMatrixModal } from "./catalog-matrix-modal";
import { CatalogImageLightbox } from "./catalog-image-lightbox";
import { ItemSalesTab, ItemCustomersTab, ItemHistoryTab } from "./item-report-tabs";
import { printRfidLabel } from "./print-label";

/**
 * Lightspeed-style item-details popup. Opens when the operator clicks
 * the Item name or Custom SKU cell in /inventory/catalog.
 *
 * Fully editable: Lightspeed is being retired and the WMS is the source of
 * truth, so the operator edits catalog attributes here. Variant fields
 * (sku, color, size, upc, price, cost) save to custom_skus; matrix fields
 * (name/description, brand, category, subcategory) save to the parent matrix
 * and therefore apply to every variant under it. Save is admin-only.
 *
 * Sales History / Reserved remain placeholders — the WMS doesn't track sales
 * or reservations yet.
 */

type Props = {
  row: CatalogGridRow;
  canManage: boolean;
  onClose: () => void;
  /** Called after any mutation that should refresh the catalog grid. */
  onMutated?: () => void;
};

type LeftTab = "details" | "inventory" | "sales" | "customers" | "history";

const NAV_ITEMS: { key: LeftTab; label: string }[] = [
  { key: "details", label: "Details" },
  { key: "sales", label: "Sales" },
  { key: "customers", label: "Customers" },
  { key: "history", label: "History" },
];

function parseMoney(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
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
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function fmtPct(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

/** Editable form mirror of the row. Money kept as strings for free typing. */
type Form = {
  name: string;
  brand: string;
  category: string;
  subcategory_1: string;
  color: string;
  size: string;
  sku: string;
  upc: string;
  retail_price: string;
  default_cost: string;
};

function formFromRow(row: CatalogGridRow): Form {
  return {
    name: row.name ?? "",
    brand: row.brand ?? "",
    category: row.category ?? "",
    subcategory_1: row.subcategory_1 ?? "",
    color: row.color ?? "",
    size: row.size ?? "",
    sku: row.sku ?? "",
    upc: row.sku_upc ?? "",
    retail_price: row.retail_price ?? "",
    default_cost: money2(row.default_cost),
  };
}

export function CatalogItemDetailsModal({ row, canManage, onClose, onMutated }: Props) {
  const [tab, setTab] = useState<LeftTab>("details");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);

  const [form, setForm] = useState<Form>(() => formFromRow(row));
  const [initial, setInitial] = useState<Form>(() => formFromRow(row));

  const patch = useCallback(
    (p: Partial<Form>) => {
      setOkMsg(null);
      setForm((f) => ({ ...f, ...p }));
    },
    [],
  );

  const dirty = useMemo(
    () => (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== initial[k]),
    [form, initial],
  );

  // Derived pricing recomputes live from the edited price/cost fields.
  const cost = parseMoney(form.default_cost);
  const price = parseMoney(form.retail_price);
  const available = row.active_epc_count ?? 0;
  const onlinePrice = price;
  const totalValue = cost != null ? cost * available : null;
  const totalSaleValue = price != null ? price * available : null;
  const margin =
    price != null && cost != null && price > 0 ? ((price - cost) / price) * 100 : null;
  const markup =
    cost != null && cost > 0 && price != null ? ((price - cost) / cost) * 100 : null;

  const save = useCallback(async () => {
    if (!canManage || !dirty) return;

    // Validate money fields up front so we don't half-apply.
    for (const [field, label] of [
      ["retail_price", "Price"],
      ["default_cost", "Cost"],
    ] as const) {
      const v = form[field].trim();
      if (v !== "" && !Number.isFinite(Number.parseFloat(v))) {
        setErr(`${label} must be a number (or blank).`);
        return;
      }
    }
    if (form.name.trim() === "") {
      setErr("Name can't be empty.");
      return;
    }

    setBusy("save");
    setErr(null);
    setOkMsg(null);

    const moneyOrNull = (s: string): number | null => {
      const t = s.trim();
      if (t === "") return null;
      const n = Number.parseFloat(t);
      return Number.isFinite(n) ? n : null;
    };

    // Variant-level diff → custom_skus
    const variantBody: Record<string, unknown> = {};
    if (form.sku.trim() !== initial.sku) variantBody.sku = form.sku.trim();
    if (form.color !== initial.color) variantBody.color_code = form.color.trim();
    if (form.size !== initial.size) variantBody.size = form.size.trim();
    if (form.upc !== initial.upc) variantBody.upc = form.upc.trim();
    if (form.retail_price !== initial.retail_price)
      variantBody.retail_price = moneyOrNull(form.retail_price);
    if (form.default_cost !== initial.default_cost)
      variantBody.default_cost = moneyOrNull(form.default_cost);

    // Matrix-level diff → matrices (applies to every variant under the matrix)
    const matrixBody: Record<string, unknown> = {};
    if (form.name !== initial.name) matrixBody.description = form.name.trim();
    if (form.brand !== initial.brand) matrixBody.brand = form.brand.trim();
    if (form.category !== initial.category) matrixBody.category = form.category.trim();
    if (form.subcategory_1 !== initial.subcategory_1)
      matrixBody.subcategory_1 = form.subcategory_1.trim();

    try {
      if (Object.keys(variantBody).length > 0) {
        const res = await fetch(
          `/api/inventory/catalog/custom-skus/${row.custom_sku_id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(variantBody),
          },
        );
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Variant save failed");
      }
      if (Object.keys(matrixBody).length > 0) {
        const res = await fetch(`/api/inventory/catalog/matrices/${row.matrix_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(matrixBody),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Matrix save failed");
      }
      setInitial(form);
      setOkMsg("Saved.");
      onMutated?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }, [canManage, dirty, form, initial, row, onMutated]);

  const onPrintLabel = useCallback(async () => {
    if (!canManage) return;
    setBusy("print");
    setErr(null);
    setOkMsg(null);
    const r = await printRfidLabel(row.custom_sku_id);
    if (r.ok) setOkMsg(r.message);
    else setErr(r.message);
    onMutated?.();
    setBusy(null);
  }, [canManage, row.custom_sku_id, onMutated]);

  const archive = useCallback(async () => {
    if (!canManage) return;
    if (
      !confirm(
        `Archive this variant (${row.sku})? Catalog rows hide archived items by default; you can unarchive by re-running this with the Show Archived filter on.`,
      )
    )
      return;
    setBusy("archive");
    setErr(null);
    try {
      const res = await fetch(
        `/api/inventory/catalog/custom-skus/${row.custom_sku_id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: !row.archived }),
        },
      );
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Archive failed");
      onMutated?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setBusy(null);
    }
  }, [canManage, row, onMutated, onClose]);

  const headerLabel = useMemo(() => {
    const bits = [form.name || row.name];
    const vc = [form.color, form.size].filter((v) => v?.trim());
    if (vc.length > 0) bits.push(`· ${vc.join(" / ")}`);
    return bits.join(" ");
  }, [form, row]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-2 sm:p-4">
        <div className="my-4 w-full max-w-6xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl sm:my-8">
          {/* Top bar — Save Changes · Matrix · Print Label · Archive */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canManage || !dirty || busy !== null}
                onClick={() => void save()}
                title={
                  canManage
                    ? "Save catalog edits (variant + matrix)"
                    : "Admin scope required"
                }
                className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "save" ? "Saving…" : "Save Changes"}
              </button>
              <button
                type="button"
                onClick={() => setMatrixOpen(true)}
                className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
              >
                Matrix
              </button>
              <button
                type="button"
                disabled={!canManage || busy !== null}
                onClick={() => void onPrintLabel()}
                title={
                  canManage
                    ? "Print one RFID tag for this SKU to 192.168.1.3 (status: unknown)"
                    : "Admin scope required"
                }
                className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "print" ? "Printing…" : "Print Label"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canManage || busy !== null}
                onClick={() => void archive()}
                className="rounded-md border border-red-500/55 bg-red-950/40 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-red-200 hover:bg-red-900/40 disabled:opacity-50"
                title={
                  canManage
                    ? row.archived
                      ? "Unarchive this variant"
                      : "Archive this variant"
                    : "Admin scope required"
                }
              >
                {busy === "archive" ? "Working…" : row.archived ? "Unarchive" : "Archive"}
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

          <div className="flex flex-col sm:flex-row">
            <nav className="flex shrink-0 overflow-x-auto border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 py-1 sm:block sm:w-44 sm:border-b-0 sm:border-r sm:py-3">
              {NAV_ITEMS.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  onClick={() => setTab(n.key)}
                  className={`block whitespace-nowrap px-4 py-1.5 text-left font-mono text-xs sm:w-full ${
                    tab === n.key
                      ? "border-[var(--wms-accent)] bg-[var(--wms-surface)] font-semibold text-[var(--wms-fg)] sm:border-l-2"
                      : "border-transparent text-[var(--wms-muted)] hover:bg-[var(--wms-surface)] hover:text-[var(--wms-fg)] sm:border-l-2"
                  }`}
                >
                  {n.label}
                </button>
              ))}
            </nav>

            <div className="min-w-0 flex-1 p-3 sm:p-5">
              <h2
                className="mb-4 truncate text-base font-semibold text-[var(--wms-fg)]"
                title={headerLabel}
              >
                {headerLabel}
                {row.archived ? (
                  <span className="ml-2 rounded border border-amber-500/40 bg-amber-950/40 px-2 py-0.5 align-middle font-mono text-[0.55rem] uppercase tracking-wide text-amber-200">
                    archived
                  </span>
                ) : null}
              </h2>

              {tab === "details" ? (
                <DetailsTab
                  row={row}
                  form={form}
                  patch={patch}
                  editable={canManage}
                  cost={cost}
                  onlinePrice={onlinePrice}
                  margin={margin}
                  markup={markup}
                  available={available}
                  totalValue={totalValue}
                  totalSaleValue={totalSaleValue}
                />
              ) : tab === "sales" ? (
                <ItemSalesTab customSkuId={row.custom_sku_id} />
              ) : tab === "customers" ? (
                <ItemCustomersTab customSkuId={row.custom_sku_id} />
              ) : tab === "history" ? (
                <ItemHistoryTab customSkuId={row.custom_sku_id} />
              ) : (
                <PlaceholderTab label={NAV_ITEMS.find((n) => n.key === tab)?.label ?? ""} />
              )}
            </div>
          </div>
        </div>
      </div>

      {matrixOpen ? (
        <CatalogMatrixModal
          matrixId={row.matrix_id}
          canManage={canManage}
          onClose={() => setMatrixOpen(false)}
          onMutated={onMutated}
        />
      ) : null}
    </>
  );
}

function DetailsTab({
  row,
  form,
  patch,
  editable,
  cost,
  onlinePrice,
  margin,
  markup,
  available,
  totalValue,
  totalSaleValue,
}: {
  row: CatalogGridRow;
  form: Form;
  patch: (p: Partial<Form>) => void;
  editable: boolean;
  cost: number | null;
  onlinePrice: number | null;
  margin: number | null;
  markup: number | null;
  available: number;
  totalValue: number | null;
  totalSaleValue: number | null;
}) {
  const avgCost = cost;
  const reserved = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr_1fr]">
      {/* Column 1 — Picture, Name, Color/Size, IDs, Organize, eCommerce */}
      <div className="space-y-3">
        <ItemImage url={row.shopify_image_url} alt={`${form.name} ${form.color}`.trim()} />

        <Section title="Item">
          <EditRow
            label="Name"
            value={form.name}
            onChange={(v) => patch({ name: v })}
            editable={editable}
            hint="Matrix name — applies to all variants"
          />
        </Section>

        <Section title="Color / Size">
          <EditRow
            label="Color"
            value={form.color}
            onChange={(v) => patch({ color: v })}
            editable={editable}
          />
          <EditRow
            label="Size"
            value={form.size}
            onChange={(v) => patch({ size: v })}
            editable={editable}
          />
        </Section>

        <Section title="IDs">
          <Row label="System ID" value={row.sku_ls_system_id ?? "—"} mono />
          <EditRow
            label="UPC"
            value={form.upc}
            onChange={(v) => patch({ upc: v })}
            editable={editable}
            mono
          />
          <EditRow
            label="Custom SKU"
            value={form.sku}
            onChange={(v) => patch({ sku: v })}
            editable={editable}
            mono
          />
        </Section>

        <Section title="Organize">
          <EditRow
            label="Category"
            value={form.category}
            onChange={(v) => patch({ category: v })}
            editable={editable}
            hint="Matrix-level"
          />
          <EditRow
            label="Subcategory"
            value={form.subcategory_1}
            onChange={(v) => patch({ subcategory_1: v })}
            editable={editable}
            hint="Matrix-level"
          />
          <EditRow
            label="Brand"
            value={form.brand}
            onChange={(v) => patch({ brand: v })}
            editable={editable}
            hint="Matrix-level"
          />
        </Section>

        <Section title="eCommerce">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-fg)]">
              <input
                type="checkbox"
                disabled
                className="h-3.5 w-3.5 accent-[var(--wms-accent)] disabled:opacity-60"
              />
              Publish to Shopify
            </label>
          </div>
        </Section>
      </div>

      {/* Column 2 — Pricing + Inventory Defaults */}
      <div className="space-y-3">
        <Section title="Pricing">
          <PriceHeader />
          <EditPriceRow
            label="Default"
            value={form.retail_price}
            onChange={(v) => patch({ retail_price: v })}
            editable={editable}
            markup={markup}
            margin={margin}
          />
          <PriceRow label="Online" amount={onlinePrice} markup={markup} margin={margin} />
        </Section>

        <Section title="Inventory Defaults">
          <EditRow
            label="Default Cost"
            value={form.default_cost}
            onChange={(v) => patch({ default_cost: v })}
            editable={editable}
            mono
            money
          />
        </Section>
      </div>

      {/* Column 3 — Stock + Sales History (derived / read-only) */}
      <div className="space-y-3">
        <Section title="Stock">
          <Row label="Available" value={String(available)} mono />
          <Row label="Reserved" value={String(reserved)} mono />
          <Row label="Avg Cost" value={fmtMoney(avgCost)} mono />
          <Row label="Total Value" value={fmtMoney(totalValue)} mono />
          <Row label="Total Sale Value" value={fmtMoney(totalSaleValue)} mono />
          <Row label="Margin" value={fmtPct(margin, 0)} mono />
        </Section>

        <Section title="Sales History">
          <Row label="Day" value="0" mono dim />
          <Row label="Week" value="0" mono dim />
          <Row label="Month" value="0" mono dim />
          <Row label="Year" value="0" mono dim />
          <Row label="All" value="0" mono dim />
        </Section>
      </div>
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-[var(--wms-border)] p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
      {label} view — coming soon. Sales / Customers / Inventory / History data
      isn&apos;t wired into the WMS yet; this is the same Details data for now.
    </p>
  );
}

/**
 * Single product picture for the item popup — the variant's color-specific
 * Shopify image (one per color). Renders a dashed placeholder when the SKU
 * has no synced image yet. Image links are Shopify CDN URLs (never re-hosted).
 */
function ItemImage({ url, alt }: { url: string | null; alt: string }) {
  const [zoom, setZoom] = useState(false);
  if (!url) {
    return (
      <div className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-dashed border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
        No picture
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className="block w-full cursor-zoom-in overflow-hidden rounded-md border border-[var(--wms-border)] bg-white"
        title="Click to enlarge"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt || "Product image"}
          className="aspect-[3/4] w-full object-cover"
          loading="lazy"
        />
      </button>
      {zoom ? (
        <CatalogImageLightbox images={[url]} alt={alt} onClose={() => setZoom(false)} />
      ) : null}
    </>
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

function Row({
  label,
  value,
  mono,
  dim,
}: {
  label: string;
  value: string;
  mono?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </span>
      <span
        className={`${mono ? "font-mono" : ""} text-xs ${
          dim ? "text-[var(--wms-muted)]" : "text-[var(--wms-fg)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function EditRow({
  label,
  value,
  onChange,
  editable,
  mono,
  numeric,
  money,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  mono?: boolean;
  numeric?: boolean;
  money?: boolean;
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
        inputMode={numeric || money ? "decimal" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={money ? () => onChange(money2(value)) : undefined}
        className={`w-32 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-left text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none sm:w-40 ${
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

function EditPriceRow({
  label,
  value,
  onChange,
  editable,
  markup,
  margin,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  markup: number | null;
  margin: number | null;
}) {
  if (!editable) {
    return <PriceRow label={label} amount={parseMoney(value)} markup={markup} margin={margin} />;
  }
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_1fr] items-center gap-3 px-3 py-1.5 font-mono text-xs">
      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-left text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none"
      />
      <span className="text-left text-[var(--wms-muted)]">{fmtPct(markup)}</span>
      <span className="text-left text-[var(--wms-muted)]">{fmtPct(margin)}</span>
    </div>
  );
}
