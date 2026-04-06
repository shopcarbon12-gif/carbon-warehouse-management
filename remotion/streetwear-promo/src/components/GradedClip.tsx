import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type { ClipKey } from "../promo/types";
import { CLIP_FILES } from "../promo/promoConfig";

type GradedClipProps = {
  clip: ClipKey;
  durationInFrames: number;
  playbackRate?: number;
  trimBeforeFrames?: number;
  zoomFrom?: number;
  zoomTo?: number;
};

export const GradedClip = ({
  clip,
  durationInFrames,
  playbackRate = 1,
  trimBeforeFrames = 0,
  zoomFrom = 1,
  zoomTo = 1.06,
}: GradedClipProps) => {
  const local = useCurrentFrame();
  const scale = interpolate(
    local,
    [0, Math.max(1, durationInFrames - 1)],
    [zoomFrom, zoomTo],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const src = staticFile(CLIP_FILES[clip]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#050505",
        filter:
          "saturate(0.92) contrast(1.14) brightness(0.96) sepia(0.06)",
      }}
    >
      <Video
        src={src}
        muted
        loop
        playbackRate={playbackRate}
        trimBefore={trimBeforeFrames}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          transformOrigin: "50% 45%",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, transparent 28%, transparent 62%, rgba(0,0,0,0.72) 100%)",
          mixBlendMode: "multiply",
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};
