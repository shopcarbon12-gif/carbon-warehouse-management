import { Composition } from "remotion";
import { StreetwearPromo } from "./StreetwearPromo";
import {
  DURATION_FRAMES,
  FPS,
  HEIGHT,
  WIDTH,
} from "./promo/promoConfig";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="StreetwearPromo"
        component={StreetwearPromo}
        durationInFrames={DURATION_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
