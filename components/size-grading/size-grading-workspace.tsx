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

import { DEFAULT_THRESHOLD, measureShirt, type MeasureResult, type Point } from "@/lib/size-grading/measure";
import {
  POMS,
  POM_LABELS,
  SAMPLE_CHART,
  gradeShirt,
  parseChart,
  type Measured,
  type Pom,
  type SizeChart,
} from "@/lib/size-grading/size-chart";

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
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibPts, setCalibPts] = useState<Point[]>([]);
  const [refLengthCm, setRefLengthCm] = useState("29.7");
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
      setResult(measureShirt(image.data, image.width, image.height, pxPerCm, threshold));
      setBusy(false);
    }, 30);
    return () => window.clearTimeout(id);
  }, [image, pxPerCm, threshold]);

  const measured: Measured | null = useMemo(() => {
    if (!result?.ok || !pxPerCm) return null;
    return {
      chest: result.px.chest / pxPerCm,
      length: result.px.length / pxPerCm,
      hem: result.px.hem / pxPerCm,
    };
  }, [result, pxPerCm]);

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

    if (result?.mask) {
      const { width, height, data } = result.mask;
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
    if (result?.ok && measured) {
      const colors: Record<Pom, string> = { chest: "#f59e0b", length: "#3b82f6", hem: "#ec4899" };
      ctx.font = `bold ${Math.max(14, Math.round(image.width / 40))}px sans-serif`;
      for (const pom of POMS) {
        const { a, b } = result.px.lines[pom];
        ctx.strokeStyle = colors[pom];
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        const label = fmt(measured[pom]);
        const lx = pom === "length" ? a.x + lw * 3 : (a.x + b.x) / 2 - ctx.measureText(label).width / 2;
        const ly = pom === "length" ? (a.y + b.y) / 2 : a.y - lw * 3;
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
  }, [image, result, measured, calibrating, calibPts]);

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
        <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => cameraInputRef.current?.click()}>
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
          <span>
            Tap both ends of the reference in the photo ({calibPts.length}/2), then enter its real length:
          </span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            value={refLengthCm}
            onChange={(e) => setRefLengthCm(e.target.value)}
            className="w-20 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[var(--wms-fg)] max-md:text-base"
          />
          <span className="font-mono text-xs text-[var(--wms-muted)]">cm (A4 long edge = 29.7)</span>
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
              <p>Lay the shirt flat, front up, collar at the top, on a plain contrasting background.</p>
              <p>Shoot straight down with the whole shirt in frame, and keep the sleeves away from the body.</p>
              <p>For calibration, place an A4 sheet or ruler beside the shirt.</p>
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
            ) : measured && grade?.best ? (
              <>
                <div className="mt-2 flex items-baseline gap-3">
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
                          {fmt(measured[pom])} <span className="text-[var(--wms-muted)]">({fmtIn(measured[pom])})</span>
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
              </>
            ) : null}
          </div>

          {image ? (
            <label className="flex flex-col gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 text-sm text-[var(--wms-fg)]">
              <span>
                Background sensitivity <span className="font-mono text-[var(--wms-muted)]">{threshold}</span>
              </span>
              <input
                type="range"
                min={15}
                max={120}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
              <span className="text-xs text-[var(--wms-muted)]">
                Lower it if parts of the shirt are missing from the green area; raise it if shadows or background are
                included.
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
