import { useCallback, useSyncExternalStore } from 'react';
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
let reduceMotion = true;
let preferenceRevision = 0;
const listeners = new Set<(enabled: boolean) => void>();

function updateReduceMotion(value: boolean) {
  reduceMotion = value;
  listeners.forEach((listener) => listener(value));
}

void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
  if (preferenceRevision === 0) updateReduceMotion(value);
}).catch((error: unknown) => {
  console.warn('[MOTION] Could not read reduced-motion preference', error);
});
AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
  preferenceRevision++;
  updateReduceMotion(value);
});

export function subscribeReduceMotion(listener: (enabled: boolean) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Whether the system asks for reduced motion, as a getter rather than state.
 *
 * Animations read it at the moment they start, so a change should not force a
 * re-render of everything holding it.
 */
export function useReduceMotion(): () => boolean {
  return useCallback(() => reduceMotion, []);
}

export function getReducedMotion() { return reduceMotion; }

/** Long-running motion must react immediately when the preference changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getReducedMotion, () => true);
}
