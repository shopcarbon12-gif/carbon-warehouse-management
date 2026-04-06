import { AbsoluteFill, useCurrentFrame } from "remotion";

export const VignetteAndGrain = () => {
  const frame = useCurrentFrame();
  const flicker = 0.028 + (frame % 7) * 0.0015;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxShadow: "inset 0 0 220px rgba(0,0,0,0.55)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: flicker,
          backgroundImage:
            "url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22><filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22 numOctaves=%222%22 stitchTiles=%22stitch%22/></filter><rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%220.45%22/></svg>')",
        }}
      />
    </AbsoluteFill>
  );
};
