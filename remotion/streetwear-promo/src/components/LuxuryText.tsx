import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { TextCue } from "../promo/types";
import { BRAND } from "../promo/promoConfig";

export const LuxuryText = ({ cue }: { cue: TextCue }) => {
  const local = useCurrentFrame();
  const opacity = interpolate(
    local,
    [0, 5, cue.durationInFrames - 8, cue.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const slide = interpolate(
    local,
    [0, 10],
    [28, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  if (local < 0 || local >= cue.durationInFrames) {
    return null;
  }

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        paddingLeft: 56,
        paddingRight: 56,
        paddingBottom: 220,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translate3d(0, ${slide}px, 0)`,
        }}
      >
        <div
          style={{
            fontFamily: "Bebas Neue",
            fontSize: 118,
            letterSpacing: 10,
            lineHeight: 0.92,
            color: BRAND.paper,
            textTransform: "uppercase",
            textShadow: "0 12px 48px rgba(0,0,0,0.55)",
          }}
        >
          {cue.line}
        </div>
        {cue.subline ? (
          <div
            style={{
              marginTop: 6,
              fontFamily: "Montserrat",
              fontWeight: 700,
              fontSize: 28,
              letterSpacing: 14,
              color: BRAND.accentSoft,
              textTransform: "uppercase",
            }}
          >
            {cue.subline}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 22,
            width: 120,
            height: 3,
            background: `linear-gradient(90deg, ${BRAND.accent}, transparent)`,
            borderRadius: 2,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
