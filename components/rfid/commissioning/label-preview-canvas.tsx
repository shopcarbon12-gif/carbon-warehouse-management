"use client";

import { useEffect, useRef } from "react";

export type LabelPreviewProps = {
  widthDots: number;
  heightDots: number;
  /** CSS max width; height follows aspect ratio */
  maxDisplayWidth?: number;
  sku: string;
  upc: string;
  description: string;
  /** 24-char hex sample EPC */
  epc: string;
  systemId: string;
  companyPrefix: number;
  itemRefBits: number;
  serialBits: number;
};

export function LabelPreviewCanvas({
  widthDots,
  heightDots,
  maxDisplayWidth = 380,
  sku,
  upc,
  description,
  epc,
  systemId,
  companyPrefix,
  itemRefBits,
  serialBits,
}: LabelPreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const aspect = heightDots / widthDots;
    const dw = Math.min(maxDisplayWidth, widthDots);
    const dh = Math.round(dw * aspect);
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, dw, dh);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, dw - 2, dh - 2);

    const pad = Math.max(8, dw * 0.04);
    ctx.fillStyle = "#0f172a";
    ctx.font = `600 ${Math.max(11, dw * 0.035)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillText("CARBON WMS", pad, pad + 12);

    ctx.fillStyle = "#334155";
    ctx.font = `${Math.max(9, dw * 0.028)}px "JetBrains Mono", ui-monospace, monospace`;
    let y = pad + 28;
    const line = (label: string, value: string) => {
      ctx.fillStyle = "#64748b";
      ctx.fillText(label, pad, y);
      y += 14;
      ctx.fillStyle = "#0f172a";
      const maxW = dw - pad * 2;
      const short =
        ctx.measureText(value).width > maxW
          ? value.slice(0, Math.floor(value.length * 0.85)) + "…"
          : value;
      ctx.fillText(short, pad, y);
      y += 18;
    };

    line("SKU", sku || "—");
    line("UPC / EAN", upc || "—");
    line("Description", description || "—");
    line("System ID", systemId || "—");
    line(
      "Encoding",
      `CP ${companyPrefix} (${itemRefBits}+${serialBits} bit layout)`,
    );

    y += 6;
    ctx.fillStyle = "#0d9488";
    ctx.font = `600 ${Math.max(10, dw * 0.032)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillText("EPC (96-bit hex)", pad, y);
    y += 16;
    ctx.fillStyle = "#134e4a";
    const epcChunks = epc.match(/.{1,8}/g) ?? [epc];
    ctx.font = `${Math.max(9, dw * 0.026)}px "JetBrains Mono", ui-monospace, monospace`;
    for (const chunk of epcChunks) {
      ctx.fillText(chunk, pad, y);
      y += 13;
    }

    const barH = Math.max(18, dh * 0.08);
    const barY = dh - pad - barH;
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(pad, barY, dw - pad * 2, barH);
    ctx.fillStyle = "#0f172a";
    for (let i = 0; i < 48; i += 1) {
      const w = ((dw - pad * 2) / 48) * 0.7;
      const x = pad + (i * (dw - pad * 2)) / 48;
      const h = barH * (0.35 + (i % 5) * 0.12);
      ctx.fillRect(x, barY + barH - h, w, h);
    }
    ctx.fillStyle = "#64748b";
    ctx.font = `${Math.max(8, dw * 0.022)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillText("(barcode placeholder)", pad, barY - 4);

    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "right";
    ctx.font = `${Math.max(7, dw * 0.02)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillText(`${widthDots} × ${heightDots} dots`, dw - pad, dh - 6);
    ctx.textAlign = "left";
  }, [
    widthDots,
    heightDots,
    maxDisplayWidth,
    sku,
    upc,
    description,
    epc,
    systemId,
    companyPrefix,
    itemRefBits,
    serialBits,
  ]);

  return (
    <canvas
      ref={ref}
      className="mx-auto rounded border border-[var(--wms-border)] bg-white shadow-lg"
      aria-label="RFID label preview"
    />
  );
}
