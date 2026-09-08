import { useSyncExternalStore } from 'react';

import { connectionSupervisor } from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';

export { useForeground } from '@/hooks/use-foreground';

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
