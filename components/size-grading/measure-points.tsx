"use client";

/**
 * The measurement, as two points you can move.
 *
 * WHY THIS REPLACED THE MASK
 *
 * The green outline was never the thing anyone wanted. It was the app's working
 * guess at where the garment ends, promoted to the screen, where it made the
 * operator responsible for babysitting an intermediate step — nudge a
 * sensitivity slider, re-tap, look at it again. When it was right nobody
 * noticed; when it was wrong there was nothing to do about it except fight the
 * slider. What actually matters is where each measurement is taken, so that is
 * what is on screen now, and it is directly editable.
 *
 * Every point is a line with two ends. The app proposes where they go; drag
 * either end and the centimetres update as you drag. If the proposal is good
 * you change nothing. If it is wrong you move one end. If there was no proposal
 * at all — a neck opening, which a flat garment's outline genuinely cannot give
 * — you place both ends yourself, which is still faster than fetching a tape.
 *
 * This only works because the photo has already been squared up against the
 * printed target: the image is rendered at an exact number of pixels per
 * centimetre, so any two points on it ARE a measurement. No segmentation is
 * involved in the number at all.
 *
 * The magnifier matters more than it looks. A fingertip covers about forty
 * pixels of a phone screen, so without it the operator cannot see the hem they
 * are placing a handle on.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Point } from "@/lib/size-grading/measure";

export type Handle = {
  a: Point;
  b: Point;
  /** It has a usable position — proposed by the app or placed by hand. */
  set: boolean;
  /** The operator moved this one. A better proposal must never overwrite it. */
  touched?: boolean;
};
export type HandleMap = Record<string, Handle>;

/** Display size of a grab target, in screen pixels — a fingertip, not a pixel. */
const GRAB_PX = 22;
const HANDLE_PX = 11;

export function MeasurePoints({
  image,
  pxPerCm,
  keys,
  labelFor,
  colorFor,
  handles,
  selected,
  onSelect,
  onChange,
}: {
  image: ImageData;
  /** null until the target is found or a calibration exists. */
  pxPerCm: number | null;
  keys: string[];
  labelFor: (key: string) => string;
  colorFor: (key: string) => string;
  handles: HandleMap;
  selected: string | null;
  onSelect: (key: string) => void;
  onChange: (key: string, next: Handle) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null);
  /** Which end of which line is under the finger, and where the finger is. */
  const [drag, setDrag] = useState<{ key: string; end: "a" | "b"; at: Point } | null>(null);

  /* The photo is drawn from an offscreen canvas rather than putImageData on
     every frame: a drag repaints continuously, and re-uploading a megapixel of
     pixels each time is the difference between smooth and unusable. */
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width = image.width;
    off.height = image.height;
    off.getContext("2d")?.putImageData(image, 0, 0);
    bitmapRef.current = off;
  }, [image]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const base = bitmapRef.current;
    if (!canvas || !base) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(base, 0, 0);

    const scale = canvas.clientWidth ? image.width / canvas.clientWidth : 1;
    const lw = Math.max(1.5, 2 * scale);
    ctx.lineCap = "round";
    ctx.font = `bold ${Math.round(13 * scale)}px sans-serif`;

    // Everything not being edited, faint — context without clutter.
    for (const key of keys) {
      const hv = handles[key];
      if (!hv || key === selected) continue;
      ctx.strokeStyle = colorFor(key);
      ctx.globalAlpha = hv.set ? 0.42 : 0.18;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(hv.a.x, hv.a.y);
      ctx.lineTo(hv.b.x, hv.b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const hv = selected ? handles[selected] : null;
    if (hv && selected) {
      const color = colorFor(selected);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.8;
      ctx.beginPath();
      ctx.moveTo(hv.a.x, hv.a.y);
      ctx.lineTo(hv.b.x, hv.b.y);
      ctx.stroke();

      for (const end of ["a", "b"] as const) {
        const p = hv[end];
        const r = HANDLE_PX * scale;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fill();
        ctx.lineWidth = lw * 1.4;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      // The number, where it cannot sit under the finger.
      /* Points can always be placed; turning them into centimetres needs a
         scale. Without one the line still works and says so, rather than the
         whole editor refusing to appear — which is what it used to do, and it
         left an untouchable photo on screen with no explanation. */
      const px = Math.hypot(hv.b.x - hv.a.x, hv.b.y - hv.a.y);
      const text = pxPerCm
        ? `${labelFor(selected)}   ${(px / pxPerCm / 2.54).toFixed(1)}"  ·  ${(px / pxPerCm).toFixed(1)} cm`
        : `${labelFor(selected)}   no scale yet`;
      const mx = (hv.a.x + hv.b.x) / 2;
      const my = (hv.a.y + hv.b.y) / 2;
      const tw = ctx.measureText(text).width;
      const ty = my - 18 * scale;
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(mx - tw / 2 - 6 * scale, ty - 14 * scale, tw + 12 * scale, 20 * scale);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, mx - tw / 2, ty);
    }

    /* The magnifier: a circle of the photo at 3x, pinned to whichever corner
       the finger is furthest from, with a crosshair on the exact point being
       placed. Without it a fingertip hides the very edge it is aiming at. */
    if (drag && base) {
      const R = 62 * scale;
      const zoom = 3;
      const src = drag.at;
      const cx = src.x < image.width / 2 ? image.width - R - 12 * scale : R + 12 * scale;
      const cy = R + 12 * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(
        base,
        src.x - R / zoom, src.y - R / zoom, (R * 2) / zoom, (R * 2) / zoom,
        cx - R, cy - R, R * 2, R * 2,
      );
      ctx.strokeStyle = colorFor(drag.key);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.5, cy);
      ctx.lineTo(cx + R * 0.5, cy);
      ctx.moveTo(cx, cy - R * 0.5);
      ctx.lineTo(cx, cy + R * 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = lw * 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [image, keys, handles, selected, colorFor, labelFor, pxPerCm, drag]);

  useEffect(() => {
    draw();
  }, [draw]);

  const toImage = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toImage(e);
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = image.width / Math.max(1, rect.width);
    const grab = GRAB_PX * scale;

    // An end of the line already being edited wins, so a dense area of lines
    // cannot steal the handle out from under the finger.
    const order = selected ? [selected, ...keys.filter((k) => k !== selected)] : keys;
    for (const key of order) {
      const hv = handles[key];
      if (!hv) continue;
      for (const end of ["a", "b"] as const) {
        if (Math.hypot(hv[end].x - p.x, hv[end].y - p.y) <= grab) {
          onSelect(key);
          setDrag({ key, end, at: hv[end] });
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    // Not on a handle: select whichever line is nearest, so a tap picks a point
    // to work on rather than doing nothing.
    let best: { key: string; d: number } | null = null;
    for (const key of keys) {
      const hv = handles[key];
      if (!hv) continue;
      const d = distanceToSegment(p, hv.a, hv.b);
      if (!best || d < best.d) best = { key, d };
    }
    if (best && best.d <= grab * 2) onSelect(best.key);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    e.preventDefault();
    const p = toImage(e);
    const hv = handles[drag.key];
    if (!hv) return;
    setDrag({ ...drag, at: p });
    onChange(drag.key, { ...hv, [drag.end]: p, set: true, touched: true });
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer was already gone */
    }
    setDrag(null);
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // touch-none keeps a drag from scrolling the page out from under it.
      className="block h-auto w-full touch-none select-none"
    />
  );
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}
