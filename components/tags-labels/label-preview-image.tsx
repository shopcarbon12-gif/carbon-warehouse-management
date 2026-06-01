"use client";

import { useEffect, useState } from "react";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

type Mode = "rfid" | "nonrfid";

const CAPTION: Record<Mode, string> = {
  rfid: "RFID tag · Zebra .3 · 300 dpi",
  nonrfid: "Non-RFID tag · Zebra .220 · 203 dpi",
};

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

  return (
    <>
      <div className="label-stage">
        {input && img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="Label preview" style={{ maxWidth: "100%", height: "auto" }} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 160,
              color: "var(--wms-muted)",
              fontSize: 13,
            }}
          >
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
