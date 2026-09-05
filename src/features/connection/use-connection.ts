import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { connectionSupervisor } from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';

export function useConnectionSnapshot(deviceId?: string | null) {
  const snapshots = useSyncExternalStore(
    connectionSupervisor.subscribe,
    connectionSupervisor.getSnapshot,
    connectionSupervisor.getSnapshot,
  );
  return deviceId ? snapshots[deviceId] : undefined;
}

export function usePendingCommands() {
  return useSyncExternalStore(
    herdrRepository.subscribeCommands,
    herdrRepository.getPendingCommands,
    herdrRepository.getPendingCommands,
  );
}

function subscribeForeground(listener: () => void) {
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}

function isForeground() {
  return AppState.currentState === 'active';
}

export function useForeground() {
  return useSyncExternalStore(subscribeForeground, isForeground, () => false);
}
