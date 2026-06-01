"use client";

import { useEffect, useState } from "react";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

type Mode = "rfid" | "nonrfid";

const CAPTION: Record<Mode, string> = {
  rfid: "RFID tag · 6.5 × 5 cm · Zebra .3 · 300 dpi",
  nonrfid: "Non-RFID tag · 2 × 3 in · Zebra .220 · 203 dpi",
};

// True physical label size (inches, landscape as printed). Rendered at a common
// px/inch so the two tabs show their real relative sizes; rotated 90° CW for an
// upright (vertical) view.
const SIZE_IN: Record<Mode, { w: number; h: number }> = {
  rfid: { w: 2.56, h: 1.97 }, // 6.5 × 5 cm
  nonrfid: { w: 3.3, h: 2.04 }, // printed extent of the 2×3" stock
};
const PX_PER_IN = 88;

/**
 * Visual label preview that renders the EXACT print ZPL to an image via
 * /api/tags/preview-image (Labelary), so the picture matches the print on both
 * tabs (RFID = generateCarbonTagZpl, Non-RFID = the 203dpi tag + box icon).
 */
export function LabelPreviewImage({
  input,
  mode,
  sysid,
  companyPrefix,
  serial,
}: {
  input: CarbonTagInput | null;
  mode: Mode;
  sysid?: string | number;
  companyPrefix: number;
  serial: number;
}) {
  // State is only written inside async callbacks (never synchronously in the
  // effect body) so the previous preview stays put until the new one resolves.
  const [img, setImg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    fetch("/api/tags/preview-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: mode, input, sysid, companyPrefix, serial }),
    })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { imageDataUrl?: string; error?: string };
        if (!r.ok) throw new Error(j.error || "Preview failed");
        return j;
      })
      .then((j) => {
        if (cancelled) return;
        setImg(String(j.imageDataUrl || ""));
        setErr("");
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Preview failed");
      });
    return () => {
      cancelled = true;
    };
  }, [input, mode, sysid, companyPrefix, serial]);

  const placeholder = !input ? "Select a SKU" : err || "Rendering preview…";
  const sz = SIZE_IN[mode];
  const wPx = Math.round(sz.w * PX_PER_IN); // pre-rotation (landscape) width
  const hPx = Math.round(sz.h * PX_PER_IN); // pre-rotation height

  return (
    <>
      <div
        className="label-stage"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "18px 0" }}
      >
        {input && img ? (
          // rotated 90° CW → vertical; outer box is the post-rotation footprint
          <div style={{ width: hPx, height: wPx, position: "relative", flex: "0 0 auto" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img}
              alt="Label preview"
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: wPx,
                height: hPx,
                transform: "translate(-50%, -50%) rotate(90deg)",
                boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
                background: "#fff",
              }}
            />
          </div>
        ) : (
          <div style={{ minHeight: 200, display: "flex", alignItems: "center", color: "var(--wms-muted)", fontSize: 13 }}>
            {placeholder}
          </div>
        )}
      </div>
      <div className="dims">
        {CAPTION[mode]}
        {input ? ` · next serial ${serial}` : ""}
      </div>
    </>
  );
}
