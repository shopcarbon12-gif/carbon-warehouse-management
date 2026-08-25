"use client";

/**
 * Right-edge grip rendered inside a `<th>`. Drag to resize that column,
 * double-click to canvas-fit it to its longest visible cell.
 *
 * Use inside a `<th className="relative …">` so absolute positioning
 * anchors to the cell.
 */
export function ResizeHandle({
  colIdx,
  startDrag,
  autoFit,
}: {
  colIdx: number;
  startDrag: (colIdx: number, e: React.MouseEvent) => void;
  autoFit: (colIdx: number) => void;
}) {
  return (
    <span
      onMouseDown={(e) => startDrag(colIdx, e)}
      onDoubleClick={() => autoFit(colIdx)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--wms-accent)]/30 active:bg-[var(--wms-accent)]/50 max-md:hidden"
      title="Drag to resize · double-click to fit"
    />
  );
}
