import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const listeners = new Set<() => void>();
// One application-lifetime listener, shared by screen and motion subscribers.
AppState.addEventListener('change', () => listeners.forEach((listener) => listener()));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function isForeground() { return AppState.currentState === 'active'; }

export function useForeground() {
  return useSyncExternalStore(subscribe, isForeground, () => false);
}
