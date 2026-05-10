"use client";

import { useCallback, useEffect, useState } from "react";

const SCROLLBAR_THICKNESS = 14;

/**
 * Chunky teal-on-dark overlay scrollbars that replace the OS-default thin
 * bars on scroll containers. Both vertical and horizontal, draggable
 * thumbs, sized proportionally to content/viewport.
 *
 * Mount inside a `position: relative` parent that ALSO holds the
 * scrolling element pointed to by `scrollRef`. The bars overlay the
 * parent, the thumbs scroll the ref.
 *
 * Watches the scroll element via `scroll` listener + ResizeObserver +
 * MutationObserver so thumbs stay in sync as data loads, columns resize,
 * or the container reflows.
 *
 * Extracted from inventory/catalog/catalog-workspace.tsx so other tables
 * can share the same UX.
 */
export function ThickScrollbars({
  scrollRef,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [state, setState] = useState({
    vTop: 0,
    vH: 0,
    hLeft: 0,
    hW: 0,
    showV: false,
    showH: false,
  });

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showV = el.scrollHeight > el.clientHeight + 1;
    const showH = el.scrollWidth > el.clientWidth + 1;
    const vH = showV
      ? Math.max(24, (el.clientHeight / el.scrollHeight) * el.clientHeight)
      : 0;
    const vTop = showV
      ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) *
        (el.clientHeight - vH)
      : 0;
    const hW = showH
      ? Math.max(24, (el.clientWidth / el.scrollWidth) * el.clientWidth)
      : 0;
    const hLeft = showH
      ? (el.scrollLeft / (el.scrollWidth - el.clientWidth)) *
        (el.clientWidth - hW)
      : 0;
    setState({ vTop, vH, hLeft, hW, showV, showH });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recompute();
    el.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    const mo = new MutationObserver(recompute);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", recompute);
      ro.disconnect();
      mo.disconnect();
    };
  }, [recompute, scrollRef]);

  const startDragV = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      const startY = e.clientY;
      const startTop = el.scrollTop;
      const trackH = el.clientHeight - state.vH;
      const scrollRange = el.scrollHeight - el.clientHeight;
      const onMove = (ev: MouseEvent) => {
        el.scrollTop =
          startTop + ((ev.clientY - startY) / trackH) * scrollRange;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [scrollRef, state.vH],
  );

  const startDragH = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      const startX = e.clientX;
      const startLeft = el.scrollLeft;
      const trackW = el.clientWidth - state.hW;
      const scrollRange = el.scrollWidth - el.clientWidth;
      const onMove = (ev: MouseEvent) => {
        el.scrollLeft =
          startLeft + ((ev.clientX - startX) / trackW) * scrollRange;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [scrollRef, state.hW],
  );

  return (
    <>
      {state.showV ? (
        <div
          className="pointer-events-none absolute top-0 z-20"
          style={{
            right: 0,
            width: SCROLLBAR_THICKNESS,
            height: "100%",
            background:
              "color-mix(in srgb, var(--wms-surface-elevated) 70%, #000)",
          }}
        >
          <div
            onMouseDown={startDragV}
            className="pointer-events-auto absolute left-[2px] right-[2px] cursor-pointer rounded"
            style={{
              top: state.vTop,
              height: state.vH,
              background:
                "color-mix(in srgb, var(--wms-muted) 60%, transparent)",
            }}
          />
        </div>
      ) : null}
      {state.showH ? (
        <div
          className="pointer-events-none absolute left-0 z-20"
          style={{
            bottom: 0,
            height: SCROLLBAR_THICKNESS,
            width: state.showV
              ? `calc(100% - ${SCROLLBAR_THICKNESS}px)`
              : "100%",
            background:
              "color-mix(in srgb, var(--wms-surface-elevated) 70%, #000)",
          }}
        >
          <div
            onMouseDown={startDragH}
            className="pointer-events-auto absolute top-[2px] bottom-[2px] cursor-pointer rounded"
            style={{
              left: state.hLeft,
              width: state.hW,
              background:
                "color-mix(in srgb, var(--wms-muted) 60%, transparent)",
            }}
          />
        </div>
      ) : null}
    </>
  );
}
