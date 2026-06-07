"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X as XIcon, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Large in-app image preview for the catalog. Clicking a product picture
 * (item popup, catalog row icon, or matrix gallery) opens this full-window
 * overlay instead of navigating away. Images are Shopify CDN URLs — never
 * re-hosted.
 *
 * Single image → just the picture. Multiple images → a slider: left/right
 * arrows, ArrowLeft/ArrowRight keys, mouse-wheel, and a horizontally
 * scrollable thumbnail strip to jump to any picture. Closes on backdrop
 * click, the X, or Escape. Rendered above the catalog modals (z-[120]).
 */
export function CatalogImageLightbox({
  images,
  startIndex = 0,
  alt,
  onClose,
}: {
  images: string[];
  startIndex?: number;
  alt?: string;
  onClose: () => void;
}) {
  const list = images.filter(Boolean);
  const [idx, setIdx] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, list.length - 1)),
  );
  const wheelLock = useRef(0);
  const thumbStrip = useRef<HTMLDivElement | null>(null);

  const multi = list.length > 1;
  const go = useCallback(
    (delta: number) => {
      setIdx((i) => {
        const n = (i + delta + list.length) % list.length;
        return n;
      });
    },
    [list.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (multi && e.key === "ArrowLeft") go(-1);
      else if (multi && e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go, multi]);

  // Keep the active thumbnail scrolled into view.
  useEffect(() => {
    const strip = thumbStrip.current;
    if (!strip) return;
    const active = strip.children[idx] as HTMLElement | undefined;
    active?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [idx]);

  if (list.length === 0) return null;

  const onWheel = (e: React.WheelEvent) => {
    if (!multi) return;
    const now = Date.now();
    if (now - wheelLock.current < 220) return; // debounce trackpad inertia
    wheelLock.current = now;
    go(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-black/85 p-4"
      onWheel={onWheel}
    >
      <button
        type="button"
        aria-label="Close preview"
        className="absolute inset-0 h-full w-full cursor-zoom-out"
        onClick={onClose}
      />
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-4 top-4 z-[122] rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <XIcon className="h-5 w-5" />
      </button>

      {multi ? (
        <button
          type="button"
          aria-label="Previous image"
          onClick={() => go(-1)}
          className="absolute left-3 top-1/2 z-[122] -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>
      ) : null}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={list[idx]}
        alt={alt ? `${alt} ${idx + 1}` : "Product image"}
        className="relative z-[121] max-h-[78vh] max-w-[88vw] rounded-lg object-contain shadow-2xl"
      />

      {multi ? (
        <button
          type="button"
          aria-label="Next image"
          onClick={() => go(1)}
          className="absolute right-3 top-1/2 z-[122] -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      ) : null}

      {multi ? (
        <div className="relative z-[122] mt-3 flex max-w-[92vw] flex-col items-center gap-2">
          <span className="font-mono text-xs text-white/70">
            {idx + 1} / {list.length}
          </span>
          <div
            ref={thumbStrip}
            className="flex max-w-[92vw] gap-2 overflow-x-auto px-1 py-1"
          >
            {list.map((u, i) => (
              <button
                key={u}
                type="button"
                onClick={() => setIdx(i)}
                className={`h-14 w-14 shrink-0 overflow-hidden rounded border bg-white ${
                  i === idx ? "border-white" : "border-white/30 opacity-70 hover:opacity-100"
                }`}
                aria-label={`Go to image ${i + 1}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt={`thumb ${i + 1}`} className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
