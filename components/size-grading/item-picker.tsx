"use client";

/**
 * Pick the item a measurement belongs to: search or scan, then choose the size.
 *
 * The order is deliberate and the owner was explicit about it. Whatever route
 * you take in — typing a SKU, a description, or pointing the scanner at a hang
 * tag — what comes back is the UPC. The UPC is the thing the warehouse, the
 * POS and Shopify all agree on, so it is what gets shown and confirmed first;
 * the product name appears underneath it as corroboration, not as the handle.
 *
 * Only once an item is settled does the size list appear, because a measurement
 * without a size is not a fact about anything.
 *
 * The list is SIZES, not size-and-colour pairs. Flat measurements come from the
 * pattern and the pattern does not change with the dye, so a 38 is a 38 whatever
 * colour it is dyed; offering "38 · TEAL" and "38 · PURPLE" separately would be
 * asking the operator to measure the same garment twice. One reading is saved
 * to every colour in that size.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

import { BarcodeScanButton } from "@/components/inventory/catalog/barcode-scan-button";

export type PickedSize = {
  /** One SKU of this size; the server fans the save out to the rest. */
  customSkuId: string;
  sku: string;
  size: string | null;
  /** Every colour this size exists in — what a save will cover. */
  colors: string[];
  count: number;
  lastMeasuredAt: string | null;
};

export type PickedItem = {
  matrixId: string;
  upc: string | null;
  name: string | null;
  vendor: string | null;
  /** Merchandise category — decides which points of measure are offered. */
  category?: string | null;
  subcategory?: string | null;
};

type Hit = { matrix_id: string; upc: string | null; name: string | null; vendor: string | null };

export function ItemPicker({
  item,
  size,
  onPick,
  onPickSize,
}: {
  item: PickedItem | null;
  size: PickedSize | null;
  onPick: (item: PickedItem | null) => void;
  onPickSize: (size: PickedSize | null) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sizes, setSizes] = useState<PickedSize[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  // Typeahead across SKU, UPC, description and vendor — the existing catalogue
  // search already matches all of them, so there is nothing new to maintain.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || item) {
      setHits([]);
      return;
    }
    const seq = ++reqRef.current;
    const id = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/inventory/catalog/search?q=${encodeURIComponent(term)}&scope=matrix`);
        const j = (await r.json().catch(() => ({}))) as { rows?: Hit[] };
        if (seq === reqRef.current) setHits(j.rows ?? []);
      } catch {
        if (seq === reqRef.current) setHits([]);
      }
    }, 220);
    return () => window.clearTimeout(id);
  }, [q, item]);

  const load = useCallback(
    async (params: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch(`/api/inventory/size-grading?${params}`);
        const j = (await r.json().catch(() => ({}))) as {
          item?: PickedItem;
          sizes?: Array<{
            custom_sku_id: string;
            sku: string;
            size: string | null;
            color_code: string | null;
            upc: string | null;
            last_measured_at: string | null;
          }>;
          error?: string;
        };
        if (!r.ok || !j.item) throw new Error(j.error ?? "Not found");
        /* Collapse colour variants into one entry per size. */
        const bySize = new Map<string, PickedSize>();
        for (const s of j.sizes ?? []) {
          const key = s.size ?? `sku:${s.sku}`;
          const found = bySize.get(key);
          if (!found) {
            bySize.set(key, {
              customSkuId: s.custom_sku_id,
              sku: s.sku,
              size: s.size,
              colors: s.color_code ? [s.color_code] : [],
              count: 1,
              lastMeasuredAt: s.last_measured_at,
            });
            continue;
          }
          found.count += 1;
          if (s.color_code && !found.colors.includes(s.color_code)) found.colors.push(s.color_code);
          // Show the most recent measurement across the colours of this size.
          if (s.last_measured_at && (!found.lastMeasuredAt || s.last_measured_at > found.lastMeasuredAt)) {
            found.lastMeasuredAt = s.last_measured_at;
          }
        }
        const list = [...bySize.values()];
        onPick(j.item);
        setSizes(list);
        onPickSize(list.length === 1 ? list[0] : null);
        setHits([]);
        setQ("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Lookup failed");
      } finally {
        setBusy(false);
      }
    },
    [onPick, onPickSize],
  );

  const clear = () => {
    onPick(null);
    onPickSize(null);
    setSizes([]);
    setQ("");
    setError(null);
  };

  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
      {!item ? (
        <>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search SKU, UPC, or item name…"
                enterKeyHint="search"
                className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1.5 pl-8 pr-2 text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
              />
            </div>
            {/* The same scanner the catalogue uses — native on the warehouse
                phones, BarcodeDetector in the browser otherwise. */}
            <BarcodeScanButton onScan={(text) => void load(`upc=${encodeURIComponent(text.trim())}`)} />
          </div>

          {busy ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-[var(--wms-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Looking up…
            </p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-[var(--wms-status-danger-fg)]">{error}</p> : null}

          {hits.length ? (
            <ul className="mt-2 max-h-64 overflow-y-auto rounded border border-[var(--wms-border)]">
              {hits.map((h) => (
                <li key={h.matrix_id}>
                  <button
                    type="button"
                    onClick={() => void load(`matrixId=${h.matrix_id}`)}
                    className="flex w-full items-baseline gap-3 border-b border-[var(--wms-border)]/60 px-2 py-2 text-left last:border-b-0 hover:bg-[var(--wms-surface-elevated)]"
                  >
                    <span className="font-mono text-sm text-[var(--wms-accent)]">{h.upc ?? "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--wms-fg)]">{h.name ?? "(no name)"}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-0">
            {/* UPC first and largest: it is the identifier everything else
                agrees on, and the owner asked to confirm on it. */}
            <p className="font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">UPC</p>
            <p className="font-mono text-xl font-semibold text-[var(--wms-fg)]">{item.upc ?? "—"}</p>
            <p className="mt-0.5 truncate text-sm text-[var(--wms-fg)]">{item.name ?? "(no name)"}</p>
          </div>

          <label className="flex flex-col gap-1 text-sm text-[var(--wms-fg)]">
            <span className="font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">Size</span>
            <select
              value={size?.customSkuId ?? ""}
              onChange={(e) => onPickSize(sizes.find((s) => s.customSkuId === e.target.value) ?? null)}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
            >
              <option value="">Choose…</option>
              {sizes.map((s) => (
                <option key={s.customSkuId} value={s.customSkuId}>
                  {s.size ?? s.sku}
                  {s.count > 1 ? ` · ${s.count} colours` : ""}
                  {s.lastMeasuredAt ? " ✓" : ""}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="wms-btn max-md:min-h-11" onClick={clear}>
            Change item
          </button>

          {size ? (
            <span className="font-mono text-xs text-[var(--wms-muted)]">
              {size.count > 1
                ? `saves to all ${size.count} colours${size.colors.length ? ` (${size.colors.join(", ")})` : ""}`
                : "one colour in this size"}
              {size.lastMeasuredAt
                ? ` · last measured ${new Date(size.lastMeasuredAt).toLocaleDateString()}`
                : ""}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
