/**
 * Every piece of text in the WMS is meant to be selectable — SKUs, EPCs, order
 * numbers and names sit inside buttons, links and clickable table rows as often
 * as in plain text (see the user-select rule in app/globals.css).
 *
 * Selecting text inside something clickable ends with a click, though: finish
 * dragging across a row and the row opens; across a link and it navigates. This
 * swallows that one click — only when the mouse actually travelled (a real drag,
 * not a slightly sloppy click) AND the drag left a non-empty selection touching
 * the clicked element. Plain clicks, touch, keyboard and form fields are untouched.
 *
 * Capture phase on the document, so it runs before React's root listeners.
 */
const DRAG_THRESHOLD_PX = 8;

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function installTextSelectionClickGuard(doc: Document): () => void {
  let down: { x: number; y: number } | null = null;

  const onPointerDown = (e: PointerEvent) => {
    down = e.pointerType === "mouse" && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  const onClick = (e: MouseEvent) => {
    const start = down;
    down = null;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX) return;

    const target = e.target;
    if (!(target instanceof Element) || target.closest(EDITABLE)) return;

    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return;
    if (!sel.getRangeAt(0).intersectsNode(target)) return;

    e.preventDefault();
    e.stopPropagation();
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("click", onClick, true);
  };
}
