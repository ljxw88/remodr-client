import { useSyncExternalStore } from 'react';

const selections = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Successful creation updates the underlying home filter without route callbacks. */
export function selectWorkspace(deviceId: string, workspaceId: string | null) {
  selections.set(deviceId, workspaceId);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useWorkspaceSelection(deviceId: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => deviceId ? selections.get(deviceId) ?? null : null,
    () => null,
  );
}
