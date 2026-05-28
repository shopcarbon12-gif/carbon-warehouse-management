"use client";

import { useCallback, useMemo, useState } from "react";
import { X as XIcon } from "lucide-react";
import type { CatalogGridRow } from "@/lib/server/inventory-catalog";
import { CatalogMatrixModal } from "./catalog-matrix-modal";

/**
 * Lightspeed-style item-details popup. Opens when the operator clicks
 * the Item name or Custom SKU cell in /inventory/catalog.
 *
 * Visual structure tracks the Lightspeed item-edit screen so the popup
 * feels familiar, but with WMS-relevant sections only. Top bar exposes
 * Matrix / Print Label / Archive actions. Print Label is intentionally
 * disabled for now — variant-level (non-EPC) printing isn't wired yet;
 * the per-EPC reprint at /api/rfid/reprint is the closest existing path.
 *
 * All values are sourced from the CatalogGridRow already in the table
 * — no extra fetch on open. Sales History / Reserved are placeholders
 * because the WMS doesn't yet track sales or reservations.
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
  { key: "inventory", label: "Inventory" },
  { key: "sales", label: "Sales" },
  { key: "customers", label: "Customers" },
  { key: "history", label: "History" },
];

function parseMoney(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
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

export function CatalogItemDetailsModal({ row, canManage, onClose, onMutated }: Props) {
  const [tab, setTab] = useState<LeftTab>("details");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);

  const cost = parseMoney(row.default_cost);
  const price = parseMoney(row.retail_price);
  const available = row.active_epc_count ?? 0;
  /* Online price isn't tracked separately in our schema — Lightspeed
     R-Series carries it in default_price; we mirror retail. When the
     two diverge in a future sync we'll surface them separately. */
  const onlinePrice = price;
  const totalValue = cost != null ? cost * available : null;
  const totalSaleValue = price != null ? price * available : null;
  const margin =
    price != null && cost != null && price > 0
      ? ((price - cost) / price) * 100
      : null;
  const markup =
    cost != null && cost > 0 && price != null
      ? ((price - cost) / cost) * 100
      : null;

  const upcDisplay = row.sku_upc?.trim() || row.matrix_upc?.trim() || "—";

  const archive = useCallback(async () => {
    if (!canManage) return;
    if (!confirm(`Archive this variant (${row.sku})? Catalog rows hide archived items by default; you can unarchive by re-running this with the Show Archived filter on.`)) return;
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
    const bits = [row.name];
    const vc = [row.color, row.size].filter((v) => v?.trim());
    if (vc.length > 0) bits.push(`· ${vc.join(" / ")}`);
    return bits.join(" ");
  }, [row]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4">
        <div className="my-8 w-full max-w-6xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          {/* Top bar — mirrors LS: Save Changes (read-only here) · Matrix · Print Label · Archive */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled
                title="Inline edits on the popup are intentionally read-only — catalog attributes are owned by Lightspeed."
                className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-50"
              >
                Save Changes
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
                disabled
                title="Variant-level label printing not wired yet (per-EPC reprint lives on the commissioning page)."
                className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-50"
              >
                Print Label
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

          <div className="flex">
            {/* Left nav — same layout as LS sidebar */}
            <nav className="w-44 shrink-0 border-r border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 py-3">
              {NAV_ITEMS.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  onClick={() => setTab(n.key)}
                  className={`block w-full px-4 py-1.5 text-left font-mono text-xs ${
                    tab === n.key
                      ? "border-l-2 border-[var(--wms-accent)] bg-[var(--wms-surface)] font-semibold text-[var(--wms-fg)]"
                      : "border-l-2 border-transparent text-[var(--wms-muted)] hover:bg-[var(--wms-surface)] hover:text-[var(--wms-fg)]"
                  }`}
                >
                  {n.label}
                </button>
              ))}
            </nav>

            <div className="min-w-0 flex-1 p-5">
              {/* Item-name header (matches the bold name above sections in LS) */}
              <h2 className="mb-4 truncate text-base font-semibold text-[var(--wms-fg)]" title={headerLabel}>
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
                  upcDisplay={upcDisplay}
                  cost={cost}
                  price={price}
                  onlinePrice={onlinePrice}
                  margin={margin}
                  markup={markup}
                  available={available}
                  totalValue={totalValue}
                  totalSaleValue={totalSaleValue}
                />
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
  upcDisplay,
  cost,
  price,
  onlinePrice,
  margin,
  markup,
  available,
  totalValue,
  totalSaleValue,
}: {
  row: CatalogGridRow;
  upcDisplay: string;
  cost: number | null;
  price: number | null;
  onlinePrice: number | null;
  margin: number | null;
  markup: number | null;
  available: number;
  totalValue: number | null;
  totalSaleValue: number | null;
}) {
  /* Avg Cost mirrors Default Cost — Carbon WMS doesn't carry receiving-cost
     history, so the configured default IS the running average. */
  const avgCost = cost;
  /* Reserved is always 0 — WMS doesn't track reservations (Lightspeed POS
     does); shown so the section visually matches the LS screen. */
  const reserved = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr_1fr]">
      {/* Column 1 — Color/Size, IDs, Organize, eCommerce */}
      <div className="space-y-3">
        <Section title="Color / Size">
          <Row label="Color" value={row.color?.trim() || "—"} />
          <Row label="Size" value={row.size?.trim() || "—"} />
        </Section>

        <Section title="IDs">
          <Row label="System ID" value={row.sku_ls_system_id ?? "—"} mono />
          <Row label="UPC" value={upcDisplay} mono />
          <Row label="Custom SKU" value={row.sku || "—"} mono />
        </Section>

        <Section title="Organize">
          <Row
            label="Category"
            value={
              row.category
                ? row.subcategory_1
                  ? `${row.category} / ${row.subcategory_1}`
                  : row.category
                : "—"
            }
          />
          <Row label="Brand" value={row.brand?.trim() || "—"} />
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
          <div className="flex flex-wrap gap-2 px-3 pb-2">
            <button
              type="button"
              disabled
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2.5 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-60"
              title="Shopify product link not wired yet"
            >
              Manage Online Details ↗
            </button>
            <button
              type="button"
              disabled
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2.5 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-60"
              title="Online store URL not wired yet"
            >
              View in Online Store ↗
            </button>
          </div>
        </Section>
      </div>

      {/* Column 2 — Pricing + Inventory Defaults */}
      <div className="space-y-3">
        <Section title="Pricing">
          <PriceHeader />
          <PriceRow label="Default" amount={price} markup={markup} margin={margin} />
          <PriceRow label="Online" amount={onlinePrice} markup={markup} margin={margin} />
        </Section>

        <Section title="Inventory Defaults">
          <Row label="Default Cost" value={fmtMoney(cost)} mono />
        </Section>
      </div>

      {/* Column 3 — Stock + Sales History */}
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

function PriceHeader() {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_1fr] items-center gap-3 bg-[var(--wms-surface-elevated)]/60 px-3 py-1 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
      <span>Name</span>
      <span className="text-right">Price</span>
      <span className="text-right">Markup</span>
      <span className="text-right">Margin</span>
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
      <span className="text-right text-[var(--wms-fg)]">{fmtMoney(amount)}</span>
      <span className="text-right text-[var(--wms-muted)]">{fmtPct(markup)}</span>
      <span className="text-right text-[var(--wms-muted)]">{fmtPct(margin)}</span>
    </div>
  );
}
