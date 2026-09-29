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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("The browser could not decode this photo."));
    im.src = src;
  });
}

/**
 * An image the canvas may read back from.
 *
 * Drawing a cross-origin picture TAINTS the canvas, and `toBlob` then throws a
 * SecurityError. Item references that arrived from the catalog carry a remote
 * preview URL (Shopify's CDN), so cropping one blew up here — invisibly, which
 * is why "Apply" appeared to hang on "Cutting…".
 *
 * Fetching the bytes ourselves and handing the canvas a blob: URL sidesteps it
 * entirely: same-origin, never tainted. A photo uploaded in this session is
 * already a data: URL and needs none of this.
 */
async function croppableImage(src: string): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  if (/^(data:|blob:)/i.test(src)) return { img: await loadImage(src), revoke: () => {} };
  let resp: Response;
  try {
    resp = await fetch(src, { mode: "cors", credentials: "omit" });
  } catch {
    throw new Error(
      "This photo is hosted elsewhere and the browser is not allowed to read its pixels. Re-upload it to crop it.",
    );
  }
  if (!resp.ok) throw new Error(`Could not read this photo (HTTP ${resp.status}).`);
  const objUrl = URL.createObjectURL(await resp.blob());
  try {
    return { img: await loadImage(objUrl), revoke: () => URL.revokeObjectURL(objUrl) };
  } catch (e) {
    URL.revokeObjectURL(objUrl);
    throw e;
  }
}

export function ItemRefCropDialog({
  src,
  busy,
  error,
  onCancel,
  onApply,
}: {
  /** Data URL or same-origin URL the browser can actually decode. */
  src: string;
  busy?: boolean;
  /** Failure from the parent's upload step — shown HERE, not on the page
   *  behind the modal, where it was invisible and read as "nothing happens". */
  error?: string | null;
  onCancel: () => void;
  onApply: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  /* Opens with the common crop already selected — head out of frame. An empty
     selection disables Apply, and a disabled button is indistinguishable from a
     broken one. */
  const [rect, setRect] = useState<Rect | null>({ x: 0, y: 1 / 3, w: 1, h: 2 / 3 });
  const [drawing, setDrawing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /* Visible progress. Every previous report of "nothing happens" was a step
     failing with no way to tell WHICH step, so each one now announces itself
     before it runs. */
  const [step, setStep] = useState<string | null>(null);

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
    // eslint-disable-next-line no-console
    console.info("[crop] apply clicked", { rect });
    if (!rect) {
      setErr("Pick a crop first — use a shortcut above, or drag a box on the photo.");
      return;
    }
    const shown = imgRef.current;
    if (!shown) {
      setErr("The photo is still loading — try again in a moment.");
      return;
    }
    /* EVERYTHING below is guarded. `toBlob` throws on a tainted canvas, and
       that throw used to escape an unawaited promise: no error, no log, the
       status frozen on "Cutting…". A step that can fail must be able to say so. */
    let revoke = () => {};
    try {
      setStep("Reading the photo…");
      const safe = await croppableImage(src);
      revoke = safe.revoke;
      const el = safe.img;
      const nw = el.naturalWidth || 0;
      const nh = el.naturalHeight || 0;
      if (!nw || !nh) throw new Error("Could not read this image — try a JPG or PNG.");

      // On-screen fractions back onto FULL-resolution pixels.
      const sx = Math.round(rect.x * nw);
      const sy = Math.round(rect.y * nh);
      const sw = Math.max(1, Math.round(rect.w * nw));
      const sh = Math.max(1, Math.round(rect.h * nh));
      setStep(`Cutting ${sw}\u00d7${sh}\u2026`);

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not process this image — try a JPG or PNG.");
      // Flatten onto white: a transparent PNG would otherwise come out black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh);

      /* Lossless by default — a crop removes pixels, it should not degrade the
         ones it keeps. Only a very large crop falls back to high-quality JPEG. */
      let blob = await new Promise<Blob | null>((res, rej) => {
        try {
          canvas.toBlob(res, "image/png");
        } catch (e) {
          rej(e);
        }
      });
      if (!blob || blob.size > 8 * 1024 * 1024) {
        const jpeg = await new Promise<Blob | null>((res, rej) => {
          try {
            canvas.toBlob(res, "image/jpeg", 0.95);
          } catch (e) {
            rej(e);
          }
        });
        if (jpeg && jpeg.size > 0) blob = jpeg;
      }
      if (!blob || blob.size === 0) throw new Error("The browser could not encode the cropped image.");

      // eslint-disable-next-line no-console
      console.info("[crop] encoded", { type: blob.type, bytes: blob.size, sw, sh });
      setStep(`Uploading ${(blob.size / 1024 / 1024).toFixed(1)} MB\u2026`);
      onApply(blob);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[crop] failed:", e);
      setStep(null);
      setErr(e instanceof Error ? e.message : "Crop failed — please try again.");
    } finally {
      revoke();
    }
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

            {/* The inner box SHRINK-WRAPS the image. Previously the <img> was
                `w-full object-contain`, so the element box was wider than the
                picture and the picture sat letterboxed inside it — every
                pointer fraction was measured against the box, not the photo,
                and the crop landed somewhere else entirely. With no `w-full`
                the element box IS the rendered image, so screen coordinates
                and overlay percentages both map 1:1. */}
            <div className="flex justify-center rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-1">
            <div className="relative select-none overflow-hidden leading-none">
              <img
                ref={imgRef}
                src={src}
                alt="reference to crop"
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="block max-h-[52vh] max-w-full cursor-crosshair touch-none max-md:max-h-[46dvh]"
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
            </div>

            {err || error ? (
              <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-status-danger-fg)]">{err || error}</p>
            ) : step ? (
              <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-accent)]">{step}</p>
            ) : null}
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
