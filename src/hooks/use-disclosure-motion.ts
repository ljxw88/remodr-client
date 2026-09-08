import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { Motion } from '@/constants/motion';
import { useForeground } from '@/hooks/use-foreground';
import { useReducedMotion } from '@/hooks/use-reduce-motion';

export function useDisclosureMotion(open: boolean, active = true) {
  const reducedMotion = useReducedMotion();
  const foreground = useForeground();
  const animate = active && foreground && !reducedMotion;
  const [present, setPresent] = useState(open);
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  const previous = useRef(open);
  const generation = useRef(0);

  if (open && !present) setPresent(true);
  if (!open && !animate && present) setPresent(false);

  useLayoutEffect(() => {
    generation.current++;
    if (!animate) {
      progress.stopAnimation();
      progress.setValue(open ? 1 : 0);
    }
  }, [animate, open, progress]);

  useEffect(() => {
    const changed = previous.current !== open;
    previous.current = open;
    if (!animate || !changed) return;
    const token = generation.current;
    let cancelled = false;
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0, duration: Motion.duration.disclosure,
      easing: Motion.easing.standard, useNativeDriver: false, isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished && !open && !cancelled && generation.current === token) setPresent(false);
    });
    return () => {
      cancelled = true;
      animation.stop();
    };
  }, [animate, open, progress]);

  useEffect(() => () => progress.stopAnimation(), [progress]);
  return { progress, present: open || (animate && present), animate };
}
