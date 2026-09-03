import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import {
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * Milliseconds since mount, paused while the app is backgrounded or the screen
 * is not focused. Skia's own `useClock` requests a frame every vsync forever,
 * which keeps the GPU awake and prevents the display dropping to a low refresh
 * rate, so animated shaders must gate their own clock.
 */
export function useShaderClock(enabled = true): SharedValue<number> {
  const clock = useSharedValue(0);
  const frame = useFrameCallback((info) => {
    'worklet';
    clock.value = info.timeSinceFirstFrame;
  }, false);

  useEffect(() => {
    frame.setActive(enabled && AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) => {
      frame.setActive(enabled && state === 'active');
    });
    return () => subscription.remove();
  }, [enabled, frame]);

  useFocusEffect(
    useCallback(() => {
      frame.setActive(enabled && AppState.currentState === 'active');
      return () => frame.setActive(false);
    }, [enabled, frame]),
  );

  return clock;
}
