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
import { Camera, Crosshair, Loader2, RotateCcw, Save, Smartphone, Upload } from "lucide-react";

import { ItemPicker, type PickedItem, type PickedSize } from "./item-picker";
import { MeasurePoints, type HandleMap } from "./measure-points";
import { GuidePanel } from "./guide-panel";

import { type Point, type ShirtMask } from "@/lib/size-grading/measure";
import { segmentGarment } from "@/lib/size-grading/segment";
import { findGarmentOffThread, warmUpFinder } from "@/lib/size-grading/garment-finder";
import { aiKeysFor, chooseWithAi, mergeLines, readWithAi } from "@/lib/size-grading/ai-client";
import type { Segment } from "@/lib/size-grading/measure";
import { focusReading, sampleForFocus, type FocusReading } from "@/lib/size-grading/sharpness";
import { familyForCategory } from "@/lib/size-grading/catalog-family";
import {
  detectTarget,
  frameToSource,
  orderQuad,
  rectify,
  targetSheet,
  type Quad,
  type RectFrame,
  type TargetDetection,
} from "@/lib/size-grading/target";
import {
  GARMENT_LABELS,
  POMS_FOR,
  pomsFor,
  pomLabel,
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

/** A photo with no target is measured at this size. */
const WORK_MAX_PX = 1000;
/** The photo is kept this big for target detection and un-warping. */
const SRC_MAX_PX = 1800;
const CHART_KEY = "wms.sizeGrading.chart";

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

/* The exact colours the guide pictures were drawn in, so a line on the photo is
   the same colour as the same line on the "how to measure" picture beside it. */
const POM_COLOR: Record<string, string> = {
  chest: "#facc15", waist: "#a855f7", hip: "#22d3ee", length: "#3b82f6", hem: "#f43f5e",
  shoulder: "#22c55e", sleeve: "#8b5cf6", sleeveInseam: "#fb923c", bicep: "#f59e0b",
  cuff: "#f472b6", armhole: "#f97316", inseam: "#22c55e", outseam: "#3b82f6",
  legOpening: "#f43f5e", rise: "#f472b6", thigh: "#06b6d4", knee: "#a78bfa", calf: "#818cf8",
  neck: "#60a5fa", neckDrop: "#93c5fd", collarHeight: "#bfdbfe", shoulderSlope: "#fde047",
  waistbandHeight: "#f9a8d4", frontPocketOpening: "#fda4af", backPocketWidth: "#fca5a5",
  backPocketLength: "#ef4444",
};
const colorForPom = (key: string) => POM_COLOR[key] ?? "#38bdf8";

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
  /* The model's mask, when it has finished. Null means "not yet" or "it could
     not run", and in both cases the colour model carries on in its place — a
     photo is never left unmeasurable because a download failed. */
  const [modelMask, setModelMask] = useState<ShirtMask | null>(null);
  const [finding, setFinding] = useState(false);
  /** Which pass the finder is on — the slow ones say so. */
  const [findStage, setFindStage] = useState<"ai" | "salience" | "segments">("ai");
  /* The AI's reading of this photo: its lines (snapped onto the picture), the
     garment it saw, and how the cut-out was chosen — in words, for the status. */
  const [aiLines, setAiLines] = useState<Partial<Record<PomKey, Segment>> | null>(null);
  const [aiType, setAiType] = useState<GarmentType | null>(null);
  const [findHow, setFindHow] = useState<string | null>(null);
  /** Why the finder gave up on this photo, in words — shown, not swallowed. */
  const [modelFailed, setModelFailed] = useState<string | null>(null);
  const [selectedPom, setSelectedPom] = useState<string | null>(null);
  /** How sharp the garment is in this photo, and whether it can be trusted. */
  const [focus, setFocus] = useState<FocusReading | null>(null);
  /** The operator has seen the softness warning and wants to save regardless. */
  const [allowSoft, setAllowSoft] = useState(false);
  /** Operator's override of the detected garment, when the shape fooled it. */
  const [typeOverride, setTypeOverride] = useState<GarmentType | "">("");
  /** What the catalogue says this product is — better than reading the shape. */
  const [catalogueType, setCatalogueType] = useState<GarmentType | null>(null);
  const typeRef = useRef<GarmentType | null>(null);
  useEffect(() => {
    typeRef.current = typeOverride || catalogueType || null;
  }, [typeOverride, catalogueType]);
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibPts, setCalibPts] = useState<Point[]>([]);
  /* The printed target, found in this photo. When it is there, it supplies the
     scale AND squares the photo up, so no calibration is involved at all. */
  const [target, setTarget] = useState<TargetDetection | null>(null);
  const [targetSource, setTargetSource] = useState<"detected" | "tapped" | null>(null);
  /** Exact px-per-cm of the un-warped image, by construction. */
  const [rectPxPerCm, setRectPxPerCm] = useState<number | null>(null);
  /** Where the squared-up image sits, so the garment mask lands on the same pixels. */
  const [rectFrame, setRectFrame] = useState<RectFrame | null>(null);
  /** Corners the operator tapped, when detection missed. */
  const [cornerTaps, setCornerTaps] = useState<Point[]>([]);
  const [tappingCorners, setTappingCorners] = useState(false);
  /* Front and back are two measurements of the same garment. The operator
     shoots one, saves it, flips the garment and shoots the other; the side is
     stored with the reading so a back rise is never filed as a front rise. */
  const [view, setView] = useState<"front" | "back">("front");
  /* Read when a photo is sent to the AI, not watched: changing the side or the
     type afterwards must not send the same photo again. */
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
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
  }, []);

  /* An un-warped image's scale is exact by construction, so it always wins over
     a calibration someone tapped in once on a different photo. */
  /* Only a target gives a scale. A two-tap calibration saved on the device
     used to be the fallback, and it is how a pair of leggings came out with an
     88.8 cm hip: it holds only at the distance it was taken from, and a
     hand-held photo is never at that distance twice. No scale is an honest
     answer; a confident wrong one is not. */
  const pxPerCm = rectPxPerCm;

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
      const sheet = rectFrame ? targetSheet(rectFrame) : null;
      const exclude = sheet
        ? [{
            x: Math.round(Math.min(...sheet.map((q) => q.x))),
            y: Math.round(Math.min(...sheet.map((q) => q.y))),
            w: Math.round(Math.max(...sheet.map((q) => q.x)) - Math.min(...sheet.map((q) => q.x))),
            h: Math.round(Math.max(...sheet.map((q) => q.y)) - Math.min(...sheet.map((q) => q.y))),
          }]
        : undefined;
      /* While the finder is still working, propose nothing. The colour model's
         guess on a dark garment on a dark table is the table, and on a phone
         the finder takes long enough that its wrong lines were what got
         photographed and reported as the result. */
      if (!modelMask && (finding || aiLines)) {
        setMask(null);
        setResult(null);
        setFocus(null);
        setBusy(false);
        return;
      }
      const m = modelMask ?? segmentGarment(image.data, image.width, image.height, seed, { bias, exclude });
      setMask(m);
      setResult(measureGarment(m, pxPerCm, typeOverride || aiType || undefined));
      /* Focus is judged over the garment, not the frame: a sharp table behind a
         blurred garment is still a measurement of a blur. */
      const box = maskBounds(m);
      setFocus(focusReading(image.data, image.width, image.height, box ?? undefined));
      setBusy(false);
    }, 30);
    return () => window.clearTimeout(id);
  }, [image, pxPerCm, bias, seed, typeOverride, rectFrame, modelMask, finding, aiLines, aiType]);

  /** Every point this family is measured on, whatever the photo managed. */
  const activeType: GarmentType = (typeOverride || (result?.ok ? result.type : null) || aiType || "top") as GarmentType;
  /* Points the operator has crossed off — "I don't measure the collar on
     these". Remembered per garment family and side, so dropping the back pocket
     on jeans once means it stays dropped for every pair after. */
  const dropKey = `wms.sizeGrading.dropped.${activeType}.${view}`;
  const [dropped, setDropped] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(dropKey);
      setDropped(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setDropped([]);
    }
  }, [dropKey]);
  const setDroppedSaved = useCallback(
    (next: string[]) => {
      setDropped(next);
      try {
        window.localStorage.setItem(dropKey, JSON.stringify(next));
      } catch {
        /* storage blocked — the choice holds for this session only */
      }
    },
    [dropKey],
  );

  /** This side's points, in guide order — the Nth one is circle N on the picture. */
  const sidePoms = useMemo(() => pomsFor(activeType, view), [activeType, view]);
  const pomKeys = useMemo(() => sidePoms.filter((k) => !dropped.includes(k)), [sidePoms, dropped]);
  const guideNumber = useCallback((key: string) => sidePoms.indexOf(key as PomKey) + 1, [sidePoms]);

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
    const merged = mergeLines(result?.ok ? result.points : null, aiLines);
    setHandles((prev) => {
      const next: HandleMap = {};
      pomKeys.forEach((key, i) => {
        const kept = prev[key];
        /* Only a handle the operator moved is protected. An app proposal is
           replaced when a better mask arrives — that is the whole point of the
           model finishing after the colour model. */
        if (kept?.touched) {
          next[key] = kept;
          return;
        }
        // Each point from whichever line is reliable for it — see mergeLines.
        const line = merged[key];
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
  }, [image, result, pomKeys, aiLines]);

  /* Find the garment the moment a photo exists. Nothing is asked of the
     operator: no tap, no sensitivity, no second button. The colour model has
     already produced something to look at by the time this starts, so the
     screen is never empty while it runs, and when it finishes the lines move to
     the better answer — except any the operator has already corrected. */
  useEffect(() => {
    setModelMask(null);
    setModelFailed(null);
    const src = srcRef.current;
    const quad = target?.quad;
    /* No target, no scale: nothing can be measured, so there is nothing to
       find either. The scale message says what to do. */
    if (!image || !src || !rectFrame || !quad) {
      setFinding(false);
      return;
    }
    let alive = true;
    setFinding(true);
    setFindStage("ai");
    setAiLines(null);
    setAiType(null);
    setFindHow(null);
    const started = performance.now();
    const secs = () => ((performance.now() - started) / 1000).toFixed(1);
    const input = { src: { data: src.data, width: src.width, height: src.height }, picture: image.data, quad, frame: rectFrame };
    const type = typeRef.current, side = viewRef.current;
    /* Both at once: the AI reads the photo (~10 s) while the quick model cuts
       out its best guess (~3–6 s). The AI then judges that guess, and cuts the
       garment out itself when the guess is the table. */
    const quick = findGarmentOffThread({ ...input, quickOnly: true });
    const ai = readWithAi(image, type, side, aiKeysFor(type, side, pomsFor(type ?? "top", side)));
    void Promise.allSettled([quick, ai])
      .then(async ([q, a]) => {
        if (!alive) return;
        const quickMask = q.status === "fulfilled" && q.value.mask ? q.value.mask : null;
        if (a.status === "fulfilled") {
          const chosen = chooseWithAi(a.value, quickMask, image, rectFrame, src, quad);
          const t = a.value.garment as GarmentType;
          setAiType(["top", "trousers", "shorts", "dress", "skirt", "onepiece"].includes(t) ? t : null);
          setAiLines(chosen.lines);
          setFindHow(chosen.how);
          console.info(`[size-grading] AI read "${a.value.description ?? a.value.garment}" in ${secs()}s — ${chosen.how}`);
          if (chosen.mask) setModelMask(chosen.mask);
          return;
        }
        // No AI (offline, no key, timed out): the on-device finder alone, as before.
        const why = a.reason instanceof Error ? a.reason.message : String(a.reason);
        console.warn("[size-grading] AI unavailable:", why);
        if (q.status === "fulfilled" && q.value.mask && !q.value.rejected) {
          setFindHow(`the AI was unavailable (${why}); the on-device finder's cut-out passed its checks`);
          setModelMask(q.value.mask);
          return;
        }
        setFindStage("segments");
        const r = await findGarmentOffThread(input);
        if (!alive) return;
        if (r.mask) {
          setFindHow(`the AI was unavailable (${why}); found by the on-device closer look`);
          setModelMask(r.mask);
        } else setModelFailed(`${r.why}; and the AI was unavailable (${why})`);
      })
      .catch((e: unknown) => {
        console.error("[size-grading] finder failed:", e);
        if (alive) setModelFailed(e instanceof Error ? e.message || "unknown error" : String(e));
      })
      .finally(() => {
        if (alive) setFinding(false);
      });
    return () => {
      alive = false;
    };
  }, [image, rectFrame, target]);

  /* Fetch the model while the operator is still picking the item, so the first
     photo does not wait for a 17 MB download that could have happened already. */
  useEffect(() => {
    warmUpFinder();
  }, []);

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
      pomKeys
        .map((key) => ({ key, cm: handles[key]?.set ? cmOf(key) : null }))
        .filter((r): r is { key: PomKey; cm: number } => typeof r.cm === "number" && r.cm > 0),
    [pomKeys, handles, cmOf],
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

    if (mask && !tappingCorners) {
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
    if (result?.ok && !tappingCorners) {
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
      const rect = rectify(src.data, src.width, src.height, useQuad, { maxPx: 1400, upright: true });
      if (rect) {
        /* new ImageData(...) rejects a Uint8ClampedArray whose buffer type is
           not narrowed to ArrayBuffer, so the pixels are copied into one the
           constructor will take. */
        const data = new ImageData(rect.width, rect.height);
        data.data.set(rect.data);
        setImage(data);
        setRectPxPerCm(rect.pxPerCm);
        setRectFrame(rect.frame);
        setTarget(det ?? { quad: useQuad, confidence: 1, tiltPercent: 0 });
        setTargetSource(quad ? "tapped" : "detected");
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
    setRectFrame(null);
    setTarget(null);
    setTargetSource(null);
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
    try {
      const r = await fetch("/api/inventory/size-grading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customSkuId: pickedSize.customSkuId,
          garmentType: activeType,
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
  }, [pickedSize, readings, activeType, pxPerCm, typeOverride, view]);

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
        /* Taps are on the image on screen. If that is already squared up (a
           target was found, but the wrong one), they go back through the same
           transform; otherwise it is the photo, just smaller. */
        const kx = src.width / image.width;
        const ky = src.height / image.height;
        const toSrc = (q: Point) =>
          rectFrame && target ? frameToSource(target.quad, rectFrame, q.x, q.y) : { x: q.x * kx, y: q.y * ky };
        // Any tap order works — see orderQuad.
        const quad = orderQuad(next.map(toSrc));
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
        {/* One way to set the scale, not two. There used to be a two-tap
            "calibrate by hand" next to a four-corner tap, and the operator —
            reasonably — pressed the wrong one, tapped twice, pressed Save, and
            saw the same "no target" message as before. Four corners give the
            scale AND correct the tilt, so they are the only manual method. */}
        <button
          type="button"
          className="wms-btn-accent-soft inline-flex items-center gap-1.5 max-md:min-h-11"
          disabled={!image}
          onClick={() => {
            setTappingCorners((v) => !v);
            setCornerTaps([]);
          }}
        >
          <Crosshair className="h-4 w-4" />{" "}
          {tappingCorners ? `Cancel (${cornerTaps.length}/4 tapped)` : "Tap the target's 4 corners"}
        </button>
        <span className="font-mono text-xs text-[var(--wms-muted)]">
          {rectPxPerCm
            ? targetSource === "tapped"
              ? "Scale set from your 4 taps — tilt corrected"
              : "Target found — scale exact, tilt corrected"
            : "No scale yet — the target must be in the photo"}
        </span>
        <a href="/inventory/size-grading/target" className="wms-btn wms-btn-sm max-md:min-h-11" target="_blank" rel="noreferrer">
          Print target
        </a>
      </div>


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
                <strong>The target wasn&apos;t found in this photo.</strong> Without it there is no way to turn the
                lines into centimetres — a photo carries no sense of size. If the target IS in the photo, tap its 4
                outer corners. If it isn&apos;t, lay it beside the garment and shoot again.
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
                  Tap the four outer corners of the frame, in any order.{" "}
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
          {/* Right above the photo, because below it is off the bottom of a
              phone screen — the operator photographed the colour model's lines
              without ever seeing that the background remover was still at work. */}
          {image && !tappingCorners && !calibrating ? (
            <p className="mb-2 flex items-center gap-2 text-xs" role="status">
              {finding && !modelMask ? (
                <span className="flex items-center gap-2 text-[var(--wms-muted)]">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  {findStage === "segments"
                    ? "Looking closer for the garment on this device — this takes up to a minute on a phone…"
                    : "The AI is reading the photo and finding the garment…"}
                </span>
              ) : modelMask ? (
                <span className="text-[var(--wms-status-success-fg)]">
                  Garment found ({Math.round(modelMask.area / (pxPerCm ?? 1) ** 2).toLocaleString()} cm²)
                  {findHow ? ` — ${findHow}` : ""}. Check each line and drag any that is off.
                </span>
              ) : aiLines ? (
                <span className="text-[var(--wms-status-warning-fg)]">
                  The AI placed the lines; {findHow ?? "the garment could not be cut out cleanly"}. Check each line
                  before saving.
                </span>
              ) : modelFailed ? (
                <span className="text-[var(--wms-status-warning-fg)]">Background remover failed: {modelFailed}</span>
              ) : null}
            </p>
          ) : null}
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
              keys={pomKeys}
              labelFor={(k) => pomLabel(k, view)}
              colorFor={colorForPom}
              handles={handles}
              selected={selectedPom}
              onSelect={setSelectedPom}
              onChange={(key, next) => setHandles((h) => ({ ...h, [key]: next }))}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--wms-muted)]">
              <Camera className="h-8 w-8" />
              <p>Lay the garment flat and front up on a plain background that contrasts with it.</p>
              <p>
                Shoot straight down with the whole garment in frame. Sleeves out away from the body; trousers and
                shorts with a clear gap between the legs.
              </p>
              <p>Put the printed target flat beside the garment — it sets the scale, so nothing needs calibrating.</p>
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
            ) : !pxPerCm ? (
              <p className="mt-1 text-sm text-[var(--wms-muted)]">
                No target found in this photo, so there is no scale yet — put the printed target beside the
                garment and shoot again, or tap the target&apos;s 4 corners.
              </p>
            ) : finding && !modelMask ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-[var(--wms-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />{" "}
                {findStage === "segments" ? "Looking closer for the garment…" : "The AI is reading the photo…"}
              </p>
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

                {/* Every point of this family, whether the photo found it or
                    not. Tap one to work on it; its line lights up on the photo
                    with a grab handle at each end. A point with no number yet
                    is not a failure, it is the next thing to place. */}
                <ul className="mt-3 divide-y divide-[var(--wms-border)]">
                  {pomKeys.map((key) => {
                    const h = handles[key];
                    const cm = h?.set ? cmOf(key) : null;
                    const active = selectedPom === key;
                    return (
                      <li key={key} className="flex items-center">
                        <button
                          type="button"
                          onClick={() => setSelectedPom(key)}
                          className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm max-md:min-h-11 ${
                            active ? "bg-[var(--wms-surface-elevated)]" : ""
                          }`}
                        >
                          {/* The same number, in the same colour, as on the
                              guide picture for this garment and side. */}
                          <span
                            aria-hidden
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[0.62rem] font-bold text-black"
                            style={{ background: colorForPom(key), opacity: cm ? 1 : 0.45 }}
                          >
                            {guideNumber(key)}
                          </span>
                          <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold text-[var(--wms-fg)]" : "text-[var(--wms-muted)]"}`}>
                            {pomLabel(key, view)}
                          </span>
                          {cm ? (
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
                          aria-label={`Don't measure ${pomLabel(key, view)}`}
                          title="Don't measure this point"
                          onClick={() => {
                            setDroppedSaved([...dropped, key]);
                            if (selectedPom === key) setSelectedPom(null);
                          }}
                          className="shrink-0 px-2 text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)] max-md:min-h-11"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {dropped.length ? (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                    Not measuring:
                    {dropped.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setDroppedSaved(dropped.filter((k) => k !== key))}
                        className="rounded border border-[var(--wms-border)] px-1.5 py-0.5 text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                        title="Measure this again"
                      >
                        + {pomLabel(key, view)}
                      </button>
                    ))}
                  </p>
                ) : null}
                <p className="mt-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  Drag either end of the highlighted line on the photo. The number follows as you drag, and a
                  magnifier shows what is under your finger. ✕ drops a point you don&apos;t measure.
                </p>
                <GuidePanel type={activeType} view={view} category={pickedItem?.subcategory ?? pickedItem?.category} />
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
                    disabled={!pickedSize || saving || !readings.length || (focus?.verdict === "soft" && !allowSoft)}
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
            <div className="flex flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 text-sm text-[var(--wms-fg)]">
              <p>
                <strong>The app proposes each line; you have the last word.</strong> Nothing is measured from a mask
                you have to supervise — drag an end if a line is in the wrong place, and leave it alone if it is not.
              </p>
              <p className="flex items-center gap-2 text-xs text-[var(--wms-muted)]">
                {finding ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding the garment…
                  </>
                ) : modelMask ? (
                  <span className="text-[var(--wms-status-success-fg)]">
                    Lines proposed from the photo — check each one and drag anything that is off.
                  </span>
                ) : modelFailed ? (
                  <span className="text-[var(--wms-status-warning-fg)]">
                    The background remover could not pick the garment out of this photo ({modelFailed}), so the
                    lines are a rough guess — place them by hand, or shoot against a plainer surface.
                  </span>
                ) : null}
              </p>
            </div>
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
