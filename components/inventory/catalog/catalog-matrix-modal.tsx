"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { X as XIcon } from "lucide-react";

/**
 * Lightspeed-style matrix popup. Opens when the operator clicks the
 * "Matrix" button from CatalogItemDetailsModal. Shows shared values,
 * default values, color + size lists, and a Group Items row per variant.
 *
 * Buttons:
 *   - Save Changes : disabled (catalog attributes are owned by Lightspeed)
 *   - Duplicate    : disabled
 *   - Archive      : flips archived on EVERY custom_sku under this matrix
 *                    via PATCH /api/inventory/catalog/matrices/[id]
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

export function CatalogMatrixModal({ matrixId, canManage, onClose, onMutated }: Props) {
  const { data, error, mutate, isLoading } = useSWR<MatrixDetailResp>(
    `/api/inventory/catalog/matrices/${matrixId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /* Default Values surface the most representative price + cost across
     all variants — Lightspeed shows the matrix-level default that newly
     created variants inherit. We approximate via the MIN of non-archived
     variants (matches LS sync behavior we already use for manual items).*/
  const defaults = useMemo(() => {
    if (!data) return { price: null as number | null, cost: null as number | null };
    let price: number | null = null;
    let cost: number | null = null;
    for (const v of data.variants) {
      const p = parseMoney(v.retail_price);
      const c = parseMoney(v.default_cost);
      if (p != null) price = price == null ? p : Math.min(price, p);
      if (c != null) cost = cost == null ? c : Math.min(cost, c);
    }
    return { price, cost };
  }, [data]);

  const onlinePrice = defaults.price; // mirrors Default until LS exposes separately
  const margin =
    defaults.price != null && defaults.cost != null && defaults.price > 0
      ? ((defaults.price - defaults.cost) / defaults.price) * 100
      : null;
  const markup =
    defaults.cost != null && defaults.cost > 0 && defaults.price != null
      ? ((defaults.price - defaults.cost) / defaults.cost) * 100
      : null;

  const colors = useMemo(() => {
    if (!data) return [] as string[];
    const seen = new Set<string>();
    for (const v of data.variants) {
      const c = v.color?.trim();
      if (c && !seen.has(c)) seen.add(c);
    }
    return [...seen];
  }, [data]);
  const sizes = useMemo(() => {
    if (!data) return [] as string[];
    const seen = new Set<string>();
    for (const v of data.variants) {
      const s = v.size?.trim();
      if (s && !seen.has(s)) seen.add(s);
    }
    return [...seen];
  }, [data]);

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
      <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4">
        <div className="my-8 w-full max-w-6xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          {/* Top bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled
                title="Matrix attributes are read-only — owned by Lightspeed sync."
                className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] opacity-50"
              >
                Save Changes
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

          {isLoading || !data ? (
            <p className="p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              Loading matrix…
            </p>
          ) : (
            <div className="flex">
              {/* Left nav — Setup / Matrix (matches LS) */}
              <nav className="w-32 shrink-0 border-r border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 py-3">
                <div className="border-l-2 border-transparent px-4 py-1.5 font-mono text-xs text-[var(--wms-muted)]">
                  Setup
                </div>
                <div className="border-l-2 border-[var(--wms-accent)] bg-[var(--wms-surface)] px-4 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)]">
                  Matrix
                </div>
              </nav>

              <div className="min-w-0 flex-1 space-y-4 p-5">
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr_0.5fr_0.5fr]">
                  {/* Shared Values */}
                  <Section title="Shared Values · applied to all items in this matrix">
                    <Row label="Description" value={data.matrix.description || "—"} />
                    <Row
                      label="Category"
                      value={
                        data.matrix.category
                          ? data.matrix.subcategory_1
                            ? `${data.matrix.category} / ${data.matrix.subcategory_1}`
                            : data.matrix.category
                          : "—"
                      }
                    />
                    <Row label="Brand" value={data.matrix.brand?.trim() || "—"} />
                  </Section>

                  {/* Matrix Type + Default Values */}
                  <div className="space-y-4">
                    <Section title="Matrix Type">
                      <Row label="Attributes" value="Color / Size" />
                    </Section>
                    <Section title="Default Values">
                      <PriceHeader />
                      <PriceRow label="Default" amount={defaults.price} markup={markup} margin={margin} />
                      <PriceRow label="Online" amount={onlinePrice} markup={markup} margin={margin} />
                      <Row label="Default Cost" value={fmtMoney(defaults.cost)} mono />
                    </Section>
                  </div>

                  {/* Color list */}
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

                  {/* Size list */}
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

                {/* Group Items */}
                <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
                  <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    Group Items
                  </div>
                  <div className="grid grid-cols-[80px_80px_1fr_140px_180px] gap-3 border-b border-[var(--wms-border)]/60 px-3 py-1.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    <span>Color</span>
                    <span>Size</span>
                    <span>Pricing</span>
                    <span>UPC</span>
                    <span>Custom SKU</span>
                  </div>
                  {data.variants.map((v) => {
                    const p = parseMoney(v.retail_price);
                    const c = parseMoney(v.default_cost);
                    return (
                      <div
                        key={v.id}
                        className="grid grid-cols-[80px_80px_1fr_140px_180px] items-center gap-3 border-b border-[var(--wms-border)]/40 px-3 py-2 font-mono text-xs text-[var(--wms-fg)] last:border-b-0"
                      >
                        <span>{v.color?.trim() || "—"}</span>
                        <span>{v.size?.trim() || "—"}</span>
                        <div className="grid grid-cols-[40px_1fr] gap-2 text-[var(--wms-muted)]">
                          <span className="text-[0.6rem] uppercase">Price</span>
                          <span className="text-right tabular-nums text-[var(--wms-fg)]">
                            {fmtMoney(p)}
                          </span>
                          <span className="text-[0.6rem] uppercase">Cost</span>
                          <span className="text-right tabular-nums text-[var(--wms-fg)]">
                            {fmtMoney(c)}
                          </span>
                        </div>
                        <span className="truncate text-[var(--wms-muted)]" title={v.upc ?? ""}>
                          {v.upc || "—"}
                        </span>
                        <span className="truncate" title={v.sku}>
                          {v.sku}
                          {v.archived ? (
                            <span className="ml-2 rounded border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 text-[0.5rem] uppercase tracking-wide text-amber-200">
                              archived
                            </span>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
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
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {label}
      </span>
      <span className={`${mono ? "font-mono" : ""} text-xs text-[var(--wms-fg)]`}>
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
