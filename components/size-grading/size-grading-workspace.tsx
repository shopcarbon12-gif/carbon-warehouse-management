"use client";

/**
 * Size Grading — photograph a flat-laid T-shirt, measure it, and grade it
 * against the size chart.
 *
 *   1. Calibrate: tap both ends of a reference of known length in the photo
 *      (an A4 sheet's long edge, a ruler…). Saved on this device, so a fixed
 *      overhead station only calibrates once.
 *   2. Take / upload a photo. On a phone the camera opens; on a PC a QR code
 *      appears, and the phone that scans it sends its photo back to the page.
 *      The garment is segmented from the background and measured per family
 *      (lib/size-grading).
 *   3. The measurements are compared against every size in the chart; the
 *      closest size and per-measurement pass/fail are shown.
 *
 * Everything runs in the browser; nothing is uploaded or written to inventory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Crosshair, Loader2, RotateCcw, Ruler, Save, Smartphone, Upload } from "lucide-react";

import { ItemPicker, type PickedItem, type PickedSize } from "./item-picker";

import { autoSeedTolerance, segmentFromSeed, type Point, type ShirtMask } from "@/lib/size-grading/measure";
import { focusReading, type FocusReading } from "@/lib/size-grading/sharpness";
import { familyForCategory } from "@/lib/size-grading/catalog-family";
import { detectTarget, rectify, type Quad, type TargetDetection } from "@/lib/size-grading/target";
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
/** The photo is kept this big for target detection and un-warping. */
const SRC_MAX_PX = 1800;
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

/**
 * Can the device in front of the operator actually take this photo?
 *
 * Not "does it have a camera" — a laptop has one, and it is bolted to a screen
 * hinge pointing at whoever is sitting there. This photo has to be taken
 * straight down over a garment lying flat, so the real question is whether the
 * thing can be picked up and aimed at a table, and the only honest signal a
 * browser gives for that is a coarse pointer: a touchscreen. Everything else
 * gets the phone hand-off instead of a camera that cannot see the garment.
 */
async function canShootHere(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(any-pointer: coarse)").matches !== true) return false;
  // A touchscreen with no camera — a wall panel, a kiosk — still cannot do it.
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    if (devices && !devices.some((d) => d.kind === "videoinput")) return false;
  } catch {
    /* the device refused to enumerate — trust the touchscreen */
  }
  return true;
}

/** The box the mask occupies — where focus actually has to be good. */
function maskBounds(mask: ShirtMask) {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[y * mask.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const fmt = (cm: number) => `${cm.toFixed(1)} cm`;
const fmtIn = (cm: number) => `${(cm / 2.54).toFixed(1)}"`;
const signed = (cm: number) => `${cm >= 0 ? "+" : "−"}${Math.abs(cm).toFixed(1)}`;

export function SizeGradingWorkspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The photo as decoded, before any un-warping — what rectify samples from. */
  const srcRef = useRef<ImageData | null>(null);

  const [image, setImage] = useState<ImageData | null>(null);
  const [chart, setChart] = useState<SizeChart>(SAMPLE_CHART);
  const [calibRatio, setCalibRatio] = useState<number | null>(null);
  /** null = chosen from the photo itself; a number = the operator took over. */
  const [threshold, setThreshold] = useState<number | null>(null);
  const [autoT, setAutoT] = useState(48);
  /** Where the garment is. Starts at the centre of the frame; the operator
   *  moves it by tapping, which is the only reliable way to say which of the
   *  things in a warehouse photo is the one being measured. */
  const [seed, setSeed] = useState<Point>({ x: 0, y: 0 });
  const [tapped, setTapped] = useState(false);
  const [result, setResult] = useState<GarmentResult | null>(null);
  const [mask, setMask] = useState<ShirtMask | null>(null);
  /** How sharp the garment is in this photo, and whether it can be trusted. */
  const [focus, setFocus] = useState<FocusReading | null>(null);
  /** The operator has seen the softness warning and wants to save regardless. */
  const [allowSoft, setAllowSoft] = useState(false);
  /** Operator's override of the detected garment, when the shape fooled it. */
  const [typeOverride, setTypeOverride] = useState<GarmentType | "">("");
  /** What the catalogue says this product is — better than reading the shape. */
  const [catalogueType, setCatalogueType] = useState<GarmentType | null>(null);
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibPts, setCalibPts] = useState<Point[]>([]);
  const [refLengthCm, setRefLengthCm] = useState("27.94");
  const [calibPreset, setCalibPreset] = useState("letter-long");
  /* The printed target, found in this photo. When it is there, it supplies the
     scale AND squares the photo up, so no calibration is involved at all. */
  const [target, setTarget] = useState<TargetDetection | null>(null);
  /** Exact px-per-cm of the un-warped image, by construction. */
  const [rectPxPerCm, setRectPxPerCm] = useState<number | null>(null);
  /** Corners the operator tapped, when detection missed. */
  const [cornerTaps, setCornerTaps] = useState<Point[]>([]);
  const [tappingCorners, setTappingCorners] = useState(false);
  /* Front and back are two measurements of the same garment. The operator
     shoots one, saves it, flips the garment and shoots the other; the side is
     stored with the reading so a back rise is never filed as a front rise. */
  const [view, setView] = useState<"front" | "back">("front");
  const [pickedItem, setPickedItem] = useState<PickedItem | null>(null);
  const [pickedSize, setPickedSize] = useState<PickedSize | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  /** The QR hand-off, while it is on screen and being waited on. */
  const [handoff, setHandoff] = useState<{
    sessionId: string;
    scanUrl: string;
    qrCodeUrl: string;
  } | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  /** Null until the stream is open; false when the device gives us no focus control. */
  const [canFocus, setCanFocus] = useState<boolean | null>(null);
  const [focusing, setFocusing] = useState(false);
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

  /* An un-warped image's scale is exact by construction, so it always wins over
     a calibration someone tapped in once on a different photo. */
  const pxPerCm = rectPxPerCm ?? (image && calibRatio ? calibRatio * image.width : null);

  // Measure whenever the photo, calibration or sensitivity changes.
  useEffect(() => {
    if (!image || !pxPerCm) {
      setResult(null);
      return;
    }
    setBusy(true);
    const id = window.setTimeout(() => {
      const t = threshold ?? autoT;
      const m = segmentFromSeed(image.data, image.width, image.height, seed, t);
      setMask(m);
      setResult(measureGarment(m, pxPerCm, typeOverride || undefined));
      /* Focus is judged over the garment, not the frame: a sharp table behind a
         blurred garment is still a measurement of a blur. */
      const box = maskBounds(m);
      setFocus(focusReading(image.data, image.width, image.height, box ?? undefined));
      setBusy(false);
    }, 30);
    return () => window.clearTimeout(id);
  }, [image, pxPerCm, threshold, autoT, seed, typeOverride]);

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
    if (!calibrating && !tappingCorners && image) {
      // Where the green is growing from — so a wrong mask is obvious at a glance.
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(seed.x, seed.y, lw * 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(seed.x - lw * 9, seed.y);
      ctx.lineTo(seed.x + lw * 9, seed.y);
      ctx.moveTo(seed.x, seed.y - lw * 9);
      ctx.lineTo(seed.x, seed.y + lw * 9);
      ctx.stroke();
    }
    if (tappingCorners || cornerTaps.length) {
      // The corners tapped so far, numbered, so a mis-tap is obvious.
      ctx.fillStyle = "#38bdf8";
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = lw;
      ctx.font = `bold ${Math.max(14, Math.round(image.width / 36))}px sans-serif`;
      cornerTaps.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, lw * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeText(String(i + 1), p.x + lw * 6, p.y - lw * 3);
        ctx.fillText(String(i + 1), p.x + lw * 6, p.y - lw * 3);
      });
      if (cornerTaps.length > 1) {
        ctx.beginPath();
        ctx.moveTo(cornerTaps[0].x, cornerTaps[0].y);
        for (const p of cornerTaps.slice(1)) ctx.lineTo(p.x, p.y);
        if (cornerTaps.length === 4) ctx.closePath();
        ctx.stroke();
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
  }, [image, result, mask, calibrating, calibPts, seed, tappingCorners, cornerTaps]);

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
        const modes = caps?.focusMode ?? [];
        setCanFocus(modes.length > 0);
        if (modes.includes("continuous")) {
          await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] });
        }
      } catch {
        setCanFocus(false);
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

  /**
   * Focus on the point the operator tapped.
   *
   * Continuous autofocus alone is not enough: pointed at a plain table it has
   * nothing to lock onto and happily settles on the floor or the far wall, and
   * a flat garment photographed out of focus has soft edges — which is the
   * segmentation reading a blurred boundary and the measurement drifting by a
   * centimetre or two. A tap gives it something to focus on.
   */
  const focusAt = useCallback(async (xNorm: number, yNorm: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    setFocusing(true);
    try {
      const caps = track.getCapabilities?.() as MediaTrackCapabilities & {
        focusMode?: string[];
        pointsOfInterest?: unknown;
      };
      const advanced: MediaTrackConstraintSet[] = [];
      if (caps?.pointsOfInterest) {
        advanced.push({ pointsOfInterest: [{ x: xNorm, y: yNorm }] } as unknown as MediaTrackConstraintSet);
      }
      const modes = caps?.focusMode ?? [];
      if (modes.includes("single-shot")) advanced.push({ focusMode: "single-shot" } as MediaTrackConstraintSet);
      else if (modes.includes("continuous")) advanced.push({ focusMode: "continuous" } as MediaTrackConstraintSet);
      if (advanced.length) await track.applyConstraints({ advanced });
    } catch {
      /* the device refused — the preview is still usable */
    }
    window.setTimeout(() => setFocusing(false), 700);
  }, []);

  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
    setCanFocus(null);
  }, []);

  /* A live camera left running is a hot phone and a privacy light nobody asked
     for — stop it when the page goes away. */
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  /**
   * Turn a photo into the image everything downstream measures.
   *
   * If the printed target is in the frame, this is where the photo stops being
   * a photograph and becomes a measurement: its four corners give both the
   * scale and the orientation of the surface, so the image is re-rendered as if
   * shot from straight above, at an exact and known number of pixels per
   * centimetre. Calibration and the two taps are then not merely optional, they
   * are meaningless — there is nothing left to estimate.
   *
   * Without the target it falls back to the old path: the photo as taken, with
   * whatever scale was calibrated on this device, and no tilt correction.
   */
  const applySource = useCallback((src: ImageData, quad?: Quad) => {
    const det = quad ? null : detectTarget(src.data, src.width, src.height);
    const useQuad = quad ?? (det && det.confidence >= 0.3 ? det.quad : null);

    if (useQuad) {
      const rect = rectify(src.data, src.width, src.height, useQuad, { maxPx: 1400, aroundCm: 60 });
      if (rect) {
        /* new ImageData(...) rejects a Uint8ClampedArray whose buffer type is
           not narrowed to ArrayBuffer, so the pixels are copied into one the
           constructor will take. */
        const data = new ImageData(rect.width, rect.height);
        data.data.set(rect.data);
        setImage(data);
        setRectPxPerCm(rect.pxPerCm);
        setTarget(det ?? { quad: useQuad, confidence: 1, tiltPercent: 0 });
        const centre = { x: rect.width / 2, y: rect.height / 2 };
        setSeed(centre);
        setTapped(false);
        setAutoT(autoSeedTolerance(data.data, rect.width, rect.height, centre));
        return;
      }
    }

    // No target: the photo as taken, scaled to the working size.
    const scale = Math.min(1, WORK_MAX_PX / Math.max(src.width, src.height));
    let data = src;
    if (scale < 1) {
      const w = Math.round(src.width * scale);
      const h = Math.round(src.height * scale);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (ctx) {
        const tmp = document.createElement("canvas");
        tmp.width = src.width;
        tmp.height = src.height;
        tmp.getContext("2d")?.putImageData(src, 0, 0);
        ctx.drawImage(tmp, 0, 0, w, h);
        data = ctx.getImageData(0, 0, w, h);
      }
    }
    setImage(data);
    setRectPxPerCm(null);
    setTarget(null);
    const centre = { x: data.width / 2, y: data.height / 2 };
    setSeed(centre);
    setTapped(false);
    setAutoT(autoSeedTolerance(data.data, data.width, data.height, centre));
  }, []);

  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setHandoffNote(null);
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      /* Decoded larger than the working image: the target is detected and the
         un-warping sampled from THIS, so throwing resolution away first would
         cost corner precision, which is the dominant error in the result. */
      const scale = Math.min(1, SRC_MAX_PX / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const src = ctx.getImageData(0, 0, w, h);
      srcRef.current = src;
      setThreshold(null);
      setCalibPts([]);
      setCornerTaps([]);
      setTappingCorners(false);
      setSavedAt(null);
      setFocus(null);
      setAllowSoft(false);
      applySource(src);
    } catch {
      setError("Could not read that image.");
    }
  }, [applySource]);

  /**
   * PC → phone hand-off.
   *
   * On a desktop there is nothing to point at the garment, so "Take photo"
   * puts a QR code on screen instead. Scanning it opens the phone's camera on
   * /image-upload/<session>; the photo taken there comes straight back to this
   * screen and is measured exactly as if it had been taken here.
   *
   * It is the hand-off Carbon Studio already uses for product photos — the
   * same session table, the same phone page, the same upload route — rather
   * than a second one to keep working. The session is tagged with the picked
   * item when there is one, so the photo is traceable to what it measured.
   */
  const startHandoff = useCallback(async () => {
    setError(null);
    setHandoffNote(null);
    try {
      const r = await fetch("/api/image-handoff/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId: pickedItem?.matrixId ?? null, purpose: "size-grading" }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        sessionId?: string;
        scanUrl?: string;
        qrCodeUrl?: string;
        error?: string;
      };
      if (!r.ok || !j.sessionId || !j.qrCodeUrl) {
        throw new Error(j.error ?? "Could not start a phone session.");
      }
      setHandoff({ sessionId: j.sessionId, scanUrl: j.scanUrl ?? "", qrCodeUrl: j.qrCodeUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start a phone session.");
    }
  }, [pickedItem]);

  /* While the QR is up, watch the session for the phone's photo. Polling is
     also what tells the phone a desktop is listening, so it can warn the
     operator if this page was closed. */
  useEffect(() => {
    const sessionId = handoff?.sessionId;
    if (!sessionId) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}`, {
          cache: "no-store",
        });
        if (r.status === 404) {
          if (alive) {
            setHandoff(null);
            setError("That phone session expired — tap Take photo again.");
          }
          return;
        }
        const j = (await r.json().catch(() => ({}))) as { ready?: boolean; images?: { imageId: string }[] };
        const batch = j.ready ? (j.images ?? []) : [];
        const last = batch[batch.length - 1];
        if (last) {
          /* Through our own proxy, not the stored URL: the bucket needs
             credentials the browser does not have, and a cross-origin image
             taints the canvas that every pixel of this measurement is read
             from — which is a silent failure, not an error. */
          const img = await fetch(
            `/api/image-handoff/image?s=${encodeURIComponent(sessionId)}&i=${encodeURIComponent(last.imageId)}`,
            { cache: "no-store" },
          );
          if (!img.ok) throw new Error("photo unavailable");
          const blob = await img.blob();
          if (!alive) return;
          setHandoff(null);
          await loadFile(new File([blob], "phone.jpg", { type: blob.type || "image/jpeg" }));
          // The phone can send a burst; one garment needs one photo, so the
          // last one wins and the operator is told that is what happened.
          // Set after loading, which clears the note of the previous photo.
          if (alive && batch.length > 1) {
            setHandoffNote(`Measuring the last of the ${batch.length} photos the phone sent.`);
          }
          return;
        }
      } catch {
        /* a dropped poll is not a failure — the next one picks it up */
      }
      if (alive) timer = window.setTimeout(tick, 2000);
    };
    timer = window.setTimeout(tick, 1200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [handoff?.sessionId, loadFile]);

  /** The phone's own camera where there is one to hold up, the QR where not. */
  const takePhoto = useCallback(async () => {
    setError(null);
    if (await canShootHere()) {
      cameraInputRef.current?.click();
      return;
    }
    await startHandoff();
  }, [startHandoff]);

  /** Prefer a full-resolution still; fall back to the preview frame. */
  const shoot = useCallback(async () => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!video || !track) return;
    /* Give autofocus a moment to settle before the shutter — capturing the
       instant the button is pressed is how a soft frame gets measured. */
    await focusAt(0.5, 0.5);
    await new Promise((r) => setTimeout(r, 650));
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
  }, [closeCamera, loadFile, focusAt]);

  /* When an item is picked, start on the family the catalogue already knows.
     The silhouette is the fallback, not the first answer, and this is also what
     stops a pair of evening pants being measured as a shirt. */
  useEffect(() => {
    const guess = familyForCategory(pickedItem?.category, pickedItem?.subcategory);
    const t = guess?.kind === "garment" ? guess.type : null;
    setCatalogueType(t);
    if (t) setTypeOverride(t);
  }, [pickedItem]);

  const saveToItem = useCallback(async () => {
    if (!pickedSize || !result?.ok) return;
    const pointsCm: Record<string, number> = {};
    for (const [k, v] of Object.entries(result.points)) {
      if (v) pointsCm[k] = Number(v.cm.toFixed(2));
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/inventory/size-grading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customSkuId: pickedSize.customSkuId,
          garmentType: result.type,
          pointsCm,
          pxPerCm: pxPerCm ?? undefined,
          typeOverridden: Boolean(typeOverride),
          view,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; measuredAt?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? "Could not save");
      setSavedAt(j.measuredAt ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [pickedSize, result, pxPerCm, typeOverride, view]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    };
    if (tappingCorners) {
      /* Four taps, clockwise from the target's top-left, rectify from the
         original photo. The fallback exists because detection on a dark floor
         under bad light will miss sometimes, and "it did not work" is not an
         acceptable end state when the operator can see the corners perfectly
         well. */
      const next = cornerTaps.length >= 4 ? [p] : [...cornerTaps, p];
      setCornerTaps(next);
      if (next.length === 4 && srcRef.current) {
        const src = srcRef.current;
        /* Taps are in working-image coordinates; the source is bigger. */
        const kx = src.width / image.width;
        const ky = src.height / image.height;
        const quad = next.map((q) => ({ x: q.x * kx, y: q.y * ky })) as Quad;
        setTappingCorners(false);
        applySource(src, quad);
      }
      return;
    }
    if (calibrating) {
      setCalibPts((pts) => (pts.length >= 2 ? [p] : [...pts, p]));
      return;
    }
    /* Not calibrating: the tap says which garment is being measured, and the
       tolerance is re-read from the fabric around it. */
    setSeed(p);
    setTapped(true);
    setAutoT(autoSeedTolerance(image.data, image.width, image.height, p));
    setThreshold(null);
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
      <ItemPicker item={pickedItem} size={pickedSize} onPick={setPickedItem} onPickSize={setPickedSize} />

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

      {/* Which side is in front of the operator. Both sides are measured and
          stored separately: the back rise of a pair of trousers is a different
          number from the front rise, and on a top the pair is a free
          cross-check — the two should agree within a few millimetres. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wide text-[var(--wms-muted)]">Side</span>
        <div className="inline-flex overflow-hidden rounded border border-[var(--wms-border)]">
          {(["front", "back"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm capitalize max-md:min-h-11 ${
                view === v
                  ? "bg-[var(--wms-accent)] font-semibold text-[var(--wms-on-accent,#0c0f12)]"
                  : "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs text-[var(--wms-muted)]">
          {view === "front"
            ? "Lay the garment front up."
            : "Turn the garment over — back up, same flat surface."}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* The phone's own camera app first. It focuses; the in-page stream on
            at least one Android here does not, and a soft photo measures wrong
            without ever looking wrong. The live preview stays for devices that
            do expose focus control. On a PC the same button hands off to a
            phone by QR, because there is no camera here that can see a garment
            on the table. */}
        <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => void takePhoto()}>
          <Camera className="h-4 w-4" /> Take photo
        </button>
        <button type="button" className="wms-btn max-md:min-h-11" onClick={() => void openCamera()}>
          Live preview
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
          <Crosshair className="h-4 w-4" /> {calibrating ? "Cancel calibration" : "Calibrate by hand"}
        </button>
        <span className="font-mono text-xs text-[var(--wms-muted)]">
          {rectPxPerCm
            ? "Target found — scale exact, tilt corrected"
            : calibRatio
              ? "No target in this photo — using the saved calibration"
              : "No target, not calibrated"}
        </span>
        <a href="/inventory/size-grading/target" className="wms-btn wms-btn-sm max-md:min-h-11" target="_blank" rel="noreferrer">
          Print target
        </a>
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

      {image ? (
        <div
          className={`rounded-md border p-2 text-sm ${
            rectPxPerCm
              ? "border-[var(--wms-status-success-fg)]/40 bg-[var(--wms-status-success-fg)]/10"
              : "border-[var(--wms-status-warning-fg)]/40 bg-[var(--wms-status-warning-fg)]/10"
          }`}
        >
          {rectPxPerCm ? (
            <>
              <p className="text-[var(--wms-fg)]">
                Calibration target found. This photo has been squared up and measures{" "}
                <span className="font-mono">{rectPxPerCm.toFixed(1)} px/cm</span> exactly — no calibration needed.
              </p>
              {target && target.tiltPercent > 18 ? (
                <p className="mt-1 text-xs text-[var(--wms-status-warning-fg)]">
                  Shot at a steep angle (opposite sides of the target differ by {target.tiltPercent.toFixed(0)}%). The
                  tilt has been corrected, but accuracy falls off away from the target — shoot squarer if you can, and
                  keep the target beside the garment rather than off in a corner.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[var(--wms-fg)]">
                No calibration target in this photo.{" "}
                {calibRatio
                  ? "Falling back to the calibration saved on this device — the scale is only right if the camera is the same distance away as when you calibrated, and any tilt is uncorrected."
                  : "Nothing can be measured until there is either a target in frame or a calibration."}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="wms-btn wms-btn-sm max-md:min-h-11"
                  onClick={() => {
                    setTappingCorners((v) => !v);
                    setCornerTaps([]);
                    setCalibrating(false);
                  }}
                >
                  {tappingCorners ? `Cancel (${cornerTaps.length}/4)` : "Tap the target's 4 corners"}
                </button>
                <a
                  href="/inventory/size-grading/target"
                  target="_blank"
                  rel="noreferrer"
                  className="wms-btn wms-btn-sm max-md:min-h-11"
                >
                  Print a target
                </a>
              </div>
              {tappingCorners ? (
                <p className="mt-1 text-xs text-[var(--wms-muted)]">
                  Tap the four outer corners of the black frame, clockwise, starting at its top-left.{" "}
                  {cornerTaps.length}/4 tapped.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {handoffNote ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{handoffNote}</p>
      ) : null}

      {handoff ? (
        <div className="flex min-w-0 flex-wrap items-start gap-4 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
          {/* A remote QR image, not an asset next/image could optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={handoff.qrCodeUrl}
            alt="QR code — scan it with your phone to open the camera"
            className="h-40 w-40 shrink-0 rounded bg-white p-1.5"
          />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
              <Smartphone className="h-4 w-4 text-[var(--wms-accent)]" /> Scan this with your phone
            </h2>
            <p className="mt-1 text-sm text-[var(--wms-muted)]">
              Scanning opens the phone&apos;s camera. Lay the garment flat with the US&nbsp;Letter sheet beside it,
              shoot straight down, and send — the photo lands on this screen and is measured here.
            </p>
            <p className="mt-2 flex items-center gap-2 font-mono text-xs text-[var(--wms-accent)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the photo… keep this page open.
            </p>
            {handoff.scanUrl ? (
              <p className="mt-2 break-all font-mono text-[0.68rem] text-[var(--wms-muted)]">{handoff.scanUrl}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="wms-btn max-md:min-h-11" onClick={() => setHandoff(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="wms-btn max-md:min-h-11"
                onClick={() => {
                  setHandoff(null);
                  fileInputRef.current?.click();
                }}
              >
                <Upload className="h-4 w-4" /> Upload a file instead
              </button>
              {/* A webcam cannot look down at a table, but if someone has a
                  document camera or a USB camera on a stand, let them use it. */}
              <button
                type="button"
                className="wms-btn max-md:min-h-11"
                onClick={() => {
                  setHandoff(null);
                  void openCamera();
                }}
              >
                Use this computer&apos;s camera
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cameraOpen ? (
        <div className="min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              void focusAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
            }}
            className={`block h-auto w-full rounded ${canFocus ? "cursor-crosshair" : ""} ${
              focusing ? "opacity-90 outline outline-2 outline-[var(--wms-accent)]" : ""
            }`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="wms-btn-primary max-md:min-h-11" onClick={() => void shoot()}>
              <Camera className="h-4 w-4" /> {focusing ? "Focusing…" : "Capture"}
            </button>
            <button type="button" className="wms-btn max-md:min-h-11" onClick={closeCamera}>
              Cancel
            </button>
            <button
              type="button"
              className="wms-btn max-md:min-h-11"
              onClick={() => {
                closeCamera();
                cameraInputRef.current?.click();
              }}
            >
              Use the phone&apos;s camera app
            </button>
          </div>
          <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">
            {canFocus === false
              ? "This device gives the browser no focus control — if the photo comes out soft, use the phone's camera app button, which focuses properly."
              : "Tap the garment in the preview to focus there, then Capture. Hold the phone level and square above it."}
          </p>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2">
          {image ? (
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              className={`block h-auto w-full ${calibrating || tappingCorners ? "cursor-crosshair" : ""}`}
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
              <p className="font-mono text-xs">
                On a computer, Take photo shows a QR code — scan it with a phone and shoot from there.
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
                    <span className="flex items-center gap-2">
                      {catalogueType && typeOverride === catalogueType ? (
                        <span className="font-mono text-xs text-[var(--wms-muted)]">from the catalogue</span>
                      ) : null}
                      <button
                        type="button"
                        className="font-mono text-xs text-[var(--wms-accent)] underline"
                        onClick={() => setTypeOverride("")}
                      >
                        use the photo instead
                      </button>
                    </span>
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
                        <td className="py-1.5 text-[var(--wms-muted)]">
                          {r.key === "rise" && view === "back" ? "Back rise" : POM_LABEL[r.key]}
                        </td>
                        <td className="py-1.5 text-right font-mono text-[var(--wms-fg)]">{fmtIn(r.cm)}</td>
                        <td className="py-1.5 pl-3 text-right font-mono text-[var(--wms-muted)]">{fmt(r.cm)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  Flat measurements, taken across the garment as it lies — not doubled.
                  {focus && focus.verdict !== "soft" ? (
                    <>
                      {" · "}
                      <span
                        className={
                          focus.verdict === "sharp"
                            ? "text-[var(--wms-status-success-fg)]"
                            : "text-[var(--wms-status-warning-fg)]"
                        }
                      >
                        {focus.verdict === "sharp"
                          ? "focus sharp"
                          : focus.verdict === "usable"
                            ? "focus adequate"
                            : "too plain to judge focus"}
                      </span>
                    </>
                  ) : null}
                </p>

                {/* A blurred photo measures wrong in the one way nobody
                    notices: the number still looks like a number. Saying so
                    here, and refusing the save until it is acknowledged, is
                    cheaper than finding it in the size chart later. */}
                {focus?.verdict === "soft" ? (
                  <div className="mt-3 rounded border border-[var(--wms-status-danger-fg)]/50 bg-[var(--wms-status-danger-fg)]/10 p-2">
                    <p className="text-sm font-medium text-[var(--wms-status-danger-fg)]">
                      This photo is out of focus — these numbers are not reliable.
                    </p>
                    <p className="mt-1 text-xs text-[var(--wms-muted)]">
                      A soft edge spreads the garment&apos;s outline over several pixels, so a hem can read a centimetre
                      out either way. Take it again: tap the garment on the phone to focus, wait for the preview to
                      sharpen, then shoot. The phone&apos;s own camera app focuses most reliably.
                    </p>
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="wms-btn-primary max-md:min-h-11"
                    disabled={!pickedSize || saving || (focus?.verdict === "soft" && !allowSoft)}
                    onClick={() => void saveToItem()}
                    title={pickedSize ? undefined : "Choose the item and size first"}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {saving ? "Saving…" : `Save ${view} to item`}
                  </button>
                  {focus?.verdict === "soft" && !allowSoft ? (
                    <button
                      type="button"
                      className="font-mono text-xs text-[var(--wms-accent)] underline"
                      onClick={() => setAllowSoft(true)}
                    >
                      save it anyway
                    </button>
                  ) : !pickedItem ? (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">
                      Search or scan an item above to save against it.
                    </span>
                  ) : !pickedSize ? (
                    <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">Choose a size first.</span>
                  ) : savedAt ? (
                    <span className="font-mono text-xs text-[var(--wms-status-success-fg)]">
                      Saved to {pickedItem.upc} · {pickedSize.size ?? pickedSize.sku}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">
                      → {pickedItem.upc} · {pickedSize.size ?? pickedSize.sku}
                    </span>
                  )}
                </div>
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
                <span className="font-mono text-[var(--wms-muted)]">
                  {threshold ?? autoT}
                  {threshold === null ? " auto" : ""}
                </span>
              </span>
              <input
                type="range"
                min={15}
                max={120}
                value={threshold ?? autoT}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
              <span className="text-xs text-[var(--wms-muted)]">
                <strong>Tap the middle of the garment in the photo.</strong> The green grows out from where you tap,
                so whatever else is in frame — floor, feet, a pile of stock — is ignored.
                {!tapped ? " Right now it is guessing from the centre of the frame." : ""}
              </span>
              <span className="text-xs text-[var(--wms-muted)]">
                The level is chosen from the photo. Drag LEFT if part of the garment is missing from the green, RIGHT
                if shadow or table is green.{" "}
                {threshold !== null ? (
                  <button type="button" className="text-[var(--wms-accent)] underline" onClick={() => setThreshold(null)}>
                    back to auto
                  </button>
                ) : null}
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
