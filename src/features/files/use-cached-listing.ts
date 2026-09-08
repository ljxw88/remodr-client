import { useState } from 'react';

import type { RemoteFile } from '@/domain/remote';

const EMPTY_ENTRIES: RemoteFile[] = [];

/** Presentation-only retention; mutation authority still comes from the live directory request. */
export function useCachedListing({ hostId, sessionId, path, ready, entries }: {
  hostId: string;
  sessionId: string | null;
  path: string;
  ready: boolean;
  entries: RemoteFile[];
}) {
  const scope = JSON.stringify([hostId, sessionId, path]);
  const [cached, setCached] = useState<{ scope: string; entries: RemoteFile[] } | null>(
    () => sessionId && ready ? { scope, entries } : null,
  );
  const current = sessionId
    ? ready ? { scope, entries } : cached?.scope === scope ? cached : null
    : null;
  if (cached?.scope !== current?.scope || cached?.entries !== current?.entries) setCached(current);
  return {
    available: current != null,
    entries: current?.entries ?? EMPTY_ENTRIES,
  };
}
