"use client";

import { useCallback, useState } from "react";

/**
 * Per-column drag-to-resize + double-click-to-fit hook for `<table>` elements.
 *
 * Extracted from the inventory catalog so other tables (cycle count, EPC
 * tracker, reports, modals…) can share the same UX without copy-pasting
 * 80 lines of canvas-measurement glue.
 *
 * Differences from the catalog's original:
 *   - No hardcoded default widths. Tables start in `table-layout: auto`
 *     mode (browser sizing). Once the operator drags a handle or
 *     double-clicks a header, that column gets a pinned px width and the
 *     table flips to `table-layout: fixed` (caller decides via colWidths).
 *   - `columnCount` is the only required argument.
 *
 * Usage:
 *   const tableRef = useRef<HTMLTableElement>(null);
 *   const { colWidths, startDrag, autoFit } = useColResize(tableRef, COLS);
 *   <table ref={tableRef} style={{ tableLayout: colWidths.some(Boolean) ? "fixed" : "auto" }}>
 *     <thead><tr>
 *       <th style={w !== null ? { width: w } : undefined}>
 *         {label}
 *         <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
 *       </th>
 *       …
 */
export function useColResize(
  tableRef: React.RefObject<HTMLTableElement | null>,
  columnCount: number,
  opts?: {
    /** Floor (px) below which a column won't shrink. Default 40. */
    minPx?: number;
    /** Ceiling (px) for autoFit. Default 320. */
    maxAutoFitPx?: number;
    /**
     * Optional seed widths. Use 0/null for "browser-sized" columns that
     * the operator can still drag/auto-fit later. Caller is responsible
     * for matching length to columnCount; mismatched lengths fall back
     * to all-null.
     */
    initialWidths?: (number | null)[];
  },
) {
  const minPx = opts?.minPx ?? 40;
  const maxAutoFitPx = opts?.maxAutoFitPx ?? 320;
  const initial = opts?.initialWidths;

  const [colWidths, setColWidths] = useState<(number | null)[]>(() => {
    if (initial && initial.length === columnCount) {
      return initial.map((w) => (w && w > 0 ? w : null));
    }
    return Array.from({ length: columnCount }, () => null);
  });

  const autoFit = useCallback(
    (colIdx: number) => {
      const tbl = tableRef.current;
      if (!tbl) return;
      // Canvas glyph measurement — layout-independent so flex/w-full
      // children in headers don't fool a Range-based measurement.
      const ths = tbl.querySelectorAll<HTMLElement>("thead th");
      const th = ths[colIdx];
      if (!th) return;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const measure = (el: HTMLElement | null, text: string): number => {
        if (!el || !text) return 0;
        const cs = window.getComputedStyle(el);
        // `font-size font-family` is the only reliable Canvas shorthand —
        // including line-height (which getComputedStyle returns in px,
        // not the unitless value the shorthand expects) silently
        // invalidates the whole declaration and Canvas falls back to a
        // wide default font.
        ctx.font = `${cs.fontWeight || "400"} ${cs.fontSize} ${cs.fontFamily}`;
        return ctx.measureText(text).width;
      };

      const headerSpan = th.querySelector<HTMLElement>("span") ?? th;
      let maxTextW = measure(headerSpan, (headerSpan.textContent ?? "").trim());

      const rows = tbl.querySelectorAll<HTMLTableRowElement>("tbody tr");
      rows.forEach((row) => {
        const cell = row.cells[colIdx];
        if (!cell) return;
        const w = measure(cell, (cell.textContent ?? "").trim());
        if (w > maxTextW) maxTextW = w;
      });

      // Buffer: 16 px for px-2 padding + 14 px for chevron / breathing.
      const buffer = 16 + 14;
      const target = Math.min(
        maxAutoFitPx,
        Math.max(minPx, Math.ceil(maxTextW) + buffer),
      );
      setColWidths((w) => {
        const n = [...w];
        n[colIdx] = target;
        return n;
      });
    },
    [tableRef, minPx, maxAutoFitPx],
  );

  const startDrag = useCallback(
    (colIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const tbl = tableRef.current;
      const th = tbl?.querySelectorAll<HTMLElement>("thead th")[colIdx];
      const startW = th ? th.offsetWidth : 100;
      const onMove = (ev: MouseEvent) => {
        const newW = Math.max(minPx, startW + (ev.clientX - startX));
        setColWidths((w) => {
          const n = [...w];
          n[colIdx] = newW;
          return n;
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [tableRef, minPx],
  );

  return { colWidths, setColWidths, startDrag, autoFit };
}

/** Memoized className for body cells: no wrap, ellipsis, no row-height jumps. */
export const cellTruncate = "overflow-hidden text-ellipsis whitespace-nowrap";

/** Pick the right `tableLayout` value for a colWidths array. */
export function pickTableLayout(colWidths: (number | null)[]): "fixed" | "auto" {
  return colWidths.some((w) => w !== null) ? "fixed" : "auto";
}
