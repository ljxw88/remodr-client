import { useFocusEffect } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { RemoteClient, RemoteFile } from '@/domain/remote';
import { toUserMessage } from '@/utils/user-error';
import { normalizeRemoteFolderPath, remoteFolderSftpPath } from './remote-folder-path';

type Location = { readonly hostId: string; readonly path: string; readonly revision: number };
export type DirectoryRequest = { readonly location: Location; readonly sessionId: string };
type Listing = { request: DirectoryRequest; entries: RemoteFile[]; loading: boolean; error: string | null };
const EMPTY_ENTRIES: RemoteFile[] = [];

type Options = {
  hostId: string;
  sessionId: string | null;
  initialPath?: string;
  directoriesOnly?: boolean;
  client: Pick<RemoteClient, 'getSession' | 'sftpList'>;
  onSessionChange: () => void;
};

function sortEntries(entries: RemoteFile[]): RemoteFile[] {
  return entries.filter((entry) => entry.name !== '.' && entry.name !== '..')
    .sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory)
      || Number(left.name.startsWith('.')) - Number(right.name.startsWith('.'))
      || left.name.localeCompare(right.name));
}

export function useRemoteDirectory({
  hostId, sessionId, initialPath = '~', directoriesOnly = false, client, onSessionChange,
}: Options) {
  const [location, setLocation] = useState<Location>(() => ({
    hostId, path: normalizeRemoteFolderPath(initialPath), revision: 0,
  }));
  if (location.hostId !== hostId) {
    setLocation({ hostId, path: normalizeRemoteFolderPath(initialPath), revision: 0 });
  }
  const [listing, setListing] = useState<Listing | null>(null);
  const active = useRef<DirectoryRequest | null>(null);

  useLayoutEffect(() => {
    active.current = null;
    return () => { active.current = null; };
  }, [client, location, sessionId]);

  const sessionCurrent = useCallback((request: DirectoryRequest) => {
    const live = client.getSession(request.location.hostId);
    if (live?.hostId === request.location.hostId && live.sessionId === request.sessionId
      && live.status === 'connected') return true;
    setListing({
      request, entries: [], loading: false, error: 'This device disconnected. Reconnect and try again.',
    });
    onSessionChange();
    return false;
  }, [client, onSessionChange]);

  useFocusEffect(useCallback(() => {
    if (!sessionId) {
      setListing(null);
      return;
    }
    const request: DirectoryRequest = { location, sessionId };
    active.current = request;
    setListing({ request, entries: [], loading: true, error: null });
    void (async () => {
      try {
        if (!sessionCurrent(request)) return;
        const result = await client.sftpList(sessionId, remoteFolderSftpPath(location.path)).then(
          (entries) => ({ ok: true as const, entries }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (active.current !== request || !sessionCurrent(request)) return;
        setListing({
          request,
          loading: false,
          entries: result.ok ? sortEntries(result.entries) : [],
          error: result.ok ? null : toUserMessage(result.error),
        });
      } catch (error) {
        if (active.current === request) {
          setListing({ request, entries: [], loading: false, error: toUserMessage(error) });
        }
      }
    })();
    return () => {
      if (active.current === request) active.current = null;
    };
  }, [client, location, sessionCurrent, sessionId]));

  const navigate = useCallback((path: string) => {
    // Invalidate synchronously, before React commits the next path.
    active.current = null;
    setLocation((current) => ({
      ...current, path: normalizeRemoteFolderPath(path), revision: current.revision + 1,
    }));
  }, []);

  const refresh = useCallback((expected?: DirectoryRequest) => {
    // A delayed mutation in an old folder must not restart the current listing.
    if (expected && active.current !== expected) return;
    active.current = null;
    onSessionChange();
    setLocation((current) => ({ ...current, revision: current.revision + 1 }));
  }, [onSessionChange]);

  const capture = useCallback(() => active.current, []);
  const isCurrent = useCallback((request: DirectoryRequest | null) =>
    request != null && active.current === request && sessionCurrent(request), [sessionCurrent]);
  const cancel = useCallback(() => { active.current = null; setListing(null); }, []);
  const current = listing?.request.location === location && listing.request.sessionId === sessionId ? listing : null;
  const entries = useMemo(() => {
    const entries = current?.entries ?? EMPTY_ENTRIES;
    return directoriesOnly ? entries.filter((entry) => entry.isDirectory) : entries;
  }, [current, directoriesOnly]);

  return {
    path: location.path,
    request: current?.request ?? null,
    entries,
    loading: !!sessionId && (!current || current.loading),
    error: current?.error ?? null,
    ready: current != null && !current.loading && current.error == null,
    navigate, refresh, capture, isCurrent, cancel,
  };
}
