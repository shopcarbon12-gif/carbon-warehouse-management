export type ClipKey = "macro" | "medium" | "full";

export type PromoScene = {
  from: number;
  clip: ClipKey;
  durationInFrames: number;
  playbackRate?: number;
  trimBeforeFrames?: number;
  zoomFrom?: number;
  zoomTo?: number;
};

export type TextCue = {
  from: number;
  durationInFrames: number;
  line: string;
  subline?: string;
};
