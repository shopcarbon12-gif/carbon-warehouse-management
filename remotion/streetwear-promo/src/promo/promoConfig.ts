import type { ClipKey, PromoScene, TextCue } from "./types";

/** 9:16 social vertical */
export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** Total composition length (15–25s brief → 22s) */
export const DURATION_FRAMES = 22 * FPS;

/** Branded end card (no clip swap needed) */
export const END_CARD_FRAMES = Math.round(2.4 * FPS);

/** All clip-backed frames */
export const VIDEO_BODY_FRAMES = DURATION_FRAMES - END_CARD_FRAMES;

/** Public folder paths (swap files here; keep names or update `CLIP_FILES`) */
export const CLIP_FILES: Record<ClipKey, string> = {
  macro: "clips/extreme-macro.mp4",
  medium: "clips/medium-shot.mp4",
  full: "clips/full-body.mp4",
};

/** Luxury palette — tweak for brand */
export const BRAND = {
  accent: "#c9a962",
  accentSoft: "rgba(201, 169, 98, 0.92)",
  ink: "#0a0a0a",
  paper: "#f4f0e8",
  muted: "rgba(244, 240, 232, 0.55)",
} as const;

type SceneSpec = Omit<PromoScene, "from">;

function montage(
  targetFrames: number,
  seed: { pattern: number[]; rates: number[] },
): SceneSpec[] {
  const order: ClipKey[] = ["macro", "medium", "full"];
  const out: SceneSpec[] = [];
  let used = 0;
  let i = 0;
  while (used < targetFrames) {
    const d0 = seed.pattern[i % seed.pattern.length];
    const d = Math.min(d0, targetFrames - used);
    out.push({
      clip: order[i % order.length],
      durationInFrames: d,
      playbackRate: seed.rates[i % seed.rates.length],
      zoomFrom: 1 + (i % 4) * 0.01,
      zoomTo: 1.05 + (i % 5) * 0.02,
    });
    used += d;
    i += 1;
  }
  return out;
}

/**
 * Hook → fast montage → hero holds → rhythm montage → intensity → hand off to end card.
 * Totals exactly `VIDEO_BODY_FRAMES`.
 */
function buildSceneSpecs(): SceneSpec[] {
  const hook: SceneSpec[] = [
    {
      clip: "macro",
      durationInFrames: 26,
      playbackRate: 1.14,
      zoomFrom: 1.08,
      zoomTo: 1.22,
      trimBeforeFrames: 0,
    },
    {
      clip: "medium",
      durationInFrames: 16,
      playbackRate: 1.26,
      zoomFrom: 1,
      zoomTo: 1.1,
    },
    {
      clip: "full",
      durationInFrames: 14,
      playbackRate: 1.18,
      zoomFrom: 1,
      zoomTo: 1.06,
    },
  ];

  const montageA = montage(168, {
    pattern: [12, 11, 13, 10, 14, 11, 12, 13, 11, 12, 14, 10],
    rates: [1.12, 1.18, 1.22, 1.28, 1.16, 1.24, 1.32, 1.2],
  });

  const hero: SceneSpec[] = [
    {
      clip: "full",
      durationInFrames: 48,
      playbackRate: 1.02,
      zoomFrom: 1,
      zoomTo: 1.08,
    },
    {
      clip: "medium",
      durationInFrames: 42,
      playbackRate: 1.05,
      zoomFrom: 1,
      zoomTo: 1.07,
    },
    {
      clip: "macro",
      durationInFrames: 36,
      playbackRate: 1.08,
      zoomFrom: 1.04,
      zoomTo: 1.14,
    },
  ];

  const montageB = montage(118, {
    pattern: [11, 13, 10, 12, 14, 11, 12, 13],
    rates: [1.22, 1.3, 1.18, 1.26, 1.34, 1.2, 1.28],
  });

  const intensity: SceneSpec[] = [
    { clip: "macro", durationInFrames: 18, playbackRate: 1.38, zoomFrom: 1.06, zoomTo: 1.2 },
    { clip: "full", durationInFrames: 20, playbackRate: 1.32, zoomFrom: 1, zoomTo: 1.09 },
    { clip: "medium", durationInFrames: 16, playbackRate: 1.36, zoomFrom: 1, zoomTo: 1.11 },
    { clip: "macro", durationInFrames: 14, playbackRate: 1.42, zoomFrom: 1.08, zoomTo: 1.18 },
    { clip: "full", durationInFrames: 22, playbackRate: 1.24, zoomFrom: 1, zoomTo: 1.1 },
    { clip: "medium", durationInFrames: 15, playbackRate: 1.4, zoomFrom: 1, zoomTo: 1.12 },
  ];

  const specs: SceneSpec[] = [
    ...hook,
    ...montageA,
    ...hero,
    ...montageB,
    ...intensity,
  ];
  const sum = specs.reduce((a, s) => a + s.durationInFrames, 0);
  const delta = VIDEO_BODY_FRAMES - sum;
  if (delta !== 0 && specs.length > 0) {
    const last = specs[specs.length - 1];
    last.durationInFrames = Math.max(6, last.durationInFrames + delta);
  }
  return specs;
}

export const PROMO_SCENES: PromoScene[] = (() => {
  const specs = buildSceneSpecs();
  let from = 0;
  return specs.map((s) => {
    const scene: PromoScene = { ...s, from };
    from += s.durationInFrames;
    return scene;
  });
})();

/** Minimal luxury captions — edit copy here */
export const TEXT_CUES: TextCue[] = [
  { from: 2, durationInFrames: 21, line: "NEW DROP" },
  { from: 52, durationInFrames: 20, line: "STREET", subline: "LUXURY" },
  { from: 168, durationInFrames: 24, line: "LIMITED", subline: "RELEASE" },
  { from: 282, durationInFrames: 26, line: "BUILT", subline: "DIFFERENT" },
  { from: 420, durationInFrames: 22, line: "EXCLUSIVE", subline: "ACCESS" },
];

/**
 * Optional beat grid for flashes (no audio in project — align when you add a track).
 * Replace with real beat frames from your DAW / Rekordbox export.
 */
export const BEAT_FRAMES: number[] = [
  0, 8, 15, 23, 30, 38, 45, 53, 60, 68, 75, 83, 90, 98, 105, 113, 120, 128, 135, 143, 150,
  158, 165, 173, 180, 188, 195, 203, 210, 218, 225, 233, 240, 248, 255, 263, 270, 278, 285,
  293, 300, 308, 315, 323, 330, 338, 345, 353, 360, 368, 375, 383, 390, 398, 405, 413, 420, 428,
  435, 443, 450, 458, 465, 473, 480, 488, 495, 503, 510, 518, 525, 533, 540, 548, 555, 563, 570,
  578, 585, 593, 600, 608, 615, 623, 630, 638, 645, 653,
];
