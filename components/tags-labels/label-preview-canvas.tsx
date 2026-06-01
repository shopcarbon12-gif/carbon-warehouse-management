"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  layoutItemName,
  box8Layout,
  barcodeStartY,
  normalizeSizesColumn,
  inferSizeFromDescription,
  inferColorFromDescription,
  type CarbonTagInput,
} from "@/lib/utils/zpl-carbon-tag";

type Mode = "rfid" | "nonrfid";

/* Design artwork dot-space (the 300-dpi generateCarbonTagZpl layout). Non-RFID
 * reserves extra width on the right for the box icon. */
const ART_H = 624; // ^LL (the "length" / shorter side as fed)
const ART_W: Record<Mode, number> = { rfid: 812, nonrfid: 930 };

/* Physical stock per tab, PORTRAIT (i.e. the tag rotated 90° CW to read
 * upright). Common px/cm so the two tabs show true relative sizes. */
const PX_PER_CM = 66;
const MEDIA: Record<Mode, { caption: string; wCm: number; hCm: number }> = {
  rfid: { caption: "RFID tag · 6.5 × 5 cm · Zebra .3 · 300 dpi", wCm: 5.0, hCm: 6.5 },
  nonrfid: { caption: "Non-RFID tag · 2 × 3 in · Zebra .220 · 203 dpi", wCm: 5.08, hCm: 7.62 },
};

/* Code 39 patterns (visual stand-in for the printed Code 93 — same bar look). */
const C39: Record<string, string> = {
  "0": "NNNWWNWNN", "1": "WNNWNNNNW", "2": "NNWWNNNNW", "3": "WNWWNNNNN", "4": "NNNWWNNNW",
  "5": "WNNWWNNNN", "6": "NNWWWNNNN", "7": "NNNWNNWNW", "8": "WNNWNNWNN", "9": "NNWWNNWNN",
  A: "WNNNNWNNW", B: "NNWNNWNNW", C: "WNWNNWNNN", D: "NNNNWWNNW", E: "WNNNWWNNN", F: "NNWNWWNNN",
  G: "NNNNNWWNW", H: "WNNNNWWNN", I: "NNWNNWWNN", J: "NNNNWWWNN", K: "WNNNNNNWW", L: "NNWNNNNWW",
  M: "WNWNNNNWN", N: "NNNNWNNWW", O: "WNNNWNNWN", P: "NNWNWNNWN", Q: "NNNNNNWWW", R: "WNNNNNWWN",
  S: "NNWNNNWWN", T: "NNNNWNWWN", U: "WWNNNNNNW", V: "NWWNNNNNW", W: "WWWNNNNNN", X: "NWNNWNNNW",
  Y: "WWNNWNNNN", Z: "NWWNWNNNN", "-": "NWNNNNWNW", ".": "WWNNNNWNN", " ": "NWWNNNNWN", "*": "NWNNWNWNN",
};
function drawCode39(ctx: CanvasRenderingContext2D, x: number, y: number, nw: number, h: number, text: string) {
  const chars = `*${text.toUpperCase().replace(/[^0-9A-Z\-. ]/g, "")}*`.split("");
  let cx = x;
  ctx.fillStyle = "#000";
  for (const ch of chars) {
    const pat = C39[ch] ?? C39["*"];
    for (let i = 0; i < 9; i += 1) {
      const w = (pat[i] === "W" ? 3 : 1) * nw;
      if (i % 2 === 0) ctx.fillRect(cx, y, w, h);
      cx += w;
    }
    cx += nw;
  }
}

/**
 * Local canvas render of the Carbon tag — the NEW design with real Arial +
 * Liberation-bold fonts (which Labelary can't load), box icon for non-RFID,
 * rotated 90° CW (vertical) and sized to the true stock (RFID 6.5×5 cm,
 * Non-RFID 2×3 in). The sizes-run is blank in preview (filled at commission).
 */
export function LabelPreviewCanvas({
  input,
  mode,
  serial,
}: {
  input: CarbonTagInput | null;
  mode: Mode;
  serial: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxImg = useRef<HTMLImageElement | null>(null);

  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const m = MEDIA[mode];
    const dispW = Math.round(m.wCm * PX_PER_CM);
    const dispH = Math.round(m.hCm * PX_PER_CM);
    cv.width = dispW;
    cv.height = dispH;
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, dispW, dispH);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, dispW - 1.5, dispH - 1.5);

    if (!input) {
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText("Select a SKU", dispW / 2, dispH / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      return;
    }

    const artW = ART_W[mode];
    // fit the landscape art, rotated 90° CW, into the portrait label
    const k = Math.min(dispW / ART_H, dispH / artW) * 0.97;
    const drawnW = ART_H * k;
    const drawnH = artW * k;
    const offX = (dispW - drawnW) / 2;
    const offY = (dispH - drawnH) / 2;

    ctx.save();
    ctx.translate(offX + drawnW, offY);
    ctx.rotate(Math.PI / 2);
    ctx.scale(k, k);

    // grid
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.strokeRect(15, 86, 410, 427);
    const vline = (x: number, y0: number, y1: number) => {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    };
    [64, 188, 247, 368].forEach((x) => vline(x, 84, 507));
    ctx.lineWidth = 3;
    ctx.strokeRect(593, 86, 107, 426);
    vline(775, 64, 541);

    // rotated, optionally-centered, optionally-bold text field
    const fld = (
      x: number,
      y: number,
      h: number,
      fbW: number | null,
      txt: string,
      just: "C" | "L",
      bold = false,
    ) => {
      if (!txt) return;
      const cy = just === "C" && fbW ? y - fbW / 2 : y;
      ctx.save();
      ctx.translate(x, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#111";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = just === "C" ? "center" : "left";
      ctx.font = `${bold ? "bold " : ""}${Math.round(h)}px Arial, "Liberation Sans", "Helvetica Neue", sans-serif`;
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    };

    const size = (input.size || inferSizeFromDescription(input.itemName) || "").toUpperCase();
    const color = (input.color || inferColorFromDescription(input.itemName, size) || "").toUpperCase();
    const upc = (input.upc || "").toUpperCase();
    const sku = (input.customSku || "").toUpperCase();
    const price = String(Math.trunc(Number.parseFloat(input.retailPrice) || 0));
    const nm = layoutItemName(input.itemName, color, size);
    const sizeRun = normalizeSizesColumn(input.sizesAvailable ?? "");

    fld(54, 497, 38, null, "TALLA/SIZE", "L");
    fld(161, 529, 100, 515, size, "C");
    fld(232, 575, 44, 550, upc, "C", true);
    nm.rows.forEach((r, i) => fld(nm.xs[i], 575, nm.font, 550, r, "C"));
    fld(413, 559, 36, 550, color, "C");

    // barcode + human SKU
    if (sku) {
      const bcY = barcodeStartY(sku);
      ctx.save();
      ctx.translate(436, bcY);
      ctx.rotate(-Math.PI / 2);
      drawCode39(ctx, 0, 0, 2, 112, sku);
      ctx.restore();
    }
    fld(581, 559, 38, 550, sku, "C");
    fld(662, 559, 58, 550, `$${price}`, "C", true);
    if (sizeRun) {
      const b8 = box8Layout(sizeRun);
      fld(b8.x, 567, b8.font, 550, sizeRun, "C");
    }

    // box icon (non-RFID only) — to the right of the ending line, vertically
    // centered; drawn rotated -90° so it reads upright after the 90° CW display.
    if (mode === "nonrfid" && boxImg.current) {
      const S = 150;
      ctx.save();
      ctx.translate(855, 297);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(boxImg.current, -S / 2, -S / 2, S, S);
      ctx.restore();
    }

    ctx.restore();
  }, [input, mode]);

  useEffect(() => {
    if (boxImg.current) {
      draw();
      return;
    }
    const im = new Image();
    im.onload = () => {
      boxImg.current = im;
      draw();
    };
    im.src = "/carbon-box-icon.png";
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw, serial]);

  return (
    <>
      <div className="label-stage">
        <canvas ref={ref} aria-label="Carbon tag preview" />
      </div>
      <div className="dims">
        {MEDIA[mode].caption}
        {input ? ` · next serial ${serial}` : ""}
      </div>
    </>
  );
}
