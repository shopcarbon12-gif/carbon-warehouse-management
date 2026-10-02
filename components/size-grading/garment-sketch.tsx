"use client";

/**
 * A flat sketch of the garment with every point of measure drawn on it, in the
 * same colour as its line on the photo and its dot in the result list.
 *
 * One picture per garment rather than one per point: the operator needs to see
 * where the chest line sits relative to the armpit and the hem line at the same
 * time, which is what a tech-pack sketch does and a row of separate photos does
 * not.
 *
 * Drawn as SVG on a 200 × 240 grid, so it is crisp at any size, theme-aware
 * through the WMS colour tokens, and costs nothing to load.
 */

import type { GarmentType, PomKey } from "@/lib/size-grading/garment";
import { pomLabel } from "@/lib/size-grading/garment";
import { colorForPom, pomHowTo } from "@/lib/size-grading/pom-guide";

export type SketchId =
  | "tee"
  | "longsleeve"
  | "trousers"
  | "shorts"
  | "dress"
  | "skirt"
  | "onepiece";

type Pt = [number, number];
type Sketch = {
  title: string;
  /** The garment outline. */
  body: string;
  /** Seams and details drawn faintly for orientation: waistband, pockets, fly. */
  details?: Partial<Record<"front" | "back" | "both", string[]>>;
  /** One polyline per point of measure. */
  lines: Partial<Record<PomKey, Pt[]>>;
};

const TOP_LINES_SHORT: Sketch["lines"] = {
  neck: [[80, 20], [120, 20]],
  neckDrop: [[100, 20], [100, 32]],
  collarHeight: [[119, 21], [116, 27]],
  shoulderSlope: [[150, 20], [150, 32]],
  shoulder: [[52, 32], [148, 32]],
  armhole: [[148, 32], [144, 78]],
  sleeve: [[52, 32], [20, 70]],
  sleeveInseam: [[56, 78], [38, 86]],
  bicep: [[56, 78], [31, 57]],
  cuff: [[22, 73], [36, 85]],
  chest: [[56, 88], [144, 88]],
  waist: [[57, 150], [143, 150]],
  hem: [[58, 216], [142, 216]],
  length: [[84, 24], [84, 220]],
};

export const SKETCHES: Record<SketchId, Sketch> = {
  tee: {
    title: "T-shirt · short sleeve",
    body: "M80,20 Q100,36 120,20 L148,32 L180,70 L162,86 L144,78 L142,220 L58,220 L56,78 L38,86 L20,70 L52,32 Z",
    details: { both: ["M80,20 Q100,40 120,20"] },
    lines: TOP_LINES_SHORT,
  },
  longsleeve: {
    title: "Long sleeve · sweatshirt · hoodie",
    body: "M80,20 Q100,36 120,20 L148,32 L186,168 L168,174 L144,80 L142,220 L58,220 L56,80 L32,174 L14,168 L52,32 Z",
    details: { both: ["M80,20 Q100,40 120,20", "M16,160 L34,166", "M184,160 L166,166"] },
    lines: {
      ...TOP_LINES_SHORT,
      armhole: [[148, 32], [144, 80]],
      sleeve: [[52, 32], [14, 168]],
      sleeveInseam: [[56, 80], [32, 174]],
      bicep: [[56, 80], [40, 75]],
      cuff: [[15, 170], [31, 175]],
      chest: [[56, 90], [144, 90]],
    },
  },
  trousers: {
    title: "Jeans · pants · leggings",
    body: "M60,10 L140,10 L144,60 L138,230 L108,230 L100,78 L92,230 L62,230 L56,60 Z",
    details: {
      both: ["M59,20 L141,20"],
      front: ["M64,20 Q72,40 82,44", "M136,20 Q128,40 118,44", "M100,20 L100,60"],
      back: ["M66,34 L92,34 L92,58 L79,64 L66,58 Z", "M108,34 L134,34 L134,58 L121,64 L108,58 Z"],
    },
    lines: {
      waist: [[60, 13], [140, 13]],
      waistbandHeight: [[124, 10], [124, 20]],
      hip: [[57, 50], [143, 50]],
      rise: [[100, 10], [100, 78]],
      frontPocketOpening: [[64, 20], [82, 44]],
      backPocketWidth: [[66, 31], [92, 31]],
      backPocketLength: [[95, 34], [95, 64]],
      thigh: [[57, 84], [99.7, 84]],
      knee: [[59.2, 150], [96.2, 150]],
      calf: [[105.6, 185], [139.6, 185]],
      legOpening: [[108, 227], [138, 227]],
      inseam: [[100, 78], [92, 230]],
      outseam: [[143, 10], [147, 60], [141, 230]],
    },
  },
  shorts: {
    title: "Shorts",
    body: "M60,10 L140,10 L146,60 L148,130 L108,130 L100,82 L92,130 L52,130 L54,60 Z",
    details: {
      both: ["M59,20 L141,20"],
      front: ["M64,20 Q72,38 80,42", "M136,20 Q128,38 120,42", "M100,20 L100,60"],
      back: ["M66,34 L92,34 L92,56 L79,62 L66,56 Z", "M108,34 L134,34 L134,56 L121,62 L108,56 Z"],
    },
    lines: {
      waist: [[60, 13], [140, 13]],
      waistbandHeight: [[124, 10], [124, 20]],
      hip: [[55.2, 50], [144.8, 50]],
      rise: [[100, 10], [100, 82]],
      frontPocketOpening: [[64, 20], [80, 42]],
      backPocketWidth: [[66, 31], [92, 31]],
      backPocketLength: [[95, 34], [95, 62]],
      thigh: [[53.2, 88], [99, 88]],
      legOpening: [[108, 127], [148, 127]],
      inseam: [[100, 82], [92, 130]],
      outseam: [[143, 10], [149, 60], [151, 130]],
    },
  },
  dress: {
    title: "Dress",
    body: "M82,12 Q100,28 118,12 L144,22 L170,52 L156,66 L140,58 L136,110 L162,232 L38,232 L64,110 L60,58 L44,66 L30,52 L56,22 Z",
    details: { both: ["M82,12 Q100,32 118,12", "M64,110 L136,110"] },
    lines: {
      neck: [[82, 12], [118, 12]],
      neckDrop: [[100, 12], [100, 20]],
      shoulder: [[56, 22], [144, 22]],
      armhole: [[144, 22], [140, 58]],
      sleeve: [[56, 22], [30, 52]],
      sleeveInseam: [[60, 58], [44, 66]],
      bicep: [[60, 58], [40, 40.6]],
      cuff: [[31, 54], [43, 65]],
      chest: [[60.6, 66], [139.4, 66]],
      waist: [[64, 106], [136, 106]],
      hip: [[57.6, 140], [142.4, 140]],
      hem: [[38.3, 229], [161.7, 229]],
      length: [[86, 16], [86, 232]],
    },
  },
  skirt: {
    title: "Skirt",
    body: "M66,12 L134,12 L136,24 L162,226 L38,226 L64,24 Z",
    details: { both: ["M64,24 L136,24"] },
    lines: {
      waist: [[66, 15], [134, 15]],
      waistbandHeight: [[124, 12], [124, 24]],
      hip: [[58.1, 70], [141.9, 70]],
      hem: [[38.3, 223], [161.7, 223]],
      length: [[100, 12], [100, 226]],
    },
  },
  onepiece: {
    title: "Bodysuit · romper · overall",
    body: "M84,12 Q100,26 116,12 L140,20 L164,46 L152,60 L138,54 L136,120 L144,128 L148,200 L108,200 L100,150 L92,200 L52,200 L56,128 L64,120 L62,54 L48,60 L36,46 L60,20 Z",
    details: { both: ["M84,12 Q100,30 116,12", "M64,120 L136,120"] },
    lines: {
      neck: [[84, 12], [116, 12]],
      neckDrop: [[100, 12], [100, 19]],
      shoulder: [[60, 20], [140, 20]],
      armhole: [[140, 20], [138, 54]],
      sleeve: [[60, 20], [36, 46]],
      bicep: [[62, 54], [44, 37.4]],
      cuff: [[37, 48], [47, 59]],
      chest: [[62.2, 62], [137.8, 62]],
      waist: [[63.7, 110], [136.3, 110]],
      hip: [[55.7, 134], [144.3, 134]],
      rise: [[100, 120], [100, 150]],
      thigh: [[54.4, 156], [99, 156]],
      legOpening: [[108, 198], [148, 198]],
      inseam: [[100, 150], [92, 200]],
      length: [[84, 16], [84, 200]],
    },
  },
};

/** The sketch that fits a garment family; a top picks its sleeve. */
export function sketchFor(type: GarmentType, longSleeve = false): SketchId {
  if (type === "top") return longSleeve ? "longsleeve" : "tee";
  return type;
}

const mid = (pts: Pt[]): Pt => {
  if (pts.length === 2) return [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  return pts[Math.floor(pts.length / 2)];
};

export function GarmentSketch({
  sketch,
  type,
  view = "front",
  keys,
  excluded,
  highlight,
  onPick,
  legend = true,
  className = "",
}: {
  sketch: SketchId;
  type: GarmentType;
  view?: "front" | "back";
  /** Which points to show, in order — numbered in this order. Default: every point on the sketch. */
  keys?: string[];
  /** Points switched off; shown struck through in the legend and left off the drawing. */
  excluded?: ReadonlySet<string>;
  highlight?: string | null;
  onPick?: (key: string) => void;
  legend?: boolean;
  className?: string;
}) {
  const s = SKETCHES[sketch];
  const order = (keys ?? Object.keys(s.lines)).filter((k) => s.lines[k as PomKey]);
  const drawn = order.filter((k) => !excluded?.has(k));
  const number = new Map(order.map((k, i) => [k, i + 1]));
  const details = [...(s.details?.both ?? []), ...(s.details?.[view] ?? [])];

  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <svg
        viewBox="0 0 200 240"
        role="img"
        aria-label={`${s.title} — where each measurement is taken`}
        className="mx-auto block h-auto w-full max-w-[16rem]"
      >
        <path
          d={s.body}
          fill="var(--wms-surface-elevated)"
          stroke="var(--wms-muted)"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
        {details.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--wms-muted)" strokeWidth={0.8} strokeDasharray="2 2" opacity={0.7} />
        ))}
        {drawn.map((k) => {
          const pts = s.lines[k as PomKey]!;
          const on = !highlight || highlight === k;
          return (
            <g
              key={k}
              opacity={on ? 1 : 0.28}
              onClick={onPick ? () => onPick(k) : undefined}
              style={onPick ? { cursor: "pointer" } : undefined}
            >
              <polyline
                points={pts.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke={colorForPom(k)}
                strokeWidth={highlight === k ? 3.2 : 2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {[pts[0], pts[pts.length - 1]].map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={1.8} fill={colorForPom(k)} />
              ))}
            </g>
          );
        })}
        {/* Numbers drawn last so no line runs over one. */}
        {drawn.map((k) => {
          const [x, y] = mid(s.lines[k as PomKey]!);
          const on = !highlight || highlight === k;
          return (
            <g key={`n-${k}`} opacity={on ? 1 : 0.35} pointerEvents="none">
              <circle cx={x} cy={y} r={5.4} fill={colorForPom(k)} stroke="var(--wms-surface)" strokeWidth={1} />
              <text
                x={x}
                y={y + 2.3}
                textAnchor="middle"
                fontSize={6.4}
                fontWeight={700}
                fill="#0c0f12"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
              >
                {number.get(k)}
              </text>
            </g>
          );
        })}
      </svg>

      {legend ? (
        <ol className="flex flex-col gap-1.5">
          {order.map((k) => {
            const off = excluded?.has(k);
            return (
              <li
                key={k}
                className={`flex gap-2 text-xs ${off ? "opacity-45" : ""} ${
                  highlight === k ? "rounded bg-[var(--wms-surface-elevated)]" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-bold text-[#0c0f12]"
                  style={{ background: colorForPom(k) }}
                >
                  {number.get(k)}
                </span>
                <span className="min-w-0">
                  <span className={`font-semibold text-[var(--wms-fg)] ${off ? "line-through" : ""}`}>
                    {pomLabel(k, view)}
                  </span>
                  <span className="text-[var(--wms-muted)]"> — {pomHowTo(k, type)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
