import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { Motion } from '@/constants/motion';

import { subscribeReduceMotion, useReduceMotion } from '@/hooks/use-reduce-motion';

export const CONTENT_REVEAL_DURATION = Motion.duration.reveal;

/** Animate list content only: never a blur target, floating chrome, or an entire screen. */
export function useContentReveal(loading: boolean, scope = '') {
  const [opacity] = useState(() => new Animated.Value(1));
  const previous = useRef({ loading, scope });
  const revealing = useRef(false);
  const reduceMotion = useReduceMotion();

  useLayoutEffect(() => {
    const reveal = previous.current.scope === scope && previous.current.loading && !loading;
    previous.current = { loading, scope };
    revealing.current = reveal && !reduceMotion();
    opacity.stopAnimation();
    // Keep arriving content visible from its first frame rather than inserting a blank frame.
    opacity.setValue(revealing.current ? 0.35 : 1);
  }, [loading, opacity, reduceMotion, scope]);

  useEffect(() => {
    if (!revealing.current || reduceMotion()) return;
    // Animated host bindings must finish detaching/attaching before the native driver starts.
    const animation = Animated.timing(opacity, {
      toValue: 1, duration: CONTENT_REVEAL_DURATION,
      easing: Motion.easing.entrance, useNativeDriver: true, isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [loading, opacity, reduceMotion, scope]);

  useLayoutEffect(() => {
    const unsubscribe = subscribeReduceMotion((enabled) => {
      if (enabled) {
        opacity.stopAnimation();
        opacity.setValue(1);
      }
    });
    return () => {
      unsubscribe();
      opacity.stopAnimation();
    };
  }, [opacity]);

  return { opacity };
}
