import { useCallback } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The system's reduced-motion setting, held once for the whole app.
 *
 * Shared, and read at import rather than per caller, because the answer
 * arrives asynchronously and every caller wants it before it does. A hook that
 * fetched its own copy would report `false` for the first moments of its life,
 * and those are exactly the moments a screen mounting into place asks — so the
 * one motion the setting most needs to suppress is the one that would slip
 * past it. Settled during startup instead, long before anywhere can navigate.
 *
 * The subscription is never torn down on purpose: there is one of it, and it
 * lasts as long as the app does.
 */
let reduceMotion = false;

void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
  reduceMotion = value;
});
AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
  reduceMotion = value;
});

/**
 * Whether the system asks for reduced motion, as a getter rather than state.
 *
 * Animations read it at the moment they start, so a change should not force a
 * re-render of everything holding it.
 */
export function useReduceMotion(): () => boolean {
  return useCallback(() => reduceMotion, []);
}
