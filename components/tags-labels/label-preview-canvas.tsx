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

/* Code 93 — the symbology the tag ZPL actually uses (^BAB). Each character is a
 * 9-module pattern (bar,space,bar,space,bar,space widths); the barcode is
 * *<data><C-check><K-check>* plus a final termination bar. */
const C93_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
const C93_PATTERNS: Record<string, string> = {
  "0": "131112", "1": "111213", "2": "111312", "3": "111411", "4": "121113",
  "5": "121212", "6": "121311", "7": "111114", "8": "131211", "9": "141111",
  A: "211113", B: "211212", C: "211311", D: "221112", E: "221211", F: "231111",
  G: "112113", H: "112212", I: "112311", J: "122112", K: "132111", L: "111123",
  M: "111222", N: "111321", O: "121122", P: "131121", Q: "212112", R: "212211",
  S: "211122", T: "211221", U: "221121", V: "222111", W: "112122", X: "112221",
  Y: "122121", Z: "123111", "-": "121131", ".": "311112", " ": "311211",
  $: "321111", "/": "112131", "+": "113121", "%": "211131", "*": "111141",
};
function c93Sanitize(text: string): string {
  return text.toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, "");
}
function c93Checks(data: string): [string, string] {
  const vals = [...data].map((c) => C93_CHARS.indexOf(c)).filter((v) => v >= 0);
  let sumC = 0;
  for (let i = 0; i < vals.length; i += 1) sumC += (((vals.length - 1 - i) % 20) + 1) * vals[i];
  const c = sumC % 47;
  const vals2 = [...vals, c];
  let sumK = 0;
  for (let i = 0; i < vals2.length; i += 1) sumK += (((vals2.length - 1 - i) % 15) + 1) * vals2[i];
  const k = sumK % 47;
  return [C93_CHARS[c], C93_CHARS[k]];
}
function code93Width(text: string, nw: number): number {
  const data = c93Sanitize(text);
  const [c, k] = c93Checks(data);
  let total = 0;
  for (const ch of `*${data}${c}${k}*`) for (const d of C93_PATTERNS[ch]) total += Number(d) * nw;
  return total + nw; // termination bar
}
function drawCode93(ctx: CanvasRenderingContext2D, x: number, y: number, nw: number, h: number, text: string) {
  const data = c93Sanitize(text);
  const [c, k] = c93Checks(data);
  let cx = x;
  ctx.fillStyle = "#000";
  for (const ch of `*${data}${c}${k}*`) {
    const p = C93_PATTERNS[ch];
    for (let i = 0; i < 6; i += 1) {
      const w = Number(p[i]) * nw;
      if (i % 2 === 0) ctx.fillRect(cx, y, w, h);
      cx += w;
    }
  }
  ctx.fillRect(cx, y, nw, h); // termination bar
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
    // All ^FB,C fields center on the cell cross-axis (the grid box center,
    // (86+513)/2 ≈ 300) — exactly like the printed ^FB,C does. Centering each
    // field at y - fbW/2 instead gave each a different cross-position (the size
    // landed ~28 dots left of the rest), which read as "not centered".
    const CELL_CY = 300;
    const fld = (
      x: number,
      y: number,
      h: number,
      _fbW: number | null,
      txt: string,
      just: "C" | "L",
      bold = false,
    ) => {
      if (!txt) return;
      const cy = just === "C" ? CELL_CY : y;
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
      const total = code93Width(sku, 3); // nw=3 → matches the ZPL ^BY3
      ctx.save();
      // translate to the FAR end + rotate -90° so the bars grow back toward bcY.
      ctx.translate(436, bcY + total);
      ctx.rotate(-Math.PI / 2);
      drawCode93(ctx, 0, 0, 3, 112, sku);
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
