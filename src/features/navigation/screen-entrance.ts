import { useCallback, useEffect, useMemo, useState } from 'react';
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
  offsetFrom: 16,
  duration: 200,
};

export type EntranceDirection = 1 | -1;

/**
 * The motion above, and a way to run it.
 *
 * Arriving is two acts, and keeping them apart is the whole point. **Arming**
 * puts the screen at its starting offset; it is only ever correct while nobody
 * can see the screen — before it is composited on a push, or behind the page
 * still being dismissed on a return. **Settling** closes the gap, and belongs
 * at the moment the screen actually appears.
 *
 * Running the two together is what an arrival must never do once the screen is
 * up: a screen armed after it is already on show jumps sideways and then slides
 * back, which reads as a stutter rather than an arrival. `play` is for the one
 * caller where the two genuinely coincide — the dock, whose content stays
 * mounted and on screen, so the arming lands in the same commit that swaps the
 * tab and is painted with it.
 *
 * `direction` is which way the screen comes from: forward is 1, back is -1.
 */
export function useScreenEntrance() {
  const [translateX] = useState(() => new Animated.Value(0));
  const shouldReduceMotion = useReduceMotion();

  const reset = useCallback(() => {
    translateX.stopAnimation();
    translateX.setValue(0);
  }, [translateX]);

  useEffect(() => reset, [reset]);

  /** Put the screen where it starts from. Only while it cannot be seen. */
  const arm = useCallback(
    (direction: EntranceDirection = 1) => {
      translateX.stopAnimation();
      translateX.setValue(shouldReduceMotion() ? 0 : direction * Entrance.offsetFrom);
    },
    [shouldReduceMotion, translateX],
  );

  /** Close the gap. Harmless when nothing was armed: the gap is already nil. */
  const settle = useCallback(() => {
    if (shouldReduceMotion()) {
      reset();
      return;
    }

    Animated.timing(translateX, {
      toValue: 0,
      duration: Entrance.duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [reset, shouldReduceMotion, translateX]);

  const play = useCallback(
    (direction: EntranceDirection = 1) => {
      arm(direction);
      settle();
    },
    [arm, settle],
  );

  return useMemo(
    // Stable across renders on purpose. Callers reach for this from an effect,
    // and an identity that changed every pass would replay the arrival every
    // time anything above re-rendered.
    () => ({ style: { transform: [{ translateX }] }, arm, settle, play, reset }),
    [arm, play, reset, settle, translateX],
  );
}
