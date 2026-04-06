import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BRAND } from "../promo/promoConfig";

export const EndCard = () => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame: local,
    fps,
    config: { damping: 18 },
  });

  const opacity = interpolate(local, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 80% at 50% 20%, #151515 0%, #050505 55%, #000 100%)",
        justifyContent: "center",
        alignItems: "center",
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${0.92 + enter * 0.08}) translateY(${(1 - enter) * 24}px)`,
          textAlign: "center",
          padding: 48,
        }}
      >
        <div
          style={{
            width: 112,
            height: 112,
            margin: "0 auto 28px",
            borderRadius: 999,
            border: `2px solid ${BRAND.accent}`,
            boxShadow: `0 0 0 1px rgba(201,169,98,0.35), 0 24px 80px rgba(0,0,0,0.65)`,
            display: "grid",
            placeItems: "center",
            fontFamily: "Montserrat, sans-serif",
            fontWeight: 700,
            fontSize: 36,
            letterSpacing: 6,
            color: BRAND.paper,
          }}
        >
          Ø
        </div>
        <div
          style={{
            fontFamily: "Bebas Neue, Impact, sans-serif",
            fontSize: 112,
            letterSpacing: 14,
            color: BRAND.paper,
            lineHeight: 0.95,
          }}
        >
          SHOP NOW
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: "Montserrat, sans-serif",
            fontWeight: 500,
            fontSize: 26,
            letterSpacing: 18,
            color: BRAND.accentSoft,
            textTransform: "uppercase",
          }}
        >
          Street luxury
        </div>
      </div>
    </AbsoluteFill>
  );
};
