"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScanBarcode } from "lucide-react";

/**
 * Scan a barcode with the phone camera and hand the text back.
 *
 * Two decoders, in order of preference:
 *  1. The CarbonWMS-PC shell — `window.CarbonWMSPC.scanBarcode()` opens Google's
 *     native scanner. Best on the warehouse phones: it focuses fast, reads a
 *     creased hang tag, and needs no camera permission of its own.
 *  2. `BarcodeDetector` in the browser (Chrome / Android, and the app's WebView
 *     when its Chromium is new enough) over a plain getUserMedia preview.
 *
 * Reads both 2D (QR, Data Matrix, PDF417, Aztec) and the 1D symbologies the
 * hang tags use, because a scanner that only did one of them would be a
 * surprise the first time someone pointed it at the wrong label.
 *
 * The button hides itself where neither decoder nor a camera exists, so a
 * desktop without a webcam does not get a dead control.
 */

type NativeScan = { ok: boolean; message: string };
type BridgeWindow = Window & {
  CarbonWMSPC?: { scanBarcode?: () => Promise<NativeScan> };
  BarcodeDetector?: BarcodeDetectorCtor;
};
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorCtor = {
  new (opts?: { formats?: string[] }): { detect: (src: CanvasImageSource) => Promise<DetectedBarcode[]> };
  getSupportedFormats?: () => Promise<string[]>;
};

/** Everything a Carbon tag or a supplier label might carry. */
const WANTED_FORMATS = [
  "qr_code",
  "data_matrix",
  "pdf417",
  "aztec",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "ean_13",
  "ean_8",
  "itf",
  "upc_a",
  "upc_e",
];

export function BarcodeScanButton({
  onScan,
  title = "Scan a barcode with the camera",
  className,
}: {
  onScan: (text: string) => void;
  title?: string;
  className?: string;
}) {
  /** Resolved on the client only — `window` must not be read during render. */
  const [mode, setMode] = useState<"none" | "native" | "web">("none");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    const w = window as BridgeWindow;
    if (typeof w.CarbonWMSPC?.scanBarcode === "function") return setMode("native");
    const hasCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    if (hasCamera && typeof w.BarcodeDetector === "function") return setMode("web");
    setMode("none");
  }, []);

  const closeWeb = useCallback(() => {
    stopRef.current = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setOpen(false);
  }, []);

  /** Camera preview + decode loop. Stops at the first read. */
  useEffect(() => {
    if (!open) return;
    stopRef.current = false;
    let raf = 0;
    void (async () => {
      try {
        const w = window as BridgeWindow;
        const Ctor = w.BarcodeDetector;
        if (!Ctor) throw new Error("This browser cannot decode barcodes — use the CarbonWMS app.");
        const supported = (await Ctor.getSupportedFormats?.().catch(() => [])) ?? [];
        const formats = supported.length ? WANTED_FORMATS.filter((f) => supported.includes(f)) : WANTED_FORMATS;
        const detector = new Ctor(formats.length ? { formats } : undefined);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
        const tick = async () => {
          if (stopRef.current) return;
          const vid = videoRef.current;
          if (vid && vid.readyState >= 2) {
            try {
              const hits = await detector.detect(vid);
              const text = hits.find((h) => String(h.rawValue || "").trim())?.rawValue?.trim();
              if (text) {
                onScan(text);
                closeWeb();
                return;
              }
            } catch {
              /* a frame that could not be analysed — try the next one */
            }
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not start the camera.");
      }
    })();
    return () => {
      stopRef.current = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, onScan, closeWeb]);

  const start = useCallback(async () => {
    setErr(null);
    if (mode === "native") {
      setBusy(true);
      try {
        const r = await (window as BridgeWindow).CarbonWMSPC!.scanBarcode!();
        const text = String(r?.message || "").trim();
        if (r?.ok && text) onScan(text);
        else if (r && !r.ok && text) setErr(text); // the shell explains why (cancelled, unavailable…)
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Scan failed.");
      } finally {
        setBusy(false);
      }
      return;
    }
    setOpen(true);
  }, [mode, onScan]);

  if (mode === "none") return null;

  return (
    <>
      {/* Icon only, and `relative` so a failure message can hang beneath it
          instead of widening the search row it shares. */}
      <span className="relative inline-flex shrink-0">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy}
          title={title}
          aria-label={title}
          className={
            className ??
            "inline-flex items-center justify-center rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2.5 py-2 text-[var(--wms-accent)] hover:bg-[var(--wms-surface)] disabled:opacity-50 max-md:min-h-11 max-md:min-w-11"
          }
        >
          <ScanBarcode className={`h-[18px] w-[18px] ${busy ? "animate-pulse" : ""}`} aria-hidden="true" />
        </button>
        {err ? (
          <span
            role="status"
            className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-[var(--wms-status-danger-fg)]/40 bg-[var(--wms-surface)] px-2 py-1 font-mono text-[0.7rem] leading-snug text-[var(--wms-status-danger-fg)] shadow-md"
          >
            {err}
          </span>
        ) : null}
      </span>

      {open ? (
        <div className="fixed inset-0 z-[130] flex flex-col items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Scan a barcode">
          <video
            ref={videoRef}
            playsInline
            muted
            className="max-h-[70vh] w-full max-w-md rounded-lg border border-white/20 bg-black object-cover"
          />
          <p className="mt-3 text-center font-mono text-xs text-white/85">
            Point the camera at the barcode — it reads automatically.
          </p>
          <button
            type="button"
            onClick={closeWeb}
            className="mt-3 min-h-11 rounded-md border border-white/30 bg-white/10 px-5 py-2 font-mono text-sm text-white"
          >
            ✕ Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}
