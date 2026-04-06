import { AbsoluteFill, Sequence } from "remotion";
import { EndCard } from "./components/EndCard";
import { FlashAccents } from "./components/FlashAccents";
import { GradedClip } from "./components/GradedClip";
import { LuxuryText } from "./components/LuxuryText";
import { VignetteAndGrain } from "./components/VignetteAndGrain";
import "./loadFonts";
import {
  DURATION_FRAMES,
  END_CARD_FRAMES,
  PROMO_SCENES,
  TEXT_CUES,
  VIDEO_BODY_FRAMES,
} from "./promo/promoConfig";

export const StreetwearPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {PROMO_SCENES.map((scene) => (
        <Sequence
          key={`${scene.from}-${scene.clip}-${scene.durationInFrames}`}
          from={scene.from}
          durationInFrames={scene.durationInFrames}
        >
          <GradedClip
            clip={scene.clip}
            durationInFrames={scene.durationInFrames}
            playbackRate={scene.playbackRate}
            trimBeforeFrames={scene.trimBeforeFrames}
            zoomFrom={scene.zoomFrom}
            zoomTo={scene.zoomTo}
          />
        </Sequence>
      ))}
      <Sequence from={0} durationInFrames={DURATION_FRAMES}>
        <FlashAccents />
        <VignetteAndGrain />
      </Sequence>
      {TEXT_CUES.map((cue) => (
        <Sequence
          key={`text-${cue.from}-${cue.line}`}
          from={cue.from}
          durationInFrames={cue.durationInFrames}
        >
          <LuxuryText cue={cue} />
        </Sequence>
      ))}
      <Sequence
        from={VIDEO_BODY_FRAMES}
        durationInFrames={END_CARD_FRAMES}
      >
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
};
