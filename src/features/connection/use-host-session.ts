import { useSyncExternalStore } from 'react';

import type { SessionSnapshot } from '@/domain/remote';
import { remoteClient } from '@/services/native-remote-client';

export function createSessionSnapshotStore(read: () => SessionSnapshot[]) {
  let listeners: (() => void)[] = [];
  let sessionsByHost = new Map<string, SessionSnapshot>();
  let initialized = false;

  function readSessions(): Map<string, SessionSnapshot> {
    try {
      return new Map(read().map((session) => [session.hostId, session]));
    } catch {
      return new Map();
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    get(hostId: string): SessionSnapshot | null {
      if (!initialized) {
        sessionsByHost = readSessions();
        initialized = true;
      }
      return sessionsByHost.get(hostId) ?? null;
    },
    refresh() {
      sessionsByHost = readSessions();
      initialized = true;
      listeners.forEach((listener) => listener());
    },
  };
}

const sessionStore = createSessionSnapshotStore(() => remoteClient.listSessions());

export function refreshSessions() {
  sessionStore.refresh();
}

export function useHostSession(hostId: string): SessionSnapshot | null {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.get(hostId),
    () => null,
  );
}
