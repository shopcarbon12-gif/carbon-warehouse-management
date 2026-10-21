"use client";

/**
 * Lines on a photo, with draggable ends — Scan review's "Adjust lines" and the
 * accuracy checks' corners (owner, 2026-10-20: the Note10+ screen is cracked,
 * so points are fixed on the desktop instead of on the phone).
 *
 * Coordinates are the photo's own pixels, the same space the phone measured in,
 * so a moved end is measured exactly as the phone would measure it. While an
 * end is dragged a loupe shows the spot under it at 4×, in the corner away from
 * the pointer, so the end can be put on a seam rather than near it.
 */

import { useCallback, useRef, useState } from "react";

export type EditLine = { pts: [number, number][]; color: string; letter?: string; title?: string; closed?: boolean };

export function LineEditor({
  src,
  alt,
  width,
  height,
  lines,
  selected,
  onSelect,
  editing,
  onMove,
}: {
  /** The photo; null draws the lines on a blank frame. */
  src: string | null;
  alt: string;
  width: number;
  height: number;
  lines: Record<string, EditLine>;
  selected: string | null;
  onSelect?: (key: string | null) => void;
  editing: boolean;
  onMove?: (key: string, index: number, to: [number, number]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ key: string; index: number } | null>(null);
  const [at, setAt] = useState<[number, number] | null>(null);
  /** The photo's size on screen, taken when a drag starts (sizes the loupe). */
  const [shown, setShown] = useState<{ w: number; h: number }>({ w: width, h: height });
  const S = Math.max(width, height) || 1;

  const toPhoto = useCallback(
    (e: React.PointerEvent): [number, number] | null => {
      const svg = svgRef.current;
      const m = svg?.getScreenCTM();
      if (!svg || !m) return null;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return [Math.min(width, Math.max(0, p.x)), Math.min(height, Math.max(0, p.y))];
    },
    [width, height],
  );

  /* Press anywhere near an end (within ~28 screen pixels) and it is picked up:
     the owner clicked the line ends and nothing moved when the hit area was the
     dot itself (2026-10-20). */
  const grab = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing) return;
    const p = toPhoto(e);
    const svg = svgRef.current;
    if (!p || !svg) return;
    const perPx = width / (svg.clientWidth || width);
    let best: { key: string; index: number; d: number } | null = null;
    for (const [key, l] of Object.entries(lines)) {
      l.pts.forEach(([x, y], index) => {
        const d = Math.hypot(x - p[0], y - p[1]) / perPx;
        if (d < 28 && (!best || d < best.d)) best = { key, index, d };
      });
    }
    if (!best) return;
    const hit: { key: string; index: number } = best;
    e.preventDefault();
    svg.setPointerCapture?.(e.pointerId);
    setDrag({ key: hit.key, index: hit.index });
    setShown({ w: svg.clientWidth || width, h: svg.clientHeight || height });
    setAt(lines[hit.key].pts[hit.index]);
    onSelect?.(hit.key);
  };

  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toPhoto(e);
    if (!p) return;
    setAt(p);
    onMove?.(drag.key, drag.index, p);
  };
  const end = () => {
    setDrag(null);
    setAt(null);
  };

  const loupeSide = at ? (at[0] < width / 2 ? "right-2" : "left-2") : "right-2";
  const loupeTop = at ? (at[1] < height / 2 ? "bottom-2" : "top-2") : "top-2";
  const zoom = 4;
  const LOUPE = 160;

  return (
    <div className="relative">
      {src ? (
        // The scan's own photo — the picture the lines were placed on.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="block h-auto w-full rounded" draggable={false} />
      ) : (
        <div className="w-full" style={{ aspectRatio: `${width} / ${height}` }} />
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`absolute inset-0 h-full w-full select-none ${editing ? "touch-none" : ""} ${drag ? "cursor-grabbing" : ""}`}
        aria-label="Measurement lines"
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {Object.entries(lines).map(([key, l]) => {
          const on = selected === key;
          const pts = (l.closed ? [...l.pts, l.pts[0]] : l.pts).map(([x, y]) => `${x},${y}`).join(" ");
          const mid = l.pts[Math.floor((l.pts.length - 1) / 2)];
          const nxt = l.pts[Math.floor((l.pts.length - 1) / 2) + 1] ?? mid;
          const mx = (mid[0] + nxt[0]) / 2;
          const my = (mid[1] + nxt[1]) / 2;
          return (
            <g key={key} className="cursor-pointer" onClick={() => !drag && onSelect?.(on ? null : key)}>
              {l.title ? <title>{l.title}</title> : null}
              <polyline points={pts} fill="none" stroke="#000" strokeOpacity={0.6} strokeWidth={on ? 8 : 5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <polyline points={pts} fill="none" stroke={l.color} strokeWidth={on ? 4.5 : 2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              {l.pts.map(([x, y], i) => (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={editing ? S / 80 : S / 260}
                  fill={editing ? "rgba(0,0,0,0.25)" : l.color}
                  stroke={editing ? l.color : "#000"}
                  strokeWidth={editing ? 3 : 1}
                  vectorEffect="non-scaling-stroke"
                  className={editing ? "cursor-grab" : ""}
                />
              ))}
              {l.letter ? (
                // The letter sits mid-line, so it never covers an end that may be dragged.
                <>
                  <circle cx={mx} cy={my} r={S / 60} fill={l.color} stroke="#000" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                  <text x={mx} y={my} textAnchor="middle" dominantBaseline="central" fontSize={S / 46} fontWeight={700} fontFamily="ui-monospace, monospace" fill="#000" pointerEvents="none">
                    {l.letter}
                  </text>
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
      {at && src ? (
        <div
          aria-hidden
          className={`pointer-events-none absolute ${loupeSide} ${loupeTop} overflow-hidden rounded-full border-2 border-white shadow-xl`}
          style={{
            width: LOUPE,
            height: LOUPE,
            backgroundImage: `url(${src})`,
            backgroundRepeat: "no-repeat",
            // The loupe shows `zoom`× the photo as drawn on screen; sized off the svg's rendered width.
            backgroundSize: `${shown.w * zoom}px auto`,
            backgroundPosition: `${LOUPE / 2 - (at[0] / width) * shown.w * zoom}px ${LOUPE / 2 - (at[1] / height) * shown.h * zoom}px`,
          }}
        >
          <span className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-pink-400" />
          <span className="absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-pink-400" />
        </div>
      ) : null}
    </div>
  );
}

/** Length of a polyline in its own pixels. */
export const polyLen = (pts: [number, number][]) =>
  pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
