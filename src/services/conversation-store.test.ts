import { ConnectionError } from '@/domain/connection-error';
import { remoteAgentSchema, type AgentConversation, type RemoteAgent } from '@/domain/herdr';
import { ConversationStore, type ConversationSource } from './conversation-store';
import copilotSessionContract from '../../modules/remote-core/bridge/fixtures/protocol/copilot-session-replacement.json';

const key = (id = 'a') => `remote-workspace.herdr.conversation.${id}`;

function agent(id = 'a', session = 'old'): RemoteAgent {
  return remoteAgentSchema.parse({
    id, provider: 'copilot', providerSessionId: session, paneId: id,
    herdrSessionId: 'default', workspaceId: 'workspace', workspaceName: 'Workspace',
    status: 'idle', title: id, focused: true, capabilities: {},
  });
}

function transcript(id = 'a', session = 'old', text = session): AgentConversation {
  return {
    agentId: id, provider: 'copilot', providerSessionId: session, semantic: true,
    items: text ? [{ kind: 'assistant_message', id: `${session}:reply`, markdown: text }] : [],
    activeHumanRequest: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(initial = [agent()]) {
  let agents = new Map(initial.map((entry) => [entry.id, entry]));
  let attachment = 0;
  const disk = new Map<string, string>();
  const storage = {
    getItem: jest.fn(async (key: string) => disk.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { disk.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { disk.delete(key); }),
  };
  const read = jest.fn<Promise<unknown>, [string]>(async (id) =>
    transcript(id, agents.get(id)?.providerSessionId ?? 'old'));
  const refreshIdentity = jest.fn(async () => undefined);
  const onRead = jest.fn(async (_conversation: AgentConversation) => undefined);
  const open = jest.fn((id: string) => {
    if (!agents.has(id)) throw new Error('Agent unavailable');
    const current = attachment;
    return {
      read: () => read(id),
      refreshIdentity,
      assertAttached: () => {
        if (current !== attachment) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Stale attachment');
      },
    };
  });
  const source: ConversationSource = { getAgent: (id) => agents.get(id), open };
  const store = new ConversationStore(source, storage, onRead);
  return {
    store, storage, disk, read, onRead, open, refreshIdentity,
    install(next: RemoteAgent[]) {
      const previous = [...agents.values()];
      agents = new Map(next.map((entry) => [entry.id, entry]));
      return store.reconcileAgents(previous, next);
    },
    detach() {
      attachment++;
      store.detach([...agents.keys()]);
    },
  };
}

describe('ConversationStore ownership', () => {
  let warning: jest.SpyInstance;
  beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it('keeps stable snapshots on unchanged reads without exposing delivery overlays', async () => {
    const { store, onRead, storage, read } = setup();
    const empty = store.getSnapshot();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    await store.load('a');
    const first = store.getSnapshot();
    expect(first).not.toBe(empty);
    expect(empty.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.load('a');
    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(store.get('a')?.items).toEqual(transcript().items);
    unsubscribe();
    read.mockResolvedValue(transcript('a', 'old', 'Updated'));
    await store.load('a');
    expect(first.get('a')?.items).toEqual(transcript().items);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('coalesces through durable consumption, propagates failure, and permits retry', async () => {
    const { store, read, onRead } = setup();
    const consuming = deferred<void>();
    const began = deferred<void>();
    onRead.mockImplementationOnce(() => { began.resolve(); return consuming.promise; });
    const first = store.load('a');
    const firstFailure = expect(first).rejects.toThrow('durable write failed');
    await began.promise;
    const second = store.load('a');
    expect(second).toBe(first);
    expect(store.get('a')).toEqual(transcript());
    consuming.reject(new Error('durable write failed'));
    await firstFailure;
    expect(read).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
    await store.load('a');
    expect(onRead).toHaveBeenCalledTimes(2);
  });

  it('does not block another agent while a read is waiting', async () => {
    const { store, read } = setup([agent(), agent('b')]);
    const slow = deferred<unknown>();
    const began = deferred<void>();
    read.mockImplementationOnce(() => { began.resolve(); return slow.promise; });
    const first = store.load('a');
    await began.promise;
    await expect(store.load('b')).resolves.toEqual(transcript('b'));
    expect(store.get('a')).toBeNull();
    slow.resolve(transcript());
    await first;
    expect(store.getSnapshot().size).toBe(2);
  });

  it('publishes and consumes live output without waiting for disk, then retries a failed unchanged write', async () => {
    const { store, storage, onRead } = setup();
    const writing = deferred<void>();
    storage.setItem.mockReturnValueOnce(writing.promise);
    await expect(store.load('a')).resolves.toEqual(transcript());
    expect(store.get('a')).toEqual(transcript());
    expect(onRead).toHaveBeenCalledWith(transcript());
    writing.reject(new Error('disk full'));
    // Drain the cache's diagnostic handler without coupling load completion to disk.
    await writing.promise.catch(() => undefined);
    await Promise.resolve();
    await store.load('a');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      '[CONVERSATION_CACHE] Could not persist cached transcript', 'a', expect.any(Error),
    );
  });

  it('restores offline history without a request or durable-consumer side effect', async () => {
    const { store, disk, open, onRead, install } = setup([]);
    disk.set(key(), JSON.stringify(transcript()));
    await store.restore('a');
    expect(store.get('a')).toEqual(transcript());
    expect(open).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
    await install([agent('a', 'replacement')]);
    expect(store.get('a')).toBeNull();
    expect(disk.has(key())).toBe(false);
  });

  it('retains the transcript when runtime changes do not replace its session', async () => {
    const { store, storage, install } = setup();
    await store.load('a');
    const previous = store.getSnapshot();
    const listener = jest.fn();
    store.subscribe(listener);
    await install([{ ...agent(), status: 'working', title: 'Renamed', lastOutputAt: 123 }]);
    expect(store.getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'schema', 'wrong-agent', 'wrong-session', 'legacy'])(
    'discards %s cache contents and obtains an authoritative conversation',
    async (kind) => {
      const { store, disk, storage } = setup();
      const { providerSessionId: _session, ...legacy } = transcript();
      disk.set(key(), kind === 'malformed' ? '{broken' : JSON.stringify(
        kind === 'schema' ? { agentId: 'a' } : kind === 'wrong-agent' ? transcript('b')
          : kind === 'wrong-session' ? transcript('a', 'different') : legacy,
      ));
      await store.load('a');
      expect(store.get('a')).toEqual(transcript());
      expect(storage.removeItem).toHaveBeenCalledWith(key());
    },
  );

  it('does not interpret a failed cache read as corruption or fail the online request', async () => {
    const { store, storage } = setup();
    storage.getItem.mockRejectedValueOnce(new Error('read failed'));
    await expect(store.load('a')).resolves.toEqual(transcript());
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '[CONVERSATION_CACHE] Could not read cached transcript', 'a', expect.any(Error),
    );
  });

  it('coalesces restores and fences slow disk results across a session change', async () => {
    const { store, storage, install } = setup();
    const old = deferred<string>();
    storage.getItem.mockReturnValueOnce(old.promise);
    const first = store.restore('a');
    expect(store.restore('a')).toBe(first);
    await install([agent('a', 'new')]);
    old.resolve(JSON.stringify(transcript()));
    await first;
    expect(store.get('a')).toBeNull();
    await expect(store.load('a')).resolves.toEqual(transcript('a', 'new'));
  });

  it('fences detached requests before parsing and does not erase a replacement in-flight read', async () => {
    const { store, read, detach } = setup();
    const old = deferred<unknown>();
    const fresh = deferred<unknown>();
    const oldStarted = deferred<void>();
    const freshStarted = deferred<void>();
    read.mockImplementationOnce(() => { oldStarted.resolve(); return old.promise; })
      .mockImplementationOnce(() => { freshStarted.resolve(); return fresh.promise; });
    const first = store.load('a');
    const failure = expect(first).rejects.toMatchObject({ code: 'ERR_BRIDGE_CLOSED' });
    await oldStarted.promise;
    detach();
    const second = store.load('a');
    await freshStarted.promise;
    old.resolve({ malformed: true });
    await failure;
    expect(store.load('a')).toBe(second);
    fresh.resolve(transcript());
    await second;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rechecks the attachment after durable consumption finishes', async () => {
    const { store, onRead, detach } = setup();
    const consuming = deferred<void>();
    const began = deferred<void>();
    onRead.mockImplementationOnce(() => { began.resolve(); return consuming.promise; });
    const loading = store.load('a');
    const failure = expect(loading).rejects.toMatchObject({ code: 'ERR_BRIDGE_CLOSED' });
    await began.promise;
    detach();
    consuming.resolve();
    await failure;
    expect(store.get('a')).toEqual(transcript());
  });

  it('refreshes a mismatched identity and retries only once', async () => {
    const { store, read, refreshIdentity, install } = setup();
    read.mockResolvedValue(transcript('a', 'new'));
    refreshIdentity.mockImplementationOnce(() => install([agent('a', 'new')]));
    await expect(store.load('a')).resolves.toEqual(transcript('a', 'new'));
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(transcript('a', 'unresolvable'));
    await expect(store.load('a')).rejects.toMatchObject({ code: 'CONVERSATION_SESSION_CHANGED' });
    expect(read).toHaveBeenCalledTimes(4);
    expect(store.get('a')).toEqual(transcript('a', 'new'));
  });

  it('applies the shared Python session-replacement contract without retaining the old question', async () => {
    const [before, after] = copilotSessionContract.frames;
    const id = before.conversation.agentId;
    const { store, read, install } = setup([remoteAgentSchema.parse({ ...agent(id), ...before.session })]);
    read.mockResolvedValueOnce(before.conversation);
    await expect(store.load(id)).resolves.toStrictEqual(before.conversation);
    expect(store.get(id)?.activeHumanRequest).toStrictEqual(before.conversation.activeHumanRequest);
    await install([remoteAgentSchema.parse({ ...agent(id), ...after.session })]);
    expect(store.get(id)).toBeNull();
    read.mockResolvedValueOnce(after.conversation);
    await expect(store.load(id)).resolves.toStrictEqual(after.conversation);
    expect(store.get(id)?.activeHumanRequest).toBeNull();
    expect(store.get(id)?.items).toStrictEqual([]);
  });

  it('binds legacy live responses only to the unchanged requested identity', async () => {
    const { store, read } = setup();
    const { providerSessionId: _session, ...legacy } = transcript();
    read.mockResolvedValue(legacy);
    await expect(store.load('a')).resolves.toEqual(transcript());
  });

  it.each([
    transcript('another-agent'),
    { ...transcript(), provider: 'codex' },
  ])('rejects a response from another agent/provider before publication', async (response) => {
    const { store, read, storage, onRead } = setup();
    read.mockResolvedValue(response);
    await expect(store.load('a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(store.get('a')).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });

  it('orders session eviction behind an old write without blocking new-session display', async () => {
    const { store, storage, disk, install } = setup([agent(), agent('b')]);
    await store.load('b');
    const b = store.get('b');
    const writing = deferred<void>();
    const operations: string[] = [];
    storage.setItem.mockImplementation(async (cacheKey, value) => {
      const session = JSON.parse(value).providerSessionId;
      operations.push(`write:${session}`);
      if (session === 'old') await writing.promise;
      disk.set(cacheKey, value);
    });
    storage.removeItem.mockImplementation(async (cacheKey) => {
      operations.push('remove');
      disk.delete(cacheKey);
    });
    await store.load('a');
    const invalidating = install([agent('a', 'new'), agent('b')]);
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBe(b);
    await expect(store.load('a')).resolves.toEqual(transcript('a', 'new'));
    expect(operations).toEqual(['write:old']);
    writing.resolve();
    await invalidating;
    await Promise.resolve();
    expect(operations).toEqual(['write:old', 'remove', 'write:new']);
  });

  it('invalidates a removed agent even when eviction fails, keeping other transcripts', async () => {
    const { store, storage, install } = setup([agent(), agent('b')]);
    await store.load('a');
    await store.load('b');
    storage.removeItem.mockRejectedValueOnce(new Error('eviction failed'));
    await install([agent('b')]);
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toEqual(transcript('b'));
    expect(warning).toHaveBeenCalledWith(
      '[CONVERSATION_CACHE] Could not persist cached transcript', 'a', expect.any(Error),
    );
  });
});
