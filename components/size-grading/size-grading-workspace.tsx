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
import { Camera, Crosshair, Loader2, RotateCcw, Ruler, Save, Smartphone, Sparkles, Upload, X } from "lucide-react";

import { ItemPicker, type PickedItem, type PickedSize } from "./item-picker";
import { MeasurePoints, type HandleMap } from "./measure-points";
import { GarmentSketch, sketchFor } from "./garment-sketch";

import { type Point, type ShirtMask } from "@/lib/size-grading/measure";
import { segmentGarment } from "@/lib/size-grading/segment";
import { focusReading, sampleForFocus, type FocusReading } from "@/lib/size-grading/sharpness";
import { familyForCategory } from "@/lib/size-grading/catalog-family";
import { TARGET, detectTarget, rectify, type Quad, type TargetDetection } from "@/lib/size-grading/target";
import {
  GARMENT_LABELS,
  POMS_FOR,
  pomLabel,
  measureGarment,
  type GarmentResult,
  type GarmentType,
  type PomKey,
} from "@/lib/size-grading/garment";
import { colorForPom, pomOnSide } from "@/lib/size-grading/pom-guide";
import { refineLine } from "@/lib/size-grading/ai-refine";
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

/** The rectified image is rendered with this much room around the target. */
const TARGET_MARGIN_CM = 60;
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
  /** How readily a pixel joins the garment. 0 is the neutral comparison. */
  const [bias, setBias] = useState(0);
  /** Where the garment is. Starts at the centre of the frame; the operator
   *  moves it by tapping, which is the only reliable way to say which of the
   *  things in a warehouse photo is the one being measured. */
  const [seed, setSeed] = useState<Point>({ x: 0, y: 0 });
  const [result, setResult] = useState<GarmentResult | null>(null);
  const [mask, setMask] = useState<ShirtMask | null>(null);
  /* The measurement itself: two movable ends per point. The photo is squared
     up against the printed target, so any two points on it ARE a measurement —
     the segmentation only proposes where they start. */
  const [handles, setHandles] = useState<HandleMap>({});
  const [selectedPom, setSelectedPom] = useState<string | null>(null);
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
  /* What the last save did, shown beside the button that did it — an error
     reported at the top of a long page is an error nobody reads. */
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);

  /* Points the operator switched on or off by hand. Anything not in here
     follows the defaults: off when it is not on this side of the garment, or
     when the vision model could not see it in this photo. */
  const [toggles, setToggles] = useState<Record<string, "on" | "off">>({});
  /** The vision model's reading of this photo. */
  const [ai, setAi] = useState<{
    status: "idle" | "running" | "done" | "error";
    message?: string;
    model?: string;
    type?: GarmentType;
    detectedView?: "front" | "back" | "unsure";
    hidden?: string[];
    placed?: number;
  }>({ status: "idle" });
  /** Re-ask the model for the same photo. */
  const [aiNonce, setAiNonce] = useState(0);
  /** Lines the operator has dragged — a late AI answer never moves these. */
  const touchedRef = useRef<Set<string>>(new Set());
  /** Which sketch a top gets. */
  const [longSleeve, setLongSleeve] = useState(false);

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
      /* The calibration target is never part of the garment, and it is the one
         thing in the frame whose position is known exactly — so it is cut out
         before anything is measured rather than hoped to be a different colour. */
      const exclude = rectPxPerCm
        ? [{
            x: Math.round(TARGET_MARGIN_CM * rectPxPerCm),
            y: Math.round(TARGET_MARGIN_CM * rectPxPerCm),
            w: Math.round(TARGET.outerWCm * rectPxPerCm),
            h: Math.round(TARGET.outerHCm * rectPxPerCm),
          }]
        : undefined;
      const m = segmentGarment(image.data, image.width, image.height, seed, { bias, exclude });
      setMask(m);
      setResult(measureGarment(m, pxPerCm, typeOverride || undefined));
      /* Focus is judged over the garment, not the frame: a sharp table behind a
         blurred garment is still a measurement of a blur. */
      const box = maskBounds(m);
      setFocus(focusReading(image.data, image.width, image.height, box ?? undefined));
      setBusy(false);
    }, 30);
    return () => window.clearTimeout(id);
  }, [image, pxPerCm, bias, seed, typeOverride, rectPxPerCm]);

  /** Every point this family is measured on, whatever the photo managed.
   *  The catalogue (or the operator) first, then the vision model, then the
   *  silhouette — in order of how often each is right. */
  const activeType: GarmentType = (typeOverride ||
    (ai.status === "done" ? ai.type : null) ||
    (result?.ok ? result.type : null) ||
    "top") as GarmentType;
  const pomKeys = useMemo(() => [...POMS_FOR[activeType]], [activeType]);

  const isOff = useCallback(
    (key: string) => {
      const t = toggles[key];
      if (t) return t === "off";
      return !pomOnSide(key, view) || Boolean(ai.hidden?.includes(key));
    },
    [toggles, view, ai.hidden],
  );
  const onKeys = useMemo(() => pomKeys.filter((k) => !isOff(k)), [pomKeys, isOff]);
  const offSet = useMemo(() => new Set<string>(pomKeys.filter((k) => isOff(k))), [pomKeys, isOff]);
  const togglePom = useCallback(
    (key: string) => {
      setToggles((t) => ({ ...t, [key]: isOff(key) ? "on" : "off" }));
      setSavedAt(null);
    },
    [isOff],
  );

  /**
   * Ask the vision model where every line goes, as soon as there is a photo.
   *
   * This is what takes the operator out of the loop: the photo comes in, the
   * lines appear on the garment, and the operator only touches the ones that
   * landed in the wrong place. The model answers in fractions of the image;
   * each end is then pulled onto the garment's real edge where the silhouette
   * finds one close by (lib/size-grading/ai-refine.ts).
   */
  useEffect(() => {
    if (!image) {
      setAi({ status: "idle" });
      return;
    }
    let alive = true;
    setAi({ status: "running" });
    void (async () => {
      try {
        const off = document.createElement("canvas");
        off.width = image.width;
        off.height = image.height;
        off.getContext("2d")?.putImageData(image, 0, 0);
        const dataUrl = off.toDataURL("image/jpeg", 0.88);
        const r = await fetch("/api/inventory/size-grading/ai-measure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: dataUrl,
            view,
            garmentType: typeOverride || undefined,
            itemName: pickedItem?.name ?? undefined,
            category: [pickedItem?.category, pickedItem?.subcategory].filter(Boolean).join(" / ") || undefined,
          }),
        });
        const j = (await r.json().catch(() => ({}))) as {
          garmentType?: GarmentType;
          detectedView?: "front" | "back" | "unsure";
          points?: Array<{ key: string; visible: boolean; a: Point; b: Point }>;
          notes?: string;
          model?: string;
          error?: string;
        };
        if (!alive) return;
        if (!r.ok || !j.points) throw new Error(j.error ?? `AI placement failed (${r.status})`);

        /* The model's points are fractions of the image. The garment it
           describes is grown from the middle of its widest line, which is
           somewhere certainly on the fabric — far better than the centre of
           the frame, which on a round table is often the table. */
        const toPx = (p: Point): Point => ({ x: p.x * image.width, y: p.y * image.height });
        const visible = j.points.filter((p) => p.visible);
        const anchorKey = ["hip", "chest", "waist", "thigh", "hem"].find((k) => visible.some((p) => p.key === k));
        const anchor = visible.find((p) => p.key === anchorKey);
        let refineMask: ShirtMask | null = null;
        if (anchor) {
          const a = toPx(anchor.a);
          const b = toPx(anchor.b);
          const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const exclude = rectPxPerCm
            ? [{
                x: Math.round(TARGET_MARGIN_CM * rectPxPerCm),
                y: Math.round(TARGET_MARGIN_CM * rectPxPerCm),
                w: Math.round(TARGET.outerWCm * rectPxPerCm),
                h: Math.round(TARGET.outerHCm * rectPxPerCm),
              }]
            : undefined;
          refineMask = segmentGarment(image.data, image.width, image.height, centre, { bias: 0, exclude });
          setSeed(centre);
        }
        const maxPx = pxPerCm ? 1.5 * pxPerCm : Math.max(image.width, image.height) * 0.015;

        setHandles((prev) => {
          const next = { ...prev };
          for (const p of visible) {
            if (touchedRef.current.has(p.key)) continue;
            const line = refineLine(p.key, refineMask, toPx(p.a), toPx(p.b), maxPx);
            next[p.key] = { a: line.a, b: line.b, set: true };
          }
          return next;
        });
        setAi({
          status: "done",
          model: j.model,
          type: j.garmentType,
          detectedView: j.detectedView,
          hidden: j.points.filter((p) => !p.visible).map((p) => p.key),
          placed: visible.length,
          message: j.notes || undefined,
        });
      } catch (e) {
        if (!alive) return;
        setAi({
          status: "error",
          message: e instanceof Error ? e.message : "AI placement failed",
        });
      }
    })();
    return () => {
      alive = false;
    };
    // Re-asked for a new photo, a different garment family, or on request —
    // not when the scale or the side changes, which do not move a line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, typeOverride, aiNonce]);

  /* Seed the ends from what the photo found, and give everything else a
     sensible place to be dragged from. A point with no proposal — a neck
     opening on a flat garment — still gets a line, because "place it yourself"
     is a usable answer and "nothing on screen" is not. */
  useEffect(() => {
    if (!image) {
      setHandles({});
      setSelectedPom(null);
      return;
    }
    setHandles((prev) => {
      const next: HandleMap = {};
      pomKeys.forEach((key, i) => {
        const kept = prev[key];
        if (kept?.set) {
          next[key] = kept;
          return;
        }
        const line = result?.ok ? result.points[key]?.line : undefined;
        if (line) {
          next[key] = { a: { ...line.a }, b: { ...line.b }, set: true };
          return;
        }
        // Staggered across the middle so unplaced lines do not stack up.
        const y = image.height * (0.3 + 0.045 * (i % 9));
        next[key] = {
          a: { x: image.width * 0.34, y },
          b: { x: image.width * 0.66, y },
          set: false,
        };
      });
      return next;
    });
    setSelectedPom((cur) => (cur && pomKeys.includes(cur as PomKey) ? cur : (pomKeys[0] ?? null)));
  }, [image, result, pomKeys]);

  const cmOf = useCallback(
    (key: string): number | null => {
      const h = handles[key];
      if (!h || !pxPerCm) return null;
      return Math.hypot(h.b.x - h.a.x, h.b.y - h.a.y) / pxPerCm;
    },
    [handles, pxPerCm],
  );

  /** What will be saved: every point whose ends have been settled. */
  const readings = useMemo(
    () =>
      onKeys
        .map((key) => ({ key, cm: handles[key]?.set ? cmOf(key) : null }))
        .filter((r): r is { key: PomKey; cm: number } => typeof r.cm === "number" && r.cm > 0),
    [onKeys, handles, cmOf],
  );

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
        sleeveInseam: "#fb923c", bicep: "#fbbf24", cuff: "#f472b6", armhole: "#c084fc",
        inseam: "#22c55e", outseam: "#3b82f6", legOpening: "#ec4899", rise: "#a855f7",
        thigh: "#2dd4bf", knee: "#38bdf8", calf: "#818cf8",
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
      /* A moderate preview on purpose: asking for the sensor's maximum selects
         a camera mode on many Android devices whose autofocus never fires, so
         the preview is sharp on a far wall and soft on a garment an arm away.
         A sharp 1920 frame measures better than a soft 2560 one. */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
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
      const rect = rectify(src.data, src.width, src.height, useQuad, { maxPx: 1400, aroundCm: TARGET_MARGIN_CM });
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
      setBias(0);
      setCalibPts([]);
      setCornerTaps([]);
      setTappingCorners(false);
      setSavedAt(null);
      setSaveNote(null);
      setFocus(null);
      setAllowSoft(false);
      /* A new photo is a new garment on the table: lines from the last one
         would be lines on nothing. */
      setHandles({});
      touchedRef.current = new Set();
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

  /**
   * Take the photo, and prove it is sharp before accepting it.
   *
   * Waiting a fixed time and hoping is what this replaces: on a device whose
   * autofocus never fires, a delay produces exactly the same soft frame as no
   * delay. Here the shutter waits on the pixels — it does not fire until the
   * preview reads sharp or the budget runs out — and both capture paths are
   * then measured, because takePhoto() can hand back a frame focused
   * differently from the preview that was just verified.
   */
  const shoot = useCallback(async () => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!video || !track) return;

    const readNow = () => {
      if (!video.videoWidth) return null;
      const sample = sampleForFocus(video, video.videoWidth, video.videoHeight);
      return sample ? focusReading(sample.data, sample.width, sample.height) : null;
    };
    const scoreBlob = async (blob: Blob) => {
      try {
        const bmp = await createImageBitmap(blob);
        const sample = sampleForFocus(bmp, bmp.width, bmp.height);
        bmp.close();
        return sample ? focusReading(sample.data, sample.width, sample.height).score : -1;
      } catch {
        return -1;
      }
    };

    setFocusing(true);
    let best: { blob: Blob; score: number } | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await focusAt(0.5, 0.5);
        const until = Date.now() + 2600;
        while (Date.now() < until) {
          const r = readNow();
          if (r && (r.verdict === "sharp" || r.verdict === "flat")) break;
          await new Promise((res) => setTimeout(res, 120));
        }

        const candidates: Blob[] = [];
        const off = document.createElement("canvas");
        off.width = video.videoWidth;
        off.height = video.videoHeight;
        const c = off.getContext("2d");
        if (c) {
          c.drawImage(video, 0, 0);
          const frame = await new Promise<Blob | null>((r) => off.toBlob(r, "image/jpeg", 0.95));
          if (frame) candidates.push(frame);
        }
        try {
          const Ctor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } })
            .ImageCapture;
          if (Ctor) {
            const still = await Promise.race([
              new Ctor(track).takePhoto().catch(() => null),
              new Promise<null>((r) => setTimeout(() => r(null), 4000)),
            ]);
            if (still && still.size > 0) candidates.push(still);
          }
        } catch {
          /* unsupported or refused — the frame grab above still stands */
        }

        for (const blob of candidates) {
          const score = await scoreBlob(blob);
          if (!best || score > best.score) best = { blob, score };
        }
        if (best && best.score >= 6) break;
      }
    } finally {
      setFocusing(false);
    }

    if (!best) {
      setError("Could not take the photo — use Take photo, or Upload.");
      return;
    }
    closeCamera();
    await loadFile(new File([best.blob], "capture.jpg", { type: best.blob.type || "image/jpeg" }));
  }, [closeCamera, loadFile, focusAt]);

  /* When an item is picked, start on the family the catalogue already knows.
     The silhouette is the fallback, not the first answer, and this is what
     stops a pair of evening pants being measured as a shirt. */
  useEffect(() => {
    const guess = familyForCategory(pickedItem?.category, pickedItem?.subcategory);
    const t = guess?.kind === "garment" ? guess.type : null;
    setCatalogueType(t);
    if (t) setTypeOverride(t);
  }, [pickedItem]);

  const saveToItem = useCallback(async () => {
    if (!pickedSize || !readings.length) return;
    /* What is saved is what is ON SCREEN — the lines as they stand after any
       dragging — not what the segmentation originally proposed. Saving the
       proposal would quietly discard every correction the operator made. */
    const pointsCm: Record<string, number> = {};
    for (const r of readings) pointsCm[r.key] = Number(r.cm.toFixed(2));
    setSaving(true);
    setError(null);
    setSaveNote(null);
    try {
      const adjusted = [...touchedRef.current].filter((k) => k in pointsCm).length;
      const r = await fetch("/api/inventory/size-grading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          customSkuId: pickedSize.customSkuId,
          garmentType: activeType,
          pointsCm,
          pxPerCm: pxPerCm ?? undefined,
          typeOverridden: Boolean(typeOverride),
          view,
          note: ai.status === "done" && ai.model
            ? `lines placed by ${ai.model}; ${adjusted} adjusted by hand`
            : undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        measuredAt?: string;
        error?: string;
        appliedTo?: number;
        size?: string | null;
        colors?: string[];
      };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `Could not save (HTTP ${r.status})`);

      /* Read it back the way the item card does. "Saved" on this page has to
         mean the card will show it — the owner checked once, found nothing,
         and a success message that was not true is worse than an error. */
      const check = await fetch(
        `/api/inventory/size-grading?customSkuId=${encodeURIComponent(pickedSize.customSkuId)}`,
        { cache: "no-store" },
      );
      const back = (await check.json().catch(() => ({}))) as Record<string, { points_cm?: Record<string, number> } | null>;
      const stored = back?.[view]?.points_cm ?? {};
      const missing = Object.keys(pointsCm).filter((k) => typeof stored[k] !== "number");
      if (!check.ok || missing.length) {
        throw new Error(
          `The server accepted the save but the item does not show it (${missing.length || "all"} missing). Try again.`,
        );
      }
      setSavedAt(j.measuredAt ?? new Date().toISOString());
      const colours = j.colors?.length ? ` · ${j.colors.length} colour${j.colors.length === 1 ? "" : "s"}` : "";
      setSaveNote({
        ok: true,
        text: `Saved ${Object.keys(pointsCm).length} ${view} measurements to size ${j.size ?? pickedSize.size ?? pickedSize.sku}${colours} — on the item card now.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save";
      setSaveNote({ ok: false, text: msg });
    } finally {
      setSaving(false);
    }
  }, [pickedSize, readings, activeType, pxPerCm, typeOverride, view, ai.status, ai.model]);

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
       colours around it become the model of what the garment looks like. */
    setSeed(p);
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
                  : "You can still place the measurement lines, but there is no way to turn them into centimetres: a photo carries no sense of size, so the printed target has to be in the frame. Put it beside the garment and shoot again, or tap its four corners below if it IS in the photo and was missed."}
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
          {image && (calibrating || tappingCorners) ? (
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              className="block h-auto w-full cursor-crosshair"
            />
          ) : image ? (
            /* The measurement is the thing on screen now — no mask, no
               sensitivity. Drag either end of a line and the number follows. */
            <MeasurePoints
              image={image}
              pxPerCm={pxPerCm}
              keys={onKeys}
              labelFor={(k) => pomLabel(k, view)}
              colorFor={colorForPom}
              handles={handles}
              selected={selectedPom && onKeys.includes(selectedPom as PomKey) ? selectedPom : null}
              onSelect={setSelectedPom}
              onChange={(key, next) => {
                touchedRef.current.add(key);
                setSavedAt(null);
                setHandles((h) => ({ ...h, [key]: next }));
              }}
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
            ) : (
              <>
                {/* What it thinks this is, always correctable. A guess shown as
                    a fact is how a wrong measurement reaches the size chart. */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <select
                    value={activeType}
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
                        detect from the photo
                      </button>
                    </span>
                  ) : ai.status === "done" && ai.type ? (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">recognised by AI</span>
                  ) : result?.ok ? (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">
                      detected · {result.classification.why}
                    </span>
                  ) : null}
                </div>

                {/* The vision model's pass over the photo. Running, it says so;
                    done, it says how many lines it placed; failed, the
                    silhouette proposals stand and the reason is shown. */}
                <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs">
                  {ai.status === "running" ? (
                    <span className="flex items-center gap-1.5 text-[var(--wms-accent)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI is finding the garment and placing the lines…
                    </span>
                  ) : ai.status === "done" ? (
                    <span className="flex items-center gap-1.5 text-[var(--wms-status-success-fg)]">
                      <Sparkles className="h-3.5 w-3.5" /> AI placed {ai.placed} line{ai.placed === 1 ? "" : "s"} — drag
                      any that are off.
                    </span>
                  ) : ai.status === "error" ? (
                    <span className="text-[var(--wms-status-warning-fg)]">
                      {ai.message} — showing the outline-based proposals instead.
                    </span>
                  ) : null}
                  {ai.status !== "running" ? (
                    <button
                      type="button"
                      className="text-[var(--wms-accent)] underline"
                      onClick={() => {
                        touchedRef.current = new Set();
                        setAiNonce((n) => n + 1);
                      }}
                    >
                      {ai.status === "idle" ? "place lines with AI" : "redo with AI"}
                    </button>
                  ) : null}
                </div>
                {ai.status === "done" && ai.message ? (
                  <p className="mt-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">{ai.message}</p>
                ) : null}
                {ai.status === "done" && ai.detectedView && ai.detectedView !== "unsure" && ai.detectedView !== view ? (
                  <p className="mt-1 text-xs text-[var(--wms-status-warning-fg)]">
                    This looks like the {ai.detectedView} of the garment, but Side is set to {view}.{" "}
                    <button
                      type="button"
                      className="font-mono text-[var(--wms-accent)] underline"
                      onClick={() => setView(ai.detectedView as "front" | "back")}
                    >
                      switch to {ai.detectedView}
                    </button>
                  </p>
                ) : null}

                {!pxPerCm ? (
                  <p className="mt-2 text-xs text-[var(--wms-status-warning-fg)]">
                    No scale yet — the lines can be placed, but there are no centimetres until the target is in the
                    photo (or you calibrate by hand).
                  </p>
                ) : busy ? (
                  <p className="mt-2 flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the outline…
                  </p>
                ) : null}

                {/* Every point of this family. Tap a row to work on its line;
                    the X takes a point out — not on this side, not on this
                    garment, or just not wanted — and it is neither drawn nor
                    saved. Taken-out points stay listed so they can come back. */}
                <ul className="mt-3 divide-y divide-[var(--wms-border)]">
                  {pomKeys.map((key) => {
                    const off = offSet.has(key);
                    const h = handles[key];
                    const cm = !off && h?.set ? cmOf(key) : null;
                    const active = !off && selectedPom === key;
                    return (
                      <li key={key} className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={off}
                          onClick={() => setSelectedPom(key)}
                          className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm max-md:min-h-11 ${
                            active ? "bg-[var(--wms-surface-elevated)]" : ""
                          }`}
                        >
                          <span
                            aria-hidden
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ background: colorForPom(key), opacity: off ? 0.2 : cm ? 1 : 0.3 }}
                          />
                          <span
                            className={`min-w-0 flex-1 truncate ${
                              off
                                ? "text-[var(--wms-muted)] line-through opacity-60"
                                : active
                                  ? "font-semibold text-[var(--wms-fg)]"
                                  : "text-[var(--wms-muted)]"
                            }`}
                          >
                            {pomLabel(key, view)}
                          </span>
                          {off ? (
                            <span className="font-mono text-xs text-[var(--wms-muted)]">
                              {toggles[key] === "off"
                                ? "removed"
                                : !pomOnSide(key, view)
                                  ? `${view === "front" ? "back" : "front"} only`
                                  : "not in photo"}
                            </span>
                          ) : cm ? (
                            <>
                              <span className="font-mono text-[var(--wms-fg)]">{fmtIn(cm)}</span>
                              <span className="w-16 text-right font-mono text-xs text-[var(--wms-muted)]">{fmt(cm)}</span>
                            </>
                          ) : h?.set && !pxPerCm ? (
                            <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">needs scale</span>
                          ) : (
                            <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">place it</span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => togglePom(key)}
                          aria-label={off ? `Measure ${pomLabel(key, view)}` : `Don't measure ${pomLabel(key, view)}`}
                          title={off ? "Measure this" : "Don't measure this"}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)] max-md:h-11 max-md:w-11"
                        >
                          {off ? <RotateCcw className="h-3.5 w-3.5" /> : <X className="h-4 w-4" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  Drag either end of the highlighted line on the photo. The number follows as you drag, and a
                  magnifier shows what is under your finger. ✕ removes a point you don&apos;t need.
                </p>
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
                    disabled={
                      !pickedSize || saving || !readings.length || (focus?.verdict === "soft" && !allowSoft)
                    }
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
                    <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">
                      Search or scan an item above to save against it.
                    </span>
                  ) : !pickedSize ? (
                    <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">Choose a size first.</span>
                  ) : !readings.length ? (
                    <span className="font-mono text-xs text-[var(--wms-status-warning-fg)]">
                      {pxPerCm ? "No measurements placed yet." : "No scale — nothing to save in centimetres yet."}
                    </span>
                  ) : savedAt ? null : (
                    <span className="font-mono text-xs text-[var(--wms-muted)]">
                      {readings.length} → {pickedItem.upc} · {pickedSize.size ?? pickedSize.sku}
                    </span>
                  )}
                </div>
                {saveNote ? (
                  <p
                    role="status"
                    className={`mt-2 rounded border p-2 text-xs ${
                      saveNote.ok
                        ? "border-[var(--wms-status-success-fg)]/40 bg-[var(--wms-status-success-fg)]/10 text-[var(--wms-status-success-fg)]"
                        : "border-[var(--wms-status-danger-fg)]/50 bg-[var(--wms-status-danger-fg)]/10 text-[var(--wms-status-danger-fg)]"
                    }`}
                  >
                    {saveNote.text}
                  </p>
                ) : null}
              </>
            )}
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

          {/* Where each line goes on this kind of garment, in the same colours
              as the photo. Tapping a line here selects it there. */}
          <div className="flex flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--wms-fg)]">How to measure · {GARMENT_LABELS[activeType]}</h2>
              <a
                href="/inventory/size-grading/guide"
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-[var(--wms-accent)] underline"
              >
                all garments
              </a>
            </div>
            {activeType === "top" ? (
              <div className="inline-flex self-start overflow-hidden rounded border border-[var(--wms-border)]">
                {[false, true].map((long) => (
                  <button
                    key={String(long)}
                    type="button"
                    onClick={() => setLongSleeve(long)}
                    className={`px-2 py-0.5 font-mono text-[0.7rem] max-md:min-h-9 ${
                      longSleeve === long
                        ? "bg-[var(--wms-accent)] font-semibold text-[var(--wms-on-accent,#0c0f12)]"
                        : "text-[var(--wms-fg)]"
                    }`}
                  >
                    {long ? "long sleeve" : "short sleeve"}
                  </button>
                ))}
              </div>
            ) : null}
            <GarmentSketch
              sketch={sketchFor(activeType, longSleeve)}
              type={activeType}
              view={view}
              keys={pomKeys}
              excluded={offSet}
              highlight={image ? selectedPom : null}
              onPick={image ? (k) => !offSet.has(k) && setSelectedPom(k) : undefined}
            />
          </div>
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
