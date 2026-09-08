import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { Motion } from '@/constants/motion';
import { useForeground } from '@/hooks/use-foreground';
import { useReducedMotion } from '@/hooks/use-reduce-motion';

/** Keys describe semantic states, never changing countdown text or message content. */
export function useStatusFeedback(key: string | null, active = true) {
  const reducedMotion = useReducedMotion();
  const foreground = useForeground();
  const [opacity] = useState(() => new Animated.Value(1));
  const previous = useRef(key);
  const reveal = useRef(false);
  const enabled = active && foreground && !reducedMotion;

  useLayoutEffect(() => {
    reveal.current = enabled && key != null && previous.current !== key;
    previous.current = key;
    opacity.stopAnimation();
    opacity.setValue(reveal.current ? 0.6 : 1);
  }, [enabled, key, opacity]);

  useEffect(() => {
    if (!reveal.current) return;
    const animation = Animated.timing(opacity, {
      toValue: 1, duration: Motion.duration.fade, easing: Motion.easing.entrance,
      useNativeDriver: true, isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [enabled, key, opacity]);

  useEffect(() => () => opacity.stopAnimation(), [opacity]);
  return { opacity };
}
