"use client";

/**
 * How to measure this garment — the owner's reference picture, with the same
 * numbers and colours as the lines on the photo.
 *
 * The pictures live in public/size-grading/guide/ and were drawn to a numbering
 * that pomsFor() reproduces exactly: circle N on the picture is the Nth point in
 * the list beside the photo. That is checked, not hoped — the order of the
 * points is the only thing connecting the two, so it is defined in one place.
 */

import { useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";

import { pomLabel, pomsFor, type GarmentType } from "@/lib/size-grading/garment";

/* Long-sleeved tops get the sweatshirt picture, everything else the tee. The
   catalogue knows which is which; the silhouette alone cannot tell a long sleeve
   folded flat from a short one reliably enough to pick a diagram from it. */
const LONG_SLEEVE = /SWEAT|HOOD|SWEATER|KNIT|JACKET|COAT|BLAZER|LONG/i;

function guideImage(type: GarmentType, view: "front" | "back", category?: string | null): string {
  switch (type) {
    case "top":
      return LONG_SLEEVE.test(category ?? "") ? "longsleeve" : "tee";
    case "trousers":
      return view === "back" ? "trousers-back" : "trousers-front";
    case "shorts":
      return view === "back" ? "shorts-back" : "shorts-front";
    case "dress":
      return "dress";
    case "skirt":
      return "skirt";
    case "onepiece":
      return "onepiece";
  }
}

export function GuidePanel({
  type,
  view,
  category,
}: {
  type: GarmentType;
  view: "front" | "back";
  category?: string | null;
}) {
  // Collapsed by default: it is a reference, and the photo is the work.
  const [open, setOpen] = useState(false);
  const name = guideImage(type, view, category);
  const points = pomsFor(type, view);
  /* Only jeans and shorts were drawn from the back. For the rest the front
     picture is shown on both sides, and it says so — the points are the same,
     only rise, neck drop and length change name. */
  const hasBack = type === "trousers" || type === "shorts";

  return (
    <div className="mt-3 rounded border border-[var(--wms-border)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-[var(--wms-fg)] max-md:min-h-11"
      >
        <BookOpen className="h-4 w-4 text-[var(--wms-accent)]" />
        <span className="flex-1">How to measure this</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open ? (
        <div className="border-t border-[var(--wms-border)] p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/size-grading/guide/${name}.webp`}
            alt={`How to measure — ${name.replace("-", " ")}`}
            className="mx-auto block h-auto w-full max-w-md rounded"
            loading="lazy"
          />
          {view === "back" && !hasBack ? (
            <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Shown from the front — the same points are taken on the back.
            </p>
          ) : null}
          <ol className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-[var(--wms-muted)] sm:grid-cols-2">
            {points.map((key, i) => (
              <li key={key}>
                <span className="font-mono font-semibold text-[var(--wms-fg)]">{i + 1}</span> {pomLabel(key, view)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
