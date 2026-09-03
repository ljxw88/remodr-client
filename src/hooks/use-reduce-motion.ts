import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the system asks for reduced motion, as a getter rather than state.
 *
 * Animations read it at the moment they start, so a change should not force a
 * re-render of everything holding it.
 */
export function useReduceMotion(): () => boolean {
  const enabled = useRef(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      enabled.current = value;
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value) => {
        enabled.current = value;
      },
    );
    return () => subscription.remove();
  }, []);

  return useCallback(() => enabled.current, []);
}
