import { useCallback, useMemo, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { useReduceMotion } from '@/hooks/use-reduce-motion';

/**
 * How an arriving screen settles into place.
 *
 * It starts a short step from where it belongs and closes the gap. Nothing
 * slides in from off-screen and nothing dissolves into anything else — there is
 * only ever one screen on show, which is what keeps a change of place from
 * reading as two screens arguing over the same ground.
 *
 * Movement only, no fade, and that is not a matter of taste. Android applies a
 * view's alpha to each of its children in turn rather than to the finished
 * picture, so a screen at less than full opacity is one whose own layers all
 * show through each other: fade the chat in and the transcript appears *inside*
 * the composer, which is opaque precisely so that it never does. The way round
 * it is to force the whole screen into a hardware texture for the duration,
 * which costs a screenful of memory and a frame at each end to buy an effect
 * that was doing less work here than the step is.
 *
 * The step is safe by comparison because it is honest about geometry: what it
 * uncovers at the edge is the canvas the screen already sits on, which
 * `RouteStack` paints outside the moving part for exactly this reason.
 */
const Entrance = {
  offsetFrom: 24,
  duration: 300,
};

/**
 * The motion above, and a way to run it.
 *
 * The trigger is left to the caller because the two places that settle do not
 * agree on when. The dock keeps its content mounted and settles it whenever the
 * tab changes; a pushed stack mounts fresh and settles once, on arrival, and
 * the tab it uncovers settles again on the way back. Only the motion is shared,
 * so the app has one answer to what arriving looks like.
 *
 * `direction` is which way the screen comes from: forward is 1, back is -1.
 */
export function useScreenEntrance() {
  const [translateX] = useState(() => new Animated.Value(0));
  const shouldReduceMotion = useReduceMotion();

  const play = useCallback(
    (direction: 1 | -1 = 1) => {
      if (shouldReduceMotion()) {
        translateX.setValue(0);
        return;
      }

      translateX.setValue(direction * Entrance.offsetFrom);

      Animated.timing(translateX, {
        toValue: 0,
        duration: Entrance.duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [shouldReduceMotion, translateX],
  );

  return useMemo(
    // Stable across renders on purpose. Callers reach for this from an effect,
    // and an identity that changed every pass would replay the arrival every
    // time anything above re-rendered.
    () => ({ style: { transform: [{ translateX }] }, play }),
    [play, translateX],
  );
}
