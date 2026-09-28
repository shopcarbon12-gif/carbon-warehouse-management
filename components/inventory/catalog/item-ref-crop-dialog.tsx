"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Crop an item reference photo in the browser — no AI, no round-trip.
 *
 * Item references are meant to record the GARMENT. When they are photos of
 * someone wearing it, every render weighs those faces against the model's own
 * reference photos, and the generated person drifts toward the wrong one. The
 * fix is not to erase anybody: it is to cut the head out of frame, which also
 * gives the garment more of the pixels.
 *
 * Hence the default action is one drag of a horizontal line — everything above
 * it goes — with a free rectangle available when a side or hem needs trimming
 * too. Cropping happens at the image's natural resolution, so a crop never
 * costs detail beyond what it removes.
 */

type Rect = { x: number; y: number; w: number; h: number }; // fractions, 0..1

export function ItemRefCropDialog({
  src,
  busy,
  onCancel,
  onApply,
}: {
  /** Data URL or same-origin URL the browser can actually decode. */
  src: string;
  busy?: boolean;
  onCancel: () => void;
  onApply: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [drawing, setDrawing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  /** Pointer position as a 0..1 fraction of the displayed image box. */
  const pointToFraction = useCallback((clientX: number, clientY: number) => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    const p = pointToFraction(e.clientX, e.clientY);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startRef.current = p;
    setDrawing(true);
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing || busy) return;
    const p = pointToFraction(e.clientX, e.clientY);
    const s = startRef.current;
    if (!p || !s) return;
    setRect({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };

  const onPointerUp = () => {
    if (!drawing) return;
    setDrawing(false);
    // A tap rather than a drag selects nothing — treat it as "clear".
    setRect((r) => (r && (r.w < 0.02 || r.h < 0.02) ? null : r));
  };

  /** Keep everything BELOW `fromTop` — the head-removal shortcut. */
  const cutTop = (fromTop: number) => setRect({ x: 0, y: fromTop, w: 1, h: 1 - fromTop });

  const apply = async () => {
    setErr(null);
    const el = imgRef.current;
    if (!el || !rect) return;
    const nw = el.naturalWidth || 0;
    const nh = el.naturalHeight || 0;
    if (!nw || !nh) {
      setErr("Could not read this image — try a JPG or PNG.");
      return;
    }
    // Map the on-screen fractions back onto the FULL-resolution image, so the
    // crop keeps every pixel it keeps.
    const sx = Math.round(rect.x * nw);
    const sy = Math.round(rect.y * nh);
    const sw = Math.max(1, Math.round(rect.w * nw));
    const sh = Math.max(1, Math.round(rect.h * nh));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setErr("Could not process this image — try a JPG or PNG.");
      return;
    }
    // Flatten onto white: a transparent PNG would otherwise come out black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.92));
    if (!blob || blob.size === 0) {
      setErr("Could not process this image — try a JPG or PNG.");
      return;
    }
    onApply(blob);
  };

  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/75"
        onClick={() => !busy && onCancel()}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:p-0 max-md:items-stretch">
        <div className="flex max-h-[min(92vh,900px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--wms-border)] px-4 py-3">
            <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">Crop reference photo</h3>
            <button
              type="button"
              onClick={() => !busy && onCancel()}
              aria-label="Close"
              className="rounded p-2 font-mono text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:-my-1.5 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 max-md:overscroll-contain">
            <p className="mb-2 font-mono text-[0.68rem] leading-snug text-[var(--wms-muted)]">
              Cut the head out of frame so the face stops competing with your model&apos;s own
              reference photos. Use a shortcut below, or drag a box on the photo.
            </p>

            <div className="mb-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => cutTop(0.25)} disabled={busy} className="wms-btn-ghost rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.66rem] text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:px-3">
                Cut top 25%
              </button>
              <button type="button" onClick={() => cutTop(1 / 3)} disabled={busy} className="wms-btn-ghost rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.66rem] text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:px-3">
                Cut top ⅓
              </button>
              <button type="button" onClick={() => cutTop(0.5)} disabled={busy} className="wms-btn-ghost rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.66rem] text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:px-3">
                Cut top half
              </button>
              <button type="button" onClick={() => setRect(null)} disabled={busy || !rect} className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.66rem] text-[var(--wms-muted)] disabled:opacity-40 max-md:min-h-11 max-md:px-3">
                Reset
              </button>
            </div>

            <div
              ref={wrapRef}
              className="relative select-none overflow-hidden rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
            >
              <img
                ref={imgRef}
                src={src}
                alt="reference to crop"
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="block max-h-[52vh] w-full cursor-crosshair touch-none object-contain max-md:max-h-[46dvh]"
              />
              {rect && rect.w > 0 && rect.h > 0 ? (
                <>
                  {/* Dim everything that the crop throws away. */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/60" style={{ height: pct(rect.y) }} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60" style={{ height: pct(1 - rect.y - rect.h) }} />
                  <div className="pointer-events-none absolute bg-black/60" style={{ top: pct(rect.y), height: pct(rect.h), left: 0, width: pct(rect.x) }} />
                  <div className="pointer-events-none absolute bg-black/60" style={{ top: pct(rect.y), height: pct(rect.h), right: 0, width: pct(1 - rect.x - rect.w) }} />
                  <div
                    className="pointer-events-none absolute border-2 border-[var(--wms-accent)]"
                    style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                  />
                </>
              ) : null}
            </div>

            {err ? <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-status-danger-fg)]">{err}</p> : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:px-4"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy || !rect || rect.w < 0.02 || rect.h < 0.02}
              className="wms-btn-accent-soft rounded px-3 py-2 font-mono text-xs disabled:opacity-50 max-md:min-h-11 max-md:px-4"
            >
              {busy ? "Saving…" : "Apply crop"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
