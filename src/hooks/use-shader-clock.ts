import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import { useForeground } from '@/hooks/use-foreground';
import { useReducedMotion } from '@/hooks/use-reduce-motion';

/** Ignore very long gaps so resuming never jumps the animation forward. */
const MAX_FRAME_MS = 64;

/**
 * Monotonic millisecond clock for shaders, paused while the app is
 * backgrounded or the screen is not focused.
 *
 * Deliberately accumulates per-frame deltas rather than reading
 * `timeSinceFirstFrame`. `useFrameCallback` re-registers whenever its callback
 * identity changes, and re-registering restarts that timer, so any re-render
 * of the host screen would otherwise rewind the animation to zero.
 */
export function useShaderClock(enabled = true): SharedValue<number> {
  const clock = useSharedValue(0);

  // `useSharedValue` returns a stable container, so an empty dependency list
  // keeps this callback's identity fixed across renders.
  const onFrame = useCallback((info: FrameInfo) => {
    'worklet';
    const delta = info.timeSincePreviousFrame ?? 0;
    clock.value += Math.min(Math.max(delta, 0), MAX_FRAME_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frame = useFrameCallback(onFrame, false);

  const [focused, setFocused] = useState(false);
  const foreground = useForeground();
  const reducedMotion = useReducedMotion();

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    frame.setActive(enabled && focused && foreground && !reducedMotion);
    return () => frame.setActive(false);
  }, [enabled, focused, foreground, frame, reducedMotion]);

  return clock;
}
