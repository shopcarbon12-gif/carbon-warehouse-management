"use client";

/**
 * The how-to-measure picture for a garment: a real flat-lay photo with every
 * point of measure drawn on it and numbered, and a legend that ties each
 * number to the point the app measures.
 *
 * The photos (public/size-grading/guide/) are the owner's own reference
 * sheet, cut into one picture per garment. Their numbers are baked into the
 * image, so the legend below follows the picture's numbering exactly — the
 * mapping from each number to a point of measure is the table in GUIDES.
 * Line colours on the measuring screen (POM_COLOR) were matched to these
 * pictures, so the line on the photo and the line in the guide agree.
 *
 * Some points the app measures are not drawn in the picture (a sleeve
 * underarm length, a calf width, pockets). They are listed underneath, without
 * a number, so nothing the operator is asked to place is missing from the
 * guide.
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

/** One numbered line in the picture. `key` is null where the picture shows
 *  something the app has no point for (a romper's strap length). */
type Entry = { n: number; key: PomKey | null; label?: string; how?: string; color?: string };
type Guide = { title: string; image: string; entries: Entry[] };

const TOP_ENTRIES: Entry[] = [
  { n: 1, key: "chest" },
  { n: 2, key: "waist" },
  { n: 3, key: "hem" },
  { n: 4, key: "length" },
  { n: 5, key: "shoulder" },
  { n: 6, key: "sleeve" },
  { n: 7, key: "armhole" },
  { n: 8, key: "bicep" },
  { n: 10, key: "cuff" },
  { n: 12, key: "neck" },
  { n: 13, key: "collarHeight" },
  { n: 14, key: "shoulderSlope" },
];

const BOTTOM_ENTRIES = (view: "front" | "back"): Entry[] => [
  { n: 1, key: "waist" },
  { n: 2, key: "hip" },
  { n: view === "back" ? 9 : 3, key: "rise" },
  { n: 4, key: "thigh" },
  { n: 5, key: "inseam" },
  { n: 6, key: "outseam" },
  { n: 7, key: "knee" },
  { n: 8, key: "legOpening" },
];

const SHORTS_ENTRIES: Entry[] = [
  { n: 1, key: "waist" },
  { n: 2, key: "hip" },
  { n: 3, key: "rise" },
  { n: 4, key: "thigh" },
  { n: 5, key: "inseam" },
  { n: 6, key: "legOpening" },
];

function guideFor(sketch: SketchId, view: "front" | "back"): Guide {
  switch (sketch) {
    case "tee":
      return { title: "T-shirt · short sleeve", image: "tee", entries: TOP_ENTRIES };
    case "longsleeve":
      return { title: "Long sleeve · sweatshirt · hoodie", image: "longsleeve", entries: TOP_ENTRIES };
    case "trousers":
      return {
        title: `Jeans · pants · leggings — ${view}`,
        image: `trousers-${view}`,
        entries: BOTTOM_ENTRIES(view),
      };
    case "shorts":
      return { title: `Shorts — ${view}`, image: `shorts-${view}`, entries: SHORTS_ENTRIES };
    case "dress":
      return {
        title: "Dress",
        image: "dress",
        entries: [
          { n: 1, key: "chest" },
          { n: 2, key: "waist" },
          { n: 3, key: "hip" },
          { n: 4, key: "length" },
          { n: 5, key: "shoulder" },
          { n: 6, key: "sleeve" },
          { n: 7, key: "armhole" },
          { n: 8, key: "bicep" },
          { n: 9, key: "cuff" },
        ],
      };
    case "skirt":
      return {
        title: "Skirt",
        image: "skirt",
        entries: [
          { n: 1, key: "waist" },
          { n: 2, key: "hip" },
          { n: 3, key: "length" },
          { n: 4, key: "hem" },
        ],
      };
    case "onepiece":
      return {
        title: "Bodysuit · romper · overall",
        image: "onepiece",
        entries: [
          { n: 1, key: "chest" },
          { n: 2, key: "waist" },
          { n: 3, key: "hip" },
          /* The picture's torso length runs chest to crotch, which is not the
             body length the app measures — shown as the picture has it. */
          { n: 4, key: null, label: "Torso length", how: "From the top of the chest to the crotch seam.", color: "#3b82f6" },
          { n: 5, key: null, label: "Shoulder strap length", how: "From the top of the bib to the back.", color: "#facc15" },
          { n: 6, key: "legOpening" },
        ],
      };
  }
}

/** Kept for callers that list every panel. */
export const SKETCHES: Record<SketchId, { title: string }> = {
  tee: { title: "T-shirt · short sleeve" },
  longsleeve: { title: "Long sleeve · sweatshirt · hoodie" },
  trousers: { title: "Jeans · pants · leggings" },
  shorts: { title: "Shorts" },
  dress: { title: "Dress" },
  skirt: { title: "Skirt" },
  onepiece: { title: "Bodysuit · romper · overall" },
};

/** The picture that fits a garment family; a top picks its sleeve. */
export function sketchFor(type: GarmentType, longSleeve = false): SketchId {
  if (type === "top") return longSleeve ? "longsleeve" : "tee";
  return type;
}

function Badge({ n, color }: { n?: number; color: string }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-bold text-[#0c0f12]"
      style={{ background: color }}
    >
      {n ?? ""}
    </span>
  );
}

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
  /** The points the app measures on this garment. Default: those in the picture. */
  keys?: string[];
  /** Points switched off; struck through in the legend. */
  excluded?: ReadonlySet<string>;
  highlight?: string | null;
  onPick?: (key: string) => void;
  legend?: boolean;
  className?: string;
}) {
  const g = guideFor(sketch, view);
  const wanted = keys ? new Set(keys) : null;
  const numbered = g.entries.filter((e) => !e.key || !wanted || wanted.has(e.key));
  const inPicture = new Set(g.entries.map((e) => e.key).filter(Boolean) as string[]);
  const extra = (keys ?? []).filter((k) => !inPicture.has(k));

  const row = (key: string | null, n: number | undefined, label: string, how: string, color: string) => {
    const off = key ? excluded?.has(key) : false;
    const content = (
      <>
        <Badge n={n} color={color} />
        <span className="min-w-0">
          <span className={`font-semibold text-[var(--wms-fg)] ${off ? "line-through" : ""}`}>{label}</span>
          <span className="text-[var(--wms-muted)]"> — {how}</span>
        </span>
      </>
    );
    const cls = `flex w-full gap-2 rounded px-1 py-0.5 text-left text-xs ${off ? "opacity-45" : ""} ${
      key && highlight === key ? "bg-[var(--wms-surface-elevated)] ring-1 ring-[var(--wms-accent)]" : ""
    }`;
    return (
      <li key={`${key ?? label}-${n ?? "x"}`}>
        {key && onPick && !off ? (
          <button type="button" className={cls} onClick={() => onPick(key)}>
            {content}
          </button>
        ) : (
          <div className={cls}>{content}</div>
        )}
      </li>
    );
  };

  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      {/* A static file in public/, not something next/image needs to resize. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/size-grading/guide/${g.image}.webp`}
        alt={`${g.title} — where each measurement is taken`}
        className="mx-auto block h-auto w-full max-w-[18rem] rounded bg-[#0c0f12]"
        loading="lazy"
      />

      {legend ? (
        <>
          <ol className="flex flex-col gap-1">
            {numbered.map((e) =>
              e.key
                ? row(e.key, e.n, pomLabel(e.key, view), pomHowTo(e.key, type), colorForPom(e.key))
                : row(null, e.n, e.label ?? "", e.how ?? "", e.color ?? "#94a3b8"),
            )}
          </ol>
          {extra.length ? (
            <>
              <p className="mt-1 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Also measured — not drawn in the picture
              </p>
              <ul className="flex flex-col gap-1">
                {extra.map((k) => row(k, undefined, pomLabel(k, view), pomHowTo(k, type), colorForPom(k)))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
