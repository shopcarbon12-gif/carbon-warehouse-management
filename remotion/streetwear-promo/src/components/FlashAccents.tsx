import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BEAT_FRAMES, DURATION_FRAMES, END_CARD_FRAMES } from "../promo/promoConfig";

const beatSet = new Set(BEAT_FRAMES);

export const FlashAccents = () => {
  const frame = useCurrentFrame();
  const inBody = frame < DURATION_FRAMES - END_CARD_FRAMES;

  const onBeat = beatSet.has(frame);
  const flash = onBeat
    ? interpolate((frame % 3) + 1, [1, 3], [0.07, 0.02], {
        extrapolateRight: "clamp",
      })
    : 0;

  const strobeWindow = inBody && frame > 390 && frame < 560 && frame % 9 === 0;
  const strobe = strobeWindow ? 0.045 : 0;

  const leak = interpolate(
    frame,
    [120, 200, 320, 400],
    [0.12, 0.22, 0.16, 0.2],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 78% 12%, rgba(255,240,210,${leak * 0.35}) 0%, transparent 42%)`,
          opacity: inBody ? 1 : 0.35,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(120deg, rgba(255,255,255,${flash}) 0%, transparent 55%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `rgba(255,255,255,${strobe})`,
        }}
      />
    </AbsoluteFill>
  );
};
