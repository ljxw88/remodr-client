import { useCallback, useMemo, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { useReduceMotion } from '@/hooks/use-reduce-motion';

/**
 * How an arriving screen settles into place.
 *
 * It starts a little short of where it belongs and a little short of solid,
 * then closes the gap. Nothing slides in from off-screen and nothing dissolves
 * into anything else — there is only ever one screen on show, which is what
 * keeps a change of place from reading as two screens arguing over the same
 * ground.
 *
 * Small on purpose. It is not there to be watched; it is there so a screen
 * that swapped in an instant still reads as having arrived.
 */
const Entrance = {
  opacityFrom: 0.82,
  opacityDuration: 180,
  offsetFrom: 12,
  offsetDuration: 210,
};

/**
 * The motion above, and a way to run it.
 *
 * The trigger is left to the caller because the two places that settle do not
 * agree on when. The dock keeps its content mounted and settles it whenever the
 * tab changes; a pushed stack mounts fresh and settles once, on arrival. Only
 * the motion is shared, so the app has one answer to what arriving looks like.
 *
 * `direction` is which way the screen comes from: forward is 1, back is -1.
 */
export function useScreenEntrance() {
  const [opacity] = useState(() => new Animated.Value(1));
  const [translateX] = useState(() => new Animated.Value(0));
  const shouldReduceMotion = useReduceMotion();

  const play = useCallback(
    (direction: 1 | -1 = 1) => {
      if (shouldReduceMotion()) {
        opacity.setValue(1);
        translateX.setValue(0);
        return;
      }

      opacity.setValue(Entrance.opacityFrom);
      translateX.setValue(direction * Entrance.offsetFrom);

      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: Entrance.opacityDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: Entrance.offsetDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    },
    [opacity, shouldReduceMotion, translateX],
  );

  return useMemo(
    // Stable across renders on purpose. Callers reach for this from an effect,
    // and an identity that changed every pass would replay the arrival every
    // time anything above re-rendered.
    () => ({ style: { opacity, transform: [{ translateX }] }, play }),
    [opacity, play, translateX],
  );
}
