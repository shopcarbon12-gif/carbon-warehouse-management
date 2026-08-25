"use client";

import { useRef, type ReactNode } from "react";
import { ThickScrollbars } from "./thick-scrollbars";

/**
 * Standard outer wrapper for site tables. Encapsulates the "rounded
 * border + optional caption header + viewport-bounded scroll container +
 * thick overlay scrollbars" pattern from the inventory catalog.
 *
 * The caller still owns the `<table>` element + sticky header + cells,
 * because column structure is per-table. This wrapper only handles the
 * outer chrome that should be identical everywhere.
 *
 * Pass `scrollRef` to children that need to plug the resize hook into
 * the scroll element (none of the current consumers do; the prop is
 * available for future use).
 */
export function DataTableContainer({
  caption,
  rightSlot,
  /** Tailwind/CSS string for the scroll container's max-height. */
  maxHeight = "min(60vh, 560px)",
  children,
}: {
  caption?: ReactNode;
  /** Optional element rendered on the right of the caption row. */
  rightSlot?: ReactNode;
  maxHeight?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="relative overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      {caption !== undefined ? (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] max-md:flex-wrap">
          <span className="max-md:min-w-0 max-md:truncate">{caption}</span>
          {rightSlot}
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight }}
      >
        {children}
      </div>
      {/* Phone scroll affordance: hint that columns continue off-screen.
          The overlay scrollbars below are mouse chrome — hidden on phones
          so native touch panning owns the table. Both md-gated. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--wms-surface)] to-transparent md:hidden"
      />
      <div className="max-md:hidden">
        <ThickScrollbars scrollRef={scrollRef} />
      </div>
    </div>
  );
}
