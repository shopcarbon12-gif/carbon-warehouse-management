"use client";

/**
 * Size Grading — photograph a flat-laid T-shirt, measure it, and grade it
 * against the size chart.
 *
 *   1. Calibrate: tap both ends of a reference of known length in the photo
 *      (an A4 sheet's long edge, a ruler…). Saved on this device, so a fixed
 *      overhead station only calibrates once.
 *   2. Take / upload a photo. The shirt is segmented from the background and
 *      chest width, body length and hem width are measured (lib/size-grading).
 *   3. The measurements are compared against every size in the chart; the
 *      closest size and per-measurement pass/fail are shown.
 *
 * Everything runs in the browser; nothing is uploaded or written to inventory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Crosshair, Loader2, RotateCcw, Ruler, Upload } from "lucide-react";

import { DEFAULT_THRESHOLD, segmentShirt, type Point, type ShirtMask } from "@/lib/size-grading/measure";
import {
  GARMENT_LABELS,
  POMS_FOR,
  POM_LABEL,
  measureGarment,
  type GarmentResult,
  type GarmentType,
  type PomKey,
} from "@/lib/size-grading/garment";
import {
  POMS,
  POM_LABELS,
  SAMPLE_CHART,
  gradeShirt,
  parseChart,
  type Measured,
  type SizeChart,
} from "@/lib/size-grading/size-chart";

/**
 * References whose size is fixed by standard, so staff do not have to measure
 * the thing they calibrate with.
 *
 * US Letter first, because that is the paper in the building — 8.5 × 11 in,
 * exactly 21.59 × 27.94 cm. A4 is not offered: it is not what a Florida
 * warehouse has to hand, and a sheet assumed to be A4 that is actually Letter
 * reads 6% long and quietly inflates every measurement taken afterwards.
 *
 * The bank card stays as the no-paper fallback — ISO/IEC 7810 ID-1 fixes every
 * credit and debit card at 85.60 × 53.98 mm.
 *
 * Ordered by accuracy: the same one-pixel slip when tapping is a smaller share
 * of a longer edge, so the long edge of a sheet beats the short edge of a card
 * by a wide margin.
 */
const CALIB_PRESETS: Array<{ id: string; label: string; cm: number; note: string }> = [
  { id: "letter-long", label: "US Letter — long edge (11 in)", cm: 27.94, note: "most accurate" },
  { id: "letter-short", label: "US Letter — short edge (8.5 in)", cm: 21.59, note: "" },
  { id: "card-long", label: "Bank card — long edge", cm: 8.56, note: "no paper to hand" },
  { id: "card-short", label: "Bank card — short edge", cm: 5.4, note: "least accurate" },
  { id: "custom", label: "Something else…", cm: 0, note: "type the length" },
];

const WORK_MAX_PX = 1000;
const CHART_KEY = "wms.sizeGrading.chart";
/** Calibration stored as px-per-cm divided by working-image width, so it survives resolution changes. */
const CALIB_KEY = "wms.sizeGrading.calibration";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — settings just won't persist */
  }
}

const fmt = (cm: number) => `${cm.toFixed(1)} cm`;
const fmtIn = (cm: number) => `${(cm / 2.54).toFixed(1)}"`;
const signed = (cm: number) => `${cm >= 0 ? "+" : "−"}${Math.abs(cm).toFixed(1)}`;

export function SizeGradingWorkspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<ImageData | null>(null);
  const [chart, setChart] = useState<SizeChart>(SAMPLE_CHART);
  const [calibRatio, setCalibRatio] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [result, setResult] = useState<GarmentResult | null>(null);
  const [mask, setMask] = useState<ShirtMask | null>(null);
  /** Operator's override of the detected garment, when the shape fooled it. */
  const [typeOverride, setTypeOverride] = useState<GarmentType | "">("");
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibPts, setCalibPts] = useState<Point[]>([]);
  const [refLengthCm, setRefLengthCm] = useState("27.94");
  const [calibPreset, setCalibPreset] = useState("letter-long");
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [labeledSize, setLabeledSize] = useState("");
  const [chartOpen, setChartOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChart(parseChart(readLocal(CHART_KEY)));
    const c = Number(readLocal(CALIB_KEY));
    if (Number.isFinite(c) && c > 0) setCalibRatio(c);
  }, []);

  const pxPerCm = image && calibRatio ? calibRatio * image.width : null;

  // Measure whenever the photo, calibration or sensitivity changes.
  useEffect(() => {
    if (!image || !pxPerCm) {
      setResult(null);
      return;
    }
    setBusy(true);
    const id = window.setTimeout(() => {
      const m = segmentShirt(image.data, image.width, image.height, threshold);
      setMask(m);
      setResult(measureGarment(m, pxPerCm, typeOverride || undefined));
      setBusy(false);
    }, 30);
    return () => window.clearTimeout(id);
  }, [image, pxPerCm, threshold, typeOverride]);

  /** The points this garment actually produced, in the family's own order. */
  const readings = useMemo(() => {
    if (!result?.ok) return [];
    return POMS_FOR[result.type]
      .map((k) => ({ key: k, cm: result.points[k]?.cm }))
      .filter((r): r is { key: PomKey; cm: number } => typeof r.cm === "number");
  }, [result]);

  /* The size chart is a tee chart, so grading only applies to a top. Everything
     else is measured and reported — inventing a chart for it would be worse
     than saying nothing. */
  const measured: Measured | null = useMemo(() => {
    if (!result?.ok || result.type !== "top") return null;
    const { chest, length, hem } = result.points;
    if (!chest || !length || !hem) return null;
    return { chest: chest.cm, length: length.cm, hem: hem.cm };
  }, [result]);

  const grade = useMemo(() => (measured ? gradeShirt(measured, chart) : null), [measured, chart]);

  // Draw photo + overlay.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(image, 0, 0);
    const lw = Math.max(2, Math.round(image.width / 250));

    if (mask) {
      const { width, height, data } = mask;
      const tint = ctx.getImageData(0, 0, width, height);
      for (let i = 0; i < data.length; i++) {
        if (!data[i]) continue;
        const p = i * 4;
        tint.data[p] = (tint.data[p] * 0.7 + 34 * 0.3) | 0;
        tint.data[p + 1] = (tint.data[p + 1] * 0.7 + 197 * 0.3) | 0;
        tint.data[p + 2] = (tint.data[p + 2] * 0.7 + 94 * 0.3) | 0;
      }
      ctx.putImageData(tint, 0, 0);
    }
    if (result?.ok) {
      const colors: Partial<Record<PomKey, string>> = {
        chest: "#f59e0b", waist: "#a855f7", hip: "#14b8a6", length: "#3b82f6",
        hem: "#ec4899", shoulder: "#eab308", sleeve: "#f97316",
        inseam: "#22c55e", outseam: "#3b82f6", legOpening: "#ec4899", rise: "#a855f7",
      };
      ctx.font = `bold ${Math.max(14, Math.round(image.width / 40))}px sans-serif`;
      for (const key of POMS_FOR[result.type]) {
        const m = result.points[key];
        if (!m) continue;
        const { a, b } = m.line;
        ctx.strokeStyle = colors[key] ?? "#3b82f6";
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        const label = fmt(m.cm);
        const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
        const lx = vertical ? a.x + lw * 3 : (a.x + b.x) / 2 - ctx.measureText(label).width / 2;
        const ly = vertical ? (a.y + b.y) / 2 : a.y - lw * 3;
        ctx.lineWidth = lw * 2;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, lx, ly);
      }
    }
    if (calibrating) {
      ctx.strokeStyle = "#ef4444";
      ctx.fillStyle = "#ef4444";
      ctx.lineWidth = lw;
      calibPts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, lw * 3, 0, Math.PI * 2);
        ctx.fill();
      });
      if (calibPts.length === 2) {
        ctx.beginPath();
        ctx.moveTo(calibPts[0].x, calibPts[0].y);
        ctx.lineTo(calibPts[1].x, calibPts[1].y);
        ctx.stroke();
      }
    }
  }, [image, result, mask, calibrating, calibPts]);

  /**
   * Open the device's own camera with the settings this measurement needs,
   * rather than handing off to the OS camera app.
   *
   * `<input capture>` opens whatever mode the phone happens to be left in —
   * portrait, a zoomed lens, a filter — and a measurement read off a zoomed or
   * distorted frame is wrong in a way nobody notices. Asking for the stream
   * directly pins the rear camera, the largest resolution the sensor will give,
   * and continuous autofocus, which is what makes the edges crisp enough to
   * segment. The file input stays as a fallback for anything that refuses.
   */
  const openCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1920 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      /* Best-effort: not every device exposes these, and a rejection here must
         not cost us the stream we already have. */
      try {
        const caps = track.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[] };
        const advanced: MediaTrackConstraintSet[] = [];
        if (caps?.focusMode?.includes("continuous")) {
          advanced.push({ focusMode: "continuous" } as MediaTrackConstraintSet);
        }
        if (advanced.length) await track.applyConstraints({ advanced });
      } catch {
        /* keep the stream as-is */
      }
      setCameraOpen(true);
      // The <video> mounts with the panel, so attach on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      });
    } catch {
      setError("Could not open the camera — allow camera access, or use Upload.");
      cameraInputRef.current?.click();
    }
  }, []);

  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
  }, []);

  /* A live camera left running is a hot phone and a privacy light nobody asked
     for — stop it when the page goes away. */
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, WORK_MAX_PX / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      setImage(ctx.getImageData(0, 0, w, h));
      setCalibPts([]);
    } catch {
      setError("Could not read that image.");
    }
  }, []);

  /** Prefer a full-resolution still; fall back to the preview frame. */
  const shoot = useCallback(async () => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!video || !track) return;
    try {
      const Ctor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } })
        .ImageCapture;
      if (Ctor) {
        const blob = await new Ctor(track).takePhoto();
        closeCamera();
        await loadFile(new File([blob], "capture.jpg", { type: blob.type || "image/jpeg" }));
        return;
      }
    } catch {
      /* takePhoto is unsupported or refused — the frame grab below still works */
    }
    const off = document.createElement("canvas");
    off.width = video.videoWidth;
    off.height = video.videoHeight;
    const c = off.getContext("2d");
    if (!c) return;
    c.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => off.toBlob(r, "image/jpeg", 0.95));
    closeCamera();
    if (blob) await loadFile(new File([blob], "capture.jpg", { type: "image/jpeg" }));
  }, [closeCamera, loadFile]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!calibrating || !image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    };
    setCalibPts((pts) => (pts.length >= 2 ? [p] : [...pts, p]));
  };

  const saveCalibration = () => {
    const cm = Number(refLengthCm.replace(",", "."));
    if (!image || calibPts.length !== 2 || !(cm > 0)) return;
    const px = Math.hypot(calibPts[1].x - calibPts[0].x, calibPts[1].y - calibPts[0].y);
    const ratio = px / cm / image.width;
    setCalibRatio(ratio);
    writeLocal(CALIB_KEY, String(ratio));
    setCalibrating(false);
    setCalibPts([]);
  };

  const updateChart = (next: SizeChart) => {
    setChart(next);
    writeLocal(CHART_KEY, JSON.stringify(next));
  };

  const labeledFit = grade?.fits.find((f) => f.size === labeledSize) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          void loadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void loadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => void openCamera()}>
          <Camera className="h-4 w-4" /> Take photo
        </button>
        <button type="button" className="wms-btn-accent-soft inline-flex items-center gap-1.5 max-md:min-h-11" onClick={() => fileInputRef.current?.click()}>
          <Upload className="h-4 w-4" /> Upload
        </button>
        <button
          type="button"
          className="wms-btn-accent-soft inline-flex items-center gap-1.5 max-md:min-h-11"
          disabled={!image}
          onClick={() => {
            setCalibrating((c) => !c);
            setCalibPts([]);
          }}
        >
          <Crosshair className="h-4 w-4" /> {calibrating ? "Cancel calibration" : "Calibrate"}
        </button>
        <span className="font-mono text-xs text-[var(--wms-muted)]">
          {calibRatio ? "Calibrated on this device" : "Not calibrated yet"}
        </span>
      </div>

      {calibrating ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 text-sm text-[var(--wms-fg)]">
          <Ruler className="h-4 w-4 shrink-0 text-[var(--wms-accent)]" />
          <span>Tap both ends of the reference in the photo ({calibPts.length}/2):</span>
          <select
            value={calibPreset}
            onChange={(e) => {
              const id = e.target.value;
              setCalibPreset(id);
              const preset = CALIB_PRESETS.find((p) => p.id === id);
              if (preset && preset.cm > 0) setRefLengthCm(String(preset.cm));
            }}
            className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
          >
            {CALIB_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.cm > 0 ? ` — ${p.cm} cm` : ""}
              </option>
            ))}
          </select>
          {calibPreset === "custom" ? (
            <>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
                value={refLengthCm}
                onChange={(e) => setRefLengthCm(e.target.value)}
                className="w-20 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[var(--wms-fg)] max-md:text-base"
              />
              <span className="font-mono text-xs text-[var(--wms-muted)]">cm</span>
            </>
          ) : (
            <span className="font-mono text-xs text-[var(--wms-muted)]">
              {CALIB_PRESETS.find((p) => p.id === calibPreset)?.note}
            </span>
          )}
          <button
            type="button"
            className="wms-btn-primary wms-btn-sm max-md:min-h-11"
            disabled={calibPts.length !== 2}
            onClick={saveCalibration}
          >
            Save
          </button>
        </div>
      ) : null}

      {error ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{error}</p> : null}

      {cameraOpen ? (
        <div className="min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="block h-auto w-full rounded"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => void shoot()}>
              <Camera className="h-4 w-4" /> Capture
            </button>
            <button type="button" className="wms-btn max-md:min-h-11" onClick={closeCamera}>
              Cancel
            </button>
            <span className="font-mono text-xs text-[var(--wms-muted)]">
              Rear camera, full sensor resolution, continuous focus. Hold the phone level and square above the garment.
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2">
          {image ? (
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              className={`block h-auto w-full ${calibrating ? "cursor-crosshair" : ""}`}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--wms-muted)]">
              <Camera className="h-8 w-8" />
              <p>Lay the garment flat and front up on a plain background that contrasts with it.</p>
              <p>
                Shoot straight down with the whole garment in frame. Sleeves out away from the body; trousers and
                shorts with a clear gap between the legs.
              </p>
              <p>
                To calibrate, lay a sheet of US Letter paper flat beside the garment and tap the two ends of its long
                (11 in) edge. A bank card works when there is no paper, but is less accurate.
              </p>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Result</h2>
            {!image ? (
              <p className="mt-1 text-sm text-[var(--wms-muted)]">Take or upload a photo to start.</p>
            ) : !calibRatio ? (
              <p className="mt-1 text-sm text-[var(--wms-muted)]">Calibrate first (tap Calibrate).</p>
            ) : busy ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-[var(--wms-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Measuring…
              </p>
            ) : result && !result.ok ? (
              <p className="mt-1 text-sm text-[var(--wms-status-danger-fg)]">{result.error}</p>
            ) : result?.ok ? (
              <>
                {/* What it thinks this is, always correctable. A guess shown as
                    a fact is how a wrong measurement reaches the size chart. */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <select
                    value={typeOverride || result.type}
                    onChange={(e) => setTypeOverride(e.target.value as GarmentType)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-medium text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
                  >
                    {(Object.keys(GARMENT_LABELS) as GarmentType[]).map((t) => (
                      <option key={t} value={t}>
                        {GARMENT_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  {typeOverride ? (
                    <button
                      type="button"
                      className="font-mono text-xs text-[var(--wms-accent)] underline"
                      onClick={() => setTypeOverride("")}
                    >
                      use auto
                    </button>
                  ) : (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">
                      detected · {result.classification.why}
                    </span>
                  )}
                </div>
                {!typeOverride && result.classification.confidence < 0.6 ? (
                  <p className="mt-1 text-xs text-[var(--wms-status-warning-fg)]">
                    Not certain of the type — check it above before trusting the numbers.
                  </p>
                ) : null}

                <table className="mt-3 w-full text-sm">
                  <tbody>
                    {readings.map((r) => (
                      <tr key={r.key} className="border-t border-[var(--wms-border)]">
                        <td className="py-1.5 text-[var(--wms-muted)]">{POM_LABEL[r.key]}</td>
                        <td className="py-1.5 text-right font-mono text-[var(--wms-fg)]">{fmtIn(r.cm)}</td>
                        <td className="py-1.5 pl-3 text-right font-mono text-[var(--wms-muted)]">{fmt(r.cm)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  Flat measurements, taken across the garment as it lies — not doubled.
                </p>
              </>
            ) : null}
            {result?.ok && measured && grade?.best ? (
              <div className="mt-4 border-t border-[var(--wms-border)] pt-3">
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold text-[var(--wms-fg)]">{grade.best.size}</span>
                  <span
                    className={`text-sm font-medium ${
                      grade.best.allInTolerance
                        ? "text-[var(--wms-status-success-fg)]"
                        : "text-[var(--wms-status-warning-fg)]"
                    }`}
                  >
                    {grade.best.allInTolerance ? "Within spec" : "Closest size — out of tolerance"}
                  </span>
                </div>
                <table className="mt-3 w-full text-sm">
                  <tbody>
                    {POMS.map((pom) => (
                      <tr key={pom} className="border-t border-[var(--wms-border)]">
                        <td className="py-1.5 text-[var(--wms-muted)]">{POM_LABELS[pom]}</td>
                        <td className="py-1.5 text-right font-mono text-[var(--wms-fg)]">
                          {fmtIn(measured[pom])} <span className="text-[var(--wms-muted)]">{fmt(measured[pom])}</span>
                        </td>
                        <td
                          className={`py-1.5 pl-2 text-right font-mono ${
                            grade.best!.inTolerance[pom]
                              ? "text-[var(--wms-status-success-fg)]"
                              : "text-[var(--wms-status-danger-fg)]"
                          }`}
                        >
                          {signed(grade.best!.diff[pom])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <label className="mt-3 flex items-center gap-2 text-sm text-[var(--wms-fg)]">
                  Labeled size
                  <select
                    value={labeledSize}
                    onChange={(e) => setLabeledSize(e.target.value)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
                  >
                    <option value="">—</option>
                    {chart.sizes.map((s) => (
                      <option key={s.size} value={s.size}>
                        {s.size}
                      </option>
                    ))}
                  </select>
                </label>
                {labeledFit ? (
                  <p
                    className={`mt-2 text-sm font-medium ${
                      labeledFit.allInTolerance
                        ? "text-[var(--wms-status-success-fg)]"
                        : "text-[var(--wms-status-danger-fg)]"
                    }`}
                  >
                    {labeledFit.allInTolerance
                      ? `PASS — measures as a ${labeledFit.size}.`
                      : `FAIL — labeled ${labeledFit.size}, out of tolerance (${POMS.filter(
                          (p) => !labeledFit.inTolerance[p],
                        )
                          .map((p) => `${POM_LABELS[p]} ${signed(labeledFit.diff[p])}`)
                          .join(", ")}).`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {image ? (
            <label className="flex flex-col gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 text-sm text-[var(--wms-fg)]">
              <span>
                Green = what the app thinks the garment is{" "}
                <span className="font-mono text-[var(--wms-muted)]">{threshold}</span>
              </span>
              <input
                type="range"
                min={15}
                max={120}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
              <span className="text-xs text-[var(--wms-muted)]">
                Drag until the green covers the garment and nothing else. Drag LEFT if part of the garment is missing
                (its colour is close to the table); drag RIGHT if shadows or table are green. On good contrast you
                should not need to touch this.
              </span>
            </label>
          ) : null}
        </div>
      </div>

      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        <button
          type="button"
          className="flex w-full items-center justify-between p-3 text-left text-sm font-semibold text-[var(--wms-fg)] max-md:min-h-11"
          onClick={() => setChartOpen((o) => !o)}
        >
          <span>Size chart: {chart.name}</span>
          <span className="text-[var(--wms-muted)]">{chartOpen ? "Hide" : "Edit"}</span>
        </button>
        {chartOpen ? <ChartEditor chart={chart} onChange={updateChart} /> : null}
      </div>
    </div>
  );
}

function ChartEditor({ chart, onChange }: { chart: SizeChart; onChange: (c: SizeChart) => void }) {
  // Number cells are uncontrolled (commit on blur); bump to remount them after a reset.
  const [version, setVersion] = useState(0);
  const num = (v: string) => {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const cell =
    "w-16 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-1 font-mono text-[var(--wms-fg)] max-md:text-base";

  return (
    <div className="overflow-x-auto border-t border-[var(--wms-border)] p-3">
      <p className="mb-2 text-xs text-[var(--wms-muted)]">
        Flat measurements in cm. Saved on this device.
      </p>
      <input
        type="text"
        value={chart.name}
        onChange={(e) => onChange({ ...chart, name: e.target.value })}
        className="mb-3 w-full max-w-md rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-sm text-[var(--wms-fg)] max-md:text-base"
      />
      <table className="text-sm">
        <thead>
          <tr className="text-left text-[var(--wms-muted)]">
            <th className="pr-2 font-medium">Size</th>
            {POMS.map((p) => (
              <th key={p} className="pr-2 font-medium">
                {POM_LABELS[p]}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {chart.sizes.map((s, i) => (
            <tr key={`${version}-${i}`}>
              <td className="py-1 pr-2">
                <input
                  type="text"
                  value={s.size}
                  className={cell}
                  onChange={(e) =>
                    onChange({ ...chart, sizes: chart.sizes.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)) })
                  }
                />
              </td>
              {POMS.map((p) => (
                <td key={p} className="py-1 pr-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={String(s[p])}
                    className={cell}
                    onBlur={(e) =>
                      onChange({
                        ...chart,
                        sizes: chart.sizes.map((x, j) => (j === i ? { ...x, [p]: num(e.target.value) } : x)),
                      })
                    }
                  />
                </td>
              ))}
              <td className="py-1">
                <button
                  type="button"
                  className="text-xs text-[var(--wms-status-danger-fg)] max-md:py-2"
                  disabled={chart.sizes.length <= 1}
                  onClick={() => onChange({ ...chart, sizes: chart.sizes.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          <tr key={`tol-${version}`} className="text-[var(--wms-muted)]">
            <td className="py-1 pr-2 text-xs">± tolerance</td>
            {POMS.map((p) => (
              <td key={p} className="py-1 pr-2">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={String(chart.tolerance[p])}
                  className={cell}
                  onBlur={(e) => onChange({ ...chart, tolerance: { ...chart.tolerance, [p]: num(e.target.value) } })}
                />
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="wms-btn-accent-soft wms-btn-sm inline-flex items-center gap-1.5 max-md:min-h-11"
          onClick={() =>
            onChange({ ...chart, sizes: [...chart.sizes, { size: "New", chest: 0, length: 0, hem: 0 }] })
          }
        >
          Add size
        </button>
        <button
          type="button"
          className="wms-btn-accent-soft wms-btn-sm inline-flex items-center gap-1.5 max-md:min-h-11"
          onClick={() => {
            onChange(SAMPLE_CHART);
            setVersion((v) => v + 1);
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset to sample
        </button>
      </div>
    </div>
  );
}
