"use client";

import { useEffect, useRef } from "react";
import { olaDescriptionLines } from "@/lib/utils/zpl-ola-hangtag";

export type OlaPreviewItem = {
  sku: string;
  size?: string | null;
  color?: string | null;
  price?: number | string | null;
  upc?: string | null;
  description?: string | null;
  sysid: string | number;
  attr12?: string | null;
};

type Media = "rfid" | "nonrfid";

/* Artwork dot-space (the OLA template), drawn rotated 90° CW for display. */
const ART_W = 789;
const ART_H = 576;

/* Physical label stock per tab. The 2×3 non-RFID label is larger than the
 * 5×6.5 cm RFID tag; both render at one common px/cm so sizes compare truly. */
const PX_PER_CM = 70;
const MEDIA: Record<Media, { caption: string; wCm: number; hCm: number }> = {
  rfid: { caption: "RFID tag · 5 × 6.5 cm", wCm: 5.0, hCm: 6.5 },
  nonrfid: { caption: "Non-RFID · 2 × 3 in", wCm: 5.08, hCm: 7.62 },
};

/* Canonical Code 39 patterns (W = wide element, N = narrow). */
const C39: Record<string, string> = {
  "0": "NNNWWNWNN", "1": "WNNWNNNNW", "2": "NNWWNNNNW", "3": "WNWWNNNNN", "4": "NNNWWNNNW",
  "5": "WNNWWNNNN", "6": "NNWWWNNNN", "7": "NNNWNNWNW", "8": "WNNWNNWNN", "9": "NNWWNNWNN",
  A: "WNNNNWNNW", B: "NNWNNWNNW", C: "WNWNNWNNN", D: "NNNNWWNNW", E: "WNNNWWNNN", F: "NNWNWWNNN",
  G: "NNNNNWWNW", H: "WNNNNWWNN", I: "NNWNNWWNN", J: "NNNNWWWNN", K: "WNNNNNNWW", L: "NNWNNNNWW",
  M: "WNWNNNNWN", N: "NNNNWNNWW", O: "WNNNWNNWN", P: "NNWNWNNWN", Q: "NNNNNNWWW", R: "WNNNNNWWN",
  S: "NNWNNNWWN", T: "NNNNWNWWN", U: "WWNNNNNNW", V: "NWWNNNNNW", W: "WWWNNNNNN", X: "NWNNWNNNW",
  Y: "WWNNWNNNN", Z: "NWWNWNNNN", "-": "NWNNNNWNW", ".": "WWNNNNWNN", " ": "NWWNNNNWN",
  $: "NWNWNWNNN", "/": "NWNWNNNWN", "+": "NWNNNWNWN", "%": "NNNWNWNWN", "*": "NWNNWNWNN",
};

function code39Width(text: string, nw: number): number {
  let total = 0;
  for (const ch of `*${text.toUpperCase()}*`) {
    const p = C39[ch] ?? C39["*"];
    for (let i = 0; i < 9; i += 1) total += (p[i] === "W" ? 3 : 1) * nw;
    total += nw;
  }
  return total;
}

function drawCode39(ctx: CanvasRenderingContext2D, x: number, y: number, nw: number, h: number, text: string) {
  const chars = `*${text.toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, "")}*`.split("");
  let cx = x;
  ctx.fillStyle = "#000";
  for (const ch of chars) {
    const pat = C39[ch] ?? C39["*"];
    for (let i = 0; i < 9; i += 1) {
      const w = (pat[i] === "W" ? 3 : 1) * nw;
      if (i % 2 === 0) ctx.fillRect(cx, y, w, h);
      cx += w;
    }
    cx += nw; // inter-character narrow gap
  }
}

/**
 * Renders the hang-tag exactly as it prints. The artwork is locked to a FIXED
 * scale (tied to the RFID tag) so it is identical on both tabs; on the larger
 * 2×3 non-RFID label the same-size artwork is simply centered with a margin.
 */
export function OlaLabelCanvas({
  item,
  media,
  serial,
}: {
  item: OlaPreviewItem | null;
  media: Media;
  serial: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const m = MEDIA[media];
    const dispW = Math.round(m.wCm * PX_PER_CM);
    const dispH = Math.round(m.hCm * PX_PER_CM);
    cv.width = dispW;
    cv.height = dispH;
    ctx.clearRect(0, 0, dispW, dispH);

    // white label stock + physical edge
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, dispW, dispH);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, dispW - 1.5, dispH - 1.5);

    if (!item) {
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '15px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText("Select a SKU", dispW / 2, dispH / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      return;
    }

    // FIXED artwork scale (tied to the RFID tag) → identical on both tabs.
    const rfidW = MEDIA.rfid.wCm * PX_PER_CM;
    const rfidH = MEDIA.rfid.hCm * PX_PER_CM;
    const k = Math.min(rfidW / ART_H, rfidH / ART_W);
    const artW = ART_H * k;
    const artH = ART_W * k;
    const offX = (dispW - artW) / 2;
    const offY = (dispH - artH) / 2;

    ctx.save();
    ctx.translate(offX + artW, offY);
    ctx.rotate(Math.PI / 2);
    ctx.scale(k, k);

    // ^GB grid
    ctx.strokeStyle = "#111";
    const seg = (x: number, y: number, w: number, h: number, t: number) => {
      ctx.lineWidth = Math.max(1, t);
      ctx.beginPath();
      if (w === 0) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
      }
      ctx.stroke();
    };
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 79, 410, 427);
    [83, 207, 266, 325, 387].forEach((x) => seg(x, 80, 0, 425, 3));
    ctx.strokeRect(612, 79, 107, 426);
    seg(783, 57, 0, 477, 3);

    // ^AKB fields — exact ^FT positions, ^AKB heights, ^FB,C centering
    const fld = (
      x: number,
      y: number,
      h: number,
      fbW: number | null,
      txt: string | null | undefined,
      just: "C" | "L",
    ) => {
      if (txt == null || txt === "") return;
      const cy = just === "C" && fbW ? y - fbW / 2 : y;
      ctx.save();
      ctx.translate(x, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#111";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = just === "C" ? "center" : "left";
      ctx.font = `${Math.round(h)}px Arial, "Liberation Sans", "Helvetica Neue", sans-serif`;
      ctx.fillText(String(txt), 0, 0);
      ctx.restore();
    };

    const [l0, l1] = olaDescriptionLines(item.description, item.color, item.size);
    const price = Math.trunc(Number(item.price) || 0);
    fld(73, 490, 38, null, "TALLA/SIZE", "L");
    fld(194, 522, 134, 515, item.size, "C");
    fld(253, 590, 36, 600, item.upc, "C");
    fld(313, 552, 36, 550, l0, "C");
    fld(373, 552, 36, 550, l1, "C");
    fld(432, 552, 36, 550, item.color, "C");
    fld(600, 552, 32, 550, item.sku, "C");
    fld(687, 552, 60, 550, `$${price}`, "C");
    fld(765, 552, 38, 550, item.attr12 ?? "", "C");

    // ^FO455 ^B3B,N,110 Code 39 barcode, bottom-up
    const nw = 2;
    const bh = 110;
    const bcStart = String(item.sku).length === 13 ? 95 : 125;
    const total = code39Width(item.sku, nw);
    ctx.save();
    ctx.translate(455, bcStart + total);
    ctx.rotate(-Math.PI / 2);
    drawCode39(ctx, 0, 0, nw, bh, item.sku);
    ctx.restore();

    ctx.restore();
  }, [item, media, serial]);

  const caption = item
    ? `${MEDIA[media].caption} @ 300 dpi · next serial ${serial}`
    : `${MEDIA[media].caption} (${MEDIA[media].wCm.toFixed(2)} × ${MEDIA[media].hCm.toFixed(2)} cm)`;

  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={ref}
        className="max-w-full rounded-md border border-[var(--wms-border)] bg-white shadow-lg"
        aria-label="Hang-tag label preview"
      />
      <p className="text-center font-mono text-[0.7rem] text-[var(--wms-muted)]">{caption}</p>
    </div>
  );
}
