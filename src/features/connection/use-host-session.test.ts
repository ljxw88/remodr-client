import type { SessionSnapshot } from '@/domain/remote';
import { createSessionSnapshotStore } from '@/features/connection/use-host-session';

const connected: SessionSnapshot = {
  sessionId: 'session-1',
  hostId: 'host-1',
  status: 'connected',
};

describe('session snapshot store', () => {
  it('returns a stable object until the store is refreshed', () => {
    const store = createSessionSnapshotStore(() => [{ ...connected }]);

    const first = store.get('host-1');
    const second = store.get('host-1');

    expect(second).toBe(first);
  });

  it('publishes a new stable snapshot after refresh', () => {
    const store = createSessionSnapshotStore(() => [{ ...connected }]);
    const listener = jest.fn();
    store.subscribe(listener);
    const first = store.get('host-1');

    store.refresh();
    const refreshed = store.get('host-1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(refreshed).not.toBe(first);
    expect(store.get('host-1')).toBe(refreshed);
  });
});
