import type { AgentConversation, AgentStatus, BridgeEvent, HerdrRuntimeState } from '@/domain/herdr';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HerdrRepository,
  reduceAgentStatus,
} from '@/services/herdr-repository';
import type { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';
import { ConnectionError } from '@/domain/connection-error';
import { CommandOutbox } from '@/services/command-outbox';

jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const runtime: HerdrRuntimeState = {
  connectionState: 'connected',
  deviceId: 'device-1',
  workspaces: [{ id: 'w1', name: 'mobile', status: 'idle' }],
  providers: [{ provider: 'copilot', available: true, aliases: [] }],
  agents: [
    {
      id: 'agent-1',
      provider: 'copilot',
      providerSessionId: 'copilot-session-1',
      herdrSessionId: 'default',
      workspaceId: 'w1',
      workspaceName: 'mobile',
      paneId: 'p1',
      status: 'idle',
      title: 'Copilot',
      focused: true,
      capabilities: {
        structuredConversation: true,
        streamingConversation: true,
        structuredQuestions: true,
        toolActivity: true,
        todos: true,
        fallback: true,
      },
    },
  ],
};

function runtimeFor(deviceId: string, agentIds: string[]): HerdrRuntimeState {
  return {
    ...runtime,
    deviceId,
    agents: agentIds.map((id) => ({ ...runtime.agents[0], id, deviceId })),
  };
}

const hello = {
  protocol: 1 as const,
  type: 'hello' as const,
  bridgeVersion: '0.1.0',
  herdrVersion: '0.8.2',
  herdrProtocol: 20,
  capabilities: { durableCommands: true },
};

type FakeTransport = HerdrBridgeTransport & {
  request: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  emit(event: BridgeEvent): void;
};

function fakeTransport(snapshot?: HerdrRuntimeState): FakeTransport {
  const listeners = new Set<(event: BridgeEvent) => void>();
  return {
    subscribe: jest.fn((listener: (event: BridgeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    start: jest.fn(async () => hello),
    stop: jest.fn(async () => undefined),
    request: jest.fn(async (action: string, payload: { agentId?: string }) =>
      action === 'runtime.snapshot' ? snapshot : action === 'agent.conversation'
        ? { agentId: payload.agentId, provider: 'copilot', semantic: true, items: [] } : undefined,
    ),
    emit(event: BridgeEvent) {
      listeners.forEach((listener) => listener(event));
    },
  } as unknown as FakeTransport;
}

/** Builds a repository whose transports are chosen per device, in order. */
function repositoryWith(transports: FakeTransport[]) {
  let index = 0;
  return new HerdrRepository(() => transports[index++], new CommandOutbox({
    getItem: async () => null,
    setItem: async () => undefined,
  }));
}

describe('Herdr runtime reducer', () => {
  it.each([
    ['working'],
    ['blocked'],
    ['done'],
    ['idle'],
  ] as const)('moves an agent to %s', (status) => {
    expect(reduceAgentStatus(runtime, 'agent-1', status).agents[0].status).toBe(status);
  });

  it('keeps the same snapshot for an unknown agent or unchanged state', () => {
    expect(reduceAgentStatus(runtime, 'missing', 'working')).toBe(runtime);
    expect(reduceAgentStatus(runtime, 'agent-1', 'idle')).toBe(runtime);
  });
});

describe('HerdrRepository completion notifications', () => {
  it('does not let an out-of-order snapshot retrigger an acknowledged finish', async () => {
    const { repository, transport } = await setup();
    transport.request.mockResolvedValueOnce({ ...completed('done', 12), runtimeRevision: 200 });
    await repository.refreshRuntime();
    await repository.loadConversation('agent-1');
    const id = repository.getCompletion('agent-1')!.id;
    await repository.markCompletionRead('agent-1', id);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      transport.request.mockResolvedValueOnce({ ...completed('done', 10), runtimeRevision: 100 });
      await repository.refreshRuntime();
      transport.request.mockResolvedValueOnce({ ...completed('done', 12), runtimeRevision: 300 });
      await repository.refreshRuntime();
      expect(repository.getCompletion('agent-1')).toMatchObject({ id, unread: false });
    } finally {
      warning.mockRestore();
    }
  });

  const runtimeKey = 'remote-workspace.herdr.runtimes.v2';
  let disk: Map<string, string>;

  function completed(status: AgentStatus = 'done', revision = 10): HerdrRuntimeState {
    return {
      ...runtime,
      agents: [{ ...runtime.agents[0], status, statusRevision: revision }],
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    disk = new Map();
    jest.mocked(AsyncStorage.getItem).mockReset().mockImplementation(async (key) => disk.get(key) ?? null);
    jest.mocked(AsyncStorage.setItem).mockReset().mockImplementation(async (key, value) => { disk.set(key, value); });
    jest.mocked(AsyncStorage.removeItem).mockReset().mockImplementation(async (key) => { disk.delete(key); });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined);
    jest.mocked(AsyncStorage.removeItem).mockReset().mockResolvedValue(undefined);
  });

  async function setup() {
    const transport = fakeTransport(completed());
    const repository = repositoryWith([transport]);
    repository.selectDevice('device-1');
    await repository.connect('ssh-1', 'device-1');
    return { repository, transport };
  }

  it('does not acknowledge by selecting a device or by a background conversation refresh', async () => {
    const { repository } = await setup();
    const receipt = repository.getCompletion('agent-1')!;
    repository.selectDevice('other-device');
    repository.selectDevice('device-1');
    await repository.markCompletionRead('agent-1', receipt.id);
    expect(repository.getCompletion('agent-1')?.unread).toBe(true);
    await repository.loadConversation('agent-1');
    expect(repository.getCompletion('agent-1')?.unread).toBe(true);
    await repository.markCompletionRead('agent-1', receipt.id);
    expect(repository.getCompletion('agent-1')?.unread).toBe(false);
  });

  it('does not persist activity-only runtime refreshes', async () => {
    const { repository, transport } = await setup();
    jest.mocked(AsyncStorage.setItem).mockClear();
    transport.request.mockResolvedValueOnce({
      ...completed(),
      runtimeRevision: 11,
      agents: [{ ...completed().agents[0], lastOutputAt: 123 }],
    });

    await repository.refreshRuntime(undefined, true);

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('persists acknowledgement across duplicate snapshots, reconnects and application restart', async () => {
    const { repository } = await setup();
    const id = repository.getCompletion('agent-1')!.id;
    await repository.loadConversation('agent-1');
    await repository.markCompletionRead('agent-1', id);
    await repository.refreshRuntime();
    await repository.releaseDevice('device-1');
    await repository.connect('ssh-2', 'device-1');
    expect(repository.getCompletion('agent-1')).toMatchObject({ id, unread: false });
    const restored = repositoryWith([fakeTransport(completed())]);
    await restored.hydrate();
    await restored.connect('ssh-3', 'device-1');
    expect(restored.getCompletion('agent-1')).toMatchObject({ id, unread: false });
  });

  it('leaves a newer completion unread when an earlier read finishes late', async () => {
    const { repository, transport } = await setup();
    const old = repository.getCompletion('agent-1')!.id;
    await repository.loadConversation('agent-1');
    transport.request.mockResolvedValueOnce(completed('done', 12));
    await repository.refreshRuntime();
    const current = repository.getCompletion('agent-1')!.id;
    expect(current).not.toBe(old);
    await repository.markCompletionRead('agent-1', old);
    expect(repository.getCompletion('agent-1')).toMatchObject({ id: current, unread: true });
  });

  it('does not manufacture a completion when send acknowledgement optimistically marks working', async () => {
    const { repository } = await setup();
    const id = repository.getCompletion('agent-1')!.id;
    await repository.loadConversation('agent-1');
    await repository.markCompletionRead('agent-1', id);
    await repository.sendMessage('agent-1', 'Next task');
    await repository.flushCommands('device-1');
    expect(repository.getSnapshot().runtime.agents[0].status).toBe('working');
    await repository.refreshRuntime();
    expect(repository.getCompletion('agent-1')).toMatchObject({ id, unread: false });
  });

  it('restores unread state on storage failure and allows a later successful acknowledgement', async () => {
    const { repository } = await setup();
    const id = repository.getCompletion('agent-1')!.id;
    await repository.loadConversation('agent-1');
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(repository.markCompletionRead('agent-1', id)).rejects.toThrow('storage unavailable');
    expect(repository.getCompletion('agent-1')?.unread).toBe(true);
    await repository.markCompletionRead('agent-1', id);
    expect(repository.getCompletion('agent-1')?.unread).toBe(false);
  });

  it('does not roll back a newer completion when saving an older acknowledgement fails', async () => {
    const { repository, transport } = await setup();
    const old = repository.getCompletion('agent-1')!.id;
    await repository.loadConversation('agent-1');
    let reject!: (reason: Error) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(() => {
      started();
      return new Promise<void>((_resolve, fail) => { reject = fail; });
    });
    const saving = repository.markCompletionRead('agent-1', old);
    const failure = expect(saving).rejects.toThrow('storage unavailable');
    await began;
    transport.emit({ protocol: 1, type: 'event', event: 'runtime.snapshot', data: completed('done', 12) });
    const newer = repository.getCompletion('agent-1')!.id;
    reject(new Error('storage unavailable'));
    await failure;
    await repository.refreshRuntime();
    expect(repository.getCompletion('agent-1')).toMatchObject({ id: newer, unread: true });
    expect(JSON.parse(disk.get(runtimeKey)!)['device-1'].agents[0].completion.unread).toBe(true);
  });
});

describe('HerdrRepository device-scoped requests', () => {
  it('installs the refreshed runtime returned by the bridge', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue({
      paneId: 'p2',
      agentId: 'agent-2',
      name: 'codex',
      runtime: {
        ...runtime,
        providers: [
          ...runtime.providers,
          { provider: 'codex' as const, available: true, aliases: [] },
        ],
      },
    });
    const repository = repositoryWith([transport]);
    repository.selectDevice('device-1');

    const result = await repository.createAgent({
      provider: 'codex',
      workspaceId: 'w1',
      bypassPermissions: true,
    });

    expect(transport.request).toHaveBeenCalledWith('agent.create', {
      provider: 'codex',
      workspaceId: 'w1',
      bypassPermissions: true,
    });
    expect(result.agentId).toBe('agent-2');
    expect(repository.getSnapshot().runtime.providers).toHaveLength(2);
    expect(repository.getSnapshot().agentCountsByDevice).toEqual({ 'device-1': 1 });
  });

  it('installs a newly created space from the bridge result', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue({
      workspaceId: 'w2',
      runtime: {
        ...runtime,
        workspaces: [
          ...runtime.workspaces,
          { id: 'w2', name: 'project', status: 'idle' as const },
        ],
      },
    });
    const repository = repositoryWith([transport]);
    repository.selectDevice('device-1');

    const result = await repository.createSpace({ cwd: '~/project', label: 'Project' });

    expect(transport.request).toHaveBeenCalledWith('workspace.create', {
      cwd: '~/project',
      label: 'Project',
    });
    expect(result.workspaceId).toBe('w2');
    expect(repository.getSnapshot().runtime.workspaces).toHaveLength(2);
  });

  it('installs a closed-space runtime and forwards group confirmation', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue({
      workspaceId: 'w1',
      runtime: { ...runtime, workspaces: [], agents: [] },
    });
    const repository = repositoryWith([transport]);
    repository.selectDevice('device-1');

    await repository.closeSpace('w1', true);

    expect(transport.request).toHaveBeenCalledWith('workspace.close', {
      workspaceId: 'w1',
      closeGroup: true,
    });
    expect(repository.getSnapshot().runtime.workspaces).toEqual([]);
  });

  it('refuses device-scoped work when no device is selected', async () => {
    const repository = repositoryWith([fakeTransport()]);

    await expect(repository.refreshRuntime()).rejects.toThrow('No device is selected');
  });
});

describe('HerdrRepository multi-device runtime', () => {
  it('gives Codex setup guidance without sending to an unidentified thread', async () => {
    const snapshot: HerdrRuntimeState = {
      ...runtime,
      agents: [{ ...runtime.agents[0], provider: 'codex', providerSessionId: null }],
    };
    const transport = fakeTransport(snapshot);
    const repository = repositoryWith([transport]);
    await repository.connect('ssh-1', 'device-1');
    await expect(repository.sendMessage('agent-1', 'hello')).rejects.toThrow('Thread ID in Codex /statusline');
    expect(transport.request.mock.calls.some(([action]) => action === 'agent.send_message')).toBe(false);
  });

  it('connects to an older bridge that still advertises OpenCode', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue({
      ...runtime,
      providers: [
        { provider: 'copilot', available: true },
        { provider: 'claude', available: true },
        { provider: 'codex', available: true },
        { provider: 'opencode', available: true },
      ],
      agents: [
        ...runtime.agents,
        { ...runtime.agents[0], id: 'legacy-agent', paneId: 'p2', provider: 'opencode' },
      ],
    });
    const repository = repositoryWith([transport]);
    await repository.connect('ssh-1', 'device-1');
    const device = repository.getSnapshot().devices['device-1'];
    expect(device.connection).toBe('connected');
    expect(device.lastError).toBeNull();
    expect(device.runtime.providers[3]).toMatchObject({ provider: 'unknown', available: false });
    expect(device.runtime.agents.map((agent) => agent.provider)).toEqual(['copilot', 'unknown']);
  });

    describe('HerdrRepository provider session rotation', () => {
      it('requests output activity for the explicit owning device', async () => {
        const { repository, transport } = await setup();
        transport.request.mockClear();
        await repository.refreshRuntime(deviceId, true);
        expect(transport.request).toHaveBeenCalledWith('runtime.snapshot', { includeActivity: true });
      });

      it('does not persist activity polling snapshots', async () => {
        const { repository } = await setup();
        jest.mocked(AsyncStorage.setItem).mockClear();
        await repository.refreshRuntime(deviceId, true);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      });

      it('retains observed output recency across same-session snapshots but not session replacement', async () => {
        const { repository, transport, rotate } = await setup();
        const current = sessionRuntime('old-session');
        transport.request.mockResolvedValueOnce({
          ...current, agents: current.agents.map((agent) => ({ ...agent, lastOutputAt: 200 })),
        });
        await repository.refreshRuntime();
        await repository.refreshRuntime();
        expect(repository.getSnapshot().runtime.agents[0].lastOutputAt).toBe(200);
        transport.request.mockResolvedValueOnce({
          ...current, agents: current.agents.map((agent) => ({ ...agent, lastOutputAt: 100 })),
        });
        await repository.refreshRuntime();
        expect(repository.getSnapshot().runtime.agents[0].lastOutputAt).toBe(200);
        rotate('new-session');
        await repository.refreshRuntime();
        expect(repository.getSnapshot().runtime.agents[0].lastOutputAt).toBeUndefined();
      });

      it.each(['wrong-agent', 'malformed-json', 'invalid-schema'])('recovers from %s cached data by loading the authoritative transcript', async (kind) => {
        const { repository, transport } = await setup();
        const bad = kind === 'malformed-json' ? '{broken'
          : kind === 'invalid-schema' ? JSON.stringify({ agentId })
            : JSON.stringify({ ...transcript('old-session'), agentId: 'another-agent' });
        jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(bad);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await expect(repository.loadConversation(agentId)).resolves.toMatchObject({
            agentId, providerSessionId: 'old-session',
          });
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(cacheKey);
          expect(transport.request).toHaveBeenCalledWith('agent.conversation', { agentId });
          expect(warning).toHaveBeenCalled();
          expect(repository.getConversation('another-agent')).toBeNull();
        } finally {
          warning.mockRestore();
        }
      });

      it('surfaces cache-removal failures and recovers when storage works again', async () => {
        const { repository, transport } = await setup();
        const bad = JSON.stringify({ ...transcript('old-session'), agentId: 'another-agent' });
        jest.mocked(AsyncStorage.getItem).mockResolvedValue(bad);
        jest.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('storage unavailable'));
        transport.request.mockClear();
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await expect(repository.loadConversation(agentId)).rejects.toThrow('storage unavailable');
          expect(transport.request).not.toHaveBeenCalled();
          await expect(repository.loadConversation(agentId)).resolves.toMatchObject({ agentId });
        } finally {
          warning.mockRestore();
        }
      });

      it('does not treat a storage read failure as a corrupt cache', async () => {
        const { repository, transport } = await setup();
        jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage read failed'));
        transport.request.mockClear();
        await expect(repository.loadConversation(agentId)).rejects.toThrow('storage read failed');
        expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
        expect(transport.request).not.toHaveBeenCalled();
      });

      const agentId = 'agent-1';
      const deviceId = 'device-1';
      const cacheKey = `remote-workspace.herdr.conversation.${agentId}`;

      function sessionRuntime(session: string): HerdrRuntimeState {
        return { ...runtime, agents: [{ ...runtime.agents[0], providerSessionId: session }] };
      }

      function transcript(session: string, text = session): AgentConversation {
        return {
          agentId, provider: 'copilot', providerSessionId: session, semantic: true,
          items: text ? [{ id: 'reply', kind: 'assistant_message', markdown: text }] : [],
          activeHumanRequest: null,
        };
      }

      async function setup() {
        let session = 'old-session';
        const transport = fakeTransport();
        transport.request.mockImplementation(async (action: string) => {
          if (action === 'runtime.snapshot') return sessionRuntime(session);
          if (action === 'agent.conversation') return transcript(session);
          return { accepted: true };
        });
        const repository = repositoryWith([transport]);
        repository.selectDevice(deviceId);
        await repository.connect('ssh-1', deviceId);
        return { repository, transport, rotate: (next: string) => { session = next; } };
      }

      function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((done) => { resolve = done; });
        return { promise, resolve };
      }

      beforeEach(() => {
        jest.useFakeTimers();
        jest.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null);
        jest.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined);
        jest.mocked(AsyncStorage.removeItem).mockReset().mockResolvedValue(undefined);
      });

      afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
      });

      it('clears the previous transcript and question immediately when the session rotates', async () => {
        const { repository, transport, rotate } = await setup();
        transport.request.mockResolvedValueOnce({
          ...transcript('old-session'),
          activeHumanRequest: { id: 'old-question', kind: 'text', question: 'Old?', options: [], allowCustomAnswer: true, multiSelect: false },
        });
        await repository.loadConversation(agentId);
        expect(repository.getConversation(agentId)?.activeHumanRequest?.id).toBe('old-question');
        rotate('new-session');
        await repository.refreshRuntime();
        expect(repository.getConversation(agentId)).toBeNull();
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith(cacheKey);
        transport.request.mockResolvedValueOnce(transcript('new-session', ''));
        await repository.loadConversation(agentId);
        expect(repository.getConversation(agentId)).toMatchObject({ providerSessionId: 'new-session', items: [], activeHumanRequest: null });
        await repository.loadConversation(agentId);
        expect(repository.getConversation(agentId)?.items[0]).toMatchObject({ markdown: 'new-session' });
      });

      it.each([false, true])('discards an old in-flight response, even if malformed (%s), and follows the new session', async (malformed) => {
        const { repository, transport, rotate } = await setup();
        const began = deferred<void>();
        const old = deferred<unknown>();
        transport.request.mockImplementationOnce(() => { began.resolve(); return old.promise; });
        const loading = repository.loadConversation(agentId);
        await began.promise;
        rotate('new-session');
        await repository.refreshRuntime();
        old.resolve(malformed ? { invalid: true } : transcript('old-session'));
        await expect(loading).resolves.toMatchObject({ providerSessionId: 'new-session' });
        expect(repository.getConversation(agentId)?.items[0]).toMatchObject({ markdown: 'new-session' });
        expect(jest.mocked(AsyncStorage.setItem).mock.calls.filter(([key]) => key === cacheKey)
          .map(([, value]) => JSON.parse(value).providerSessionId)).toEqual(['new-session']);
      });

      it('recovers an explicit new-session response even if the runtime event was missed', async () => {
        const { repository, rotate } = await setup();
        rotate('new-session');
        await expect(repository.loadConversation(agentId)).resolves.toMatchObject({ providerSessionId: 'new-session' });
        expect(repository.getSnapshot().runtime.agents[0].providerSessionId).toBe('new-session');
      });

      it('handles rotation announced by the conversation request itself', async () => {
        const { repository, transport, rotate } = await setup();
        transport.request.mockImplementationOnce(async () => {
          rotate('new-session');
          transport.emit({ protocol: 1, type: 'event', event: 'runtime.snapshot', data: sessionRuntime('new-session') });
          return transcript('new-session');
        });
        await expect(repository.loadConversation(agentId)).resolves.toMatchObject({ providerSessionId: 'new-session' });
      });

      it('does not let an asynchronous disk restore resurrect the old transcript', async () => {
        const { repository, rotate } = await setup();
        const oldCache = deferred<string>();
        jest.mocked(AsyncStorage.getItem).mockReturnValueOnce(oldCache.promise);
        const restoring = repository.restoreConversation(agentId);
        rotate('new-session');
        await repository.refreshRuntime();
        oldCache.resolve(JSON.stringify(transcript('old-session')));
        await restoring;
        expect(repository.getConversation(agentId)).toBeNull();
        await repository.loadConversation(agentId);
        expect(repository.getConversation(agentId)?.providerSessionId).toBe('new-session');
      });

      it('serializes cache removal after a previously started write, before the replacement write', async () => {
        const { repository, rotate } = await setup();
        const writing = deferred<void>();
        const began = deferred<void>();
        const operations: string[] = [];
        jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
          if (key !== cacheKey) return;
          const session = JSON.parse(value).providerSessionId;
          operations.push(`write:${session}`);
          if (session === 'old-session') { began.resolve(); await writing.promise; }
        });
        jest.mocked(AsyncStorage.removeItem).mockImplementation(async (key) => {
          if (key === cacheKey) operations.push('remove');
        });
        const loading = repository.loadConversation(agentId);
        await began.promise;
        rotate('new-session');
        const refreshing = repository.refreshRuntime();
        await Promise.resolve();
        writing.resolve();
        await Promise.all([loading, refreshing]);
        expect(operations).toEqual(['write:old-session', 'remove', 'write:new-session']);
        expect(repository.getConversation(agentId)?.providerSessionId).toBe('new-session');
      });

      it('rejects a different agent response and never caches it', async () => {
        const { repository, transport } = await setup();
        transport.request.mockResolvedValueOnce({ ...transcript('old-session'), agentId: 'another-agent' });
        await expect(repository.loadConversation(agentId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(repository.getConversation(agentId)).toBeNull();
        expect(jest.mocked(AsyncStorage.setItem).mock.calls.some(([key]) => key === cacheKey)).toBe(false);
      });

      it('binds legacy bridge responses to the unchanged request session but rejects legacy persisted data', async () => {
        const { repository, transport } = await setup();
        const { providerSessionId: _session, ...legacy } = transcript('old-session');
        jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify(legacy));
        await repository.restoreConversation(agentId);
        expect(repository.getConversation(agentId)).toBeNull();
        transport.request.mockResolvedValueOnce(legacy);
        await repository.loadConversation(agentId);
        expect(repository.getConversation(agentId)?.providerSessionId).toBe('old-session');
      });

      it('fails unsent old-session work without rebinding it to the replacement session', async () => {
        const { repository, transport, rotate } = await setup();
        await repository.sendMessage(agentId, 'For the old session');
        const original = repository.getPendingCommands()[0];
        rotate('new-session');
        await repository.refreshRuntime();
        await repository.flushCommands(deviceId);
        expect(repository.getPendingCommands()[0]).toMatchObject({
          id: original.id, payload: original.payload, state: 'failed', invalidated: true, attempted: false,
        });
        expect(transport.request.mock.calls.some(([action]) => action === 'agent.send_message')).toBe(false);
        expect(repository.getConversation(agentId)?.items.at(-1)).toMatchObject({
          deliveryError: expect.stringContaining('Previous session'),
        });
        await expect(repository.retryCommand(original.id)).rejects.toThrow('previous session');
      });

      it('does not reconcile an old acknowledged send against matching text in a new session', async () => {
        const { repository, transport, rotate } = await setup();
        await repository.sendMessage(agentId, 'Same text');
        await repository.flushCommands(deviceId);
        const original = repository.getPendingCommands()[0];
        rotate('new-session');
        await repository.refreshRuntime();
        transport.request.mockResolvedValueOnce({
          ...transcript('new-session'), items: [{ id: 'new-user-message', kind: 'user_message', text: 'Same text' }],
        });
        await repository.loadConversation(agentId);
        expect(repository.getPendingCommands()).toEqual([expect.objectContaining({ id: original.id, state: 'sent' })]);
        expect(repository.getConversation(agentId)?.items.at(-1)).toMatchObject({ previousSession: true, delivery: 'sent' });
        await repository.discardCommand(original.id);
        expect(repository.getPendingCommands()).toHaveLength(0);
      });

      it('does not let uncertain work from an old session block sending in the new one', async () => {
        const { repository, transport, rotate } = await setup();
        await repository.sendMessage(agentId, 'Old message');
        transport.request
          .mockResolvedValueOnce(transcript('old-session'))
          .mockRejectedValueOnce(new ConnectionError('COMMAND_UNCERTAIN', 'Delivery unknown'));
        await repository.flushCommands(deviceId);
        expect(repository.getPendingCommands()[0].state).toBe('uncertain');
        rotate('new-session');
        await repository.refreshRuntime();
        await repository.sendMessage(agentId, 'New message');
        await repository.flushCommands(deviceId);
        const sends = transport.request.mock.calls.filter(([action]) => action === 'agent.send_message');
        expect(sends).toHaveLength(2);
        expect(sends[1][1].precondition.providerSessionId).toBe('new-session');
        expect(repository.getPendingCommands()[0].state).toBe('uncertain');
      });
    });

  async function connectTwoDevices() {
    const first = fakeTransport(runtimeFor('device-1', ['agent-a1']));
    const second = fakeTransport(runtimeFor('device-2', ['agent-b1', 'agent-b2']));
    const repository = repositoryWith([first, second]);
    await repository.connect('ssh-1', 'device-1');
    await repository.connect('ssh-2', 'device-2');
    return { repository, first, second };
  }

  it('keeps a live runtime for every connected device', async () => {
    const { repository } = await connectTwoDevices();
    const state = repository.getSnapshot();

    expect(Object.keys(state.devices)).toEqual(['device-1', 'device-2']);
    expect(state.devices['device-1'].connection).toBe('connected');
    expect(state.devices['device-2'].connection).toBe('connected');
  });

  it('switches devices without any transport work', async () => {
    const { repository, first, second } = await connectTwoDevices();
    first.request.mockClear();
    second.request.mockClear();
    first.start.mockClear();
    second.start.mockClear();

    repository.selectDevice('device-1');
    repository.selectDevice('device-2');
    repository.selectDevice('device-1');

    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    expect(first.request).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();
  });

  it('keeps creation bound to the form device rather than the current selection', async () => {
    const { repository, first, second } = await connectTwoDevices();
    repository.selectDevice('device-2');
    first.request.mockClear();
    second.request.mockClear();
    first.request
      .mockResolvedValueOnce({ paneId: 'p2', agentId: 'new-agent', name: 'New agent', runtime: runtimeFor('device-1', ['agent-a1', 'new-agent']) })
      .mockResolvedValueOnce({ workspaceId: 'new-space', runtime: runtimeFor('device-1', ['agent-a1', 'new-agent']) });
    await repository.createAgent({ provider: 'copilot', workspaceId: 'w1' }, 'device-1');
    await repository.createSpace({ cwd: '~/Projects' }, 'device-1');
    expect(first.request.mock.calls.map((call) => call[0])).toEqual(['agent.create', 'workspace.create']);
    expect(second.request).not.toHaveBeenCalled();
    expect(repository.getSnapshot().selectedDeviceId).toBe('device-2');
  });

  it('exposes the selected device runtime while retaining the others', async () => {
    const { repository } = await connectTwoDevices();

    repository.selectDevice('device-2');
    expect(repository.getSnapshot().runtime.agents.map((agent) => agent.id)).toEqual([
      'agent-b1',
      'agent-b2',
    ]);

    repository.selectDevice('device-1');
    expect(repository.getSnapshot().runtime.agents.map((agent) => agent.id)).toEqual([
      'agent-a1',
    ]);
  });

  it('counts agents across every device, not just the selected one', async () => {
    const { repository } = await connectTwoDevices();

    expect(repository.getSnapshot().agentCountsByDevice).toEqual({
      'device-1': 1,
      'device-2': 2,
    });
  });

  it('routes an agent request to the device that owns the agent', async () => {
    const { repository, first, second } = await connectTwoDevices();
    repository.selectDevice('device-1');
    second.request.mockResolvedValue({
      agentId: 'agent-b1',
      provider: 'copilot',
      semantic: true,
      items: [],
    });

    await repository.loadConversation('agent-b1');

    expect(second.request).toHaveBeenCalledWith('agent.conversation', {
      agentId: 'agent-b1',
    });
    expect(first.request).not.toHaveBeenCalledWith(
      'agent.conversation',
      expect.anything(),
    );
  });

  it('rejects an agent that belongs to no connected device', async () => {
    const { repository } = await connectTwoDevices();

    await expect(repository.loadConversation('agent-missing')).rejects.toThrow(
      'not available on a connected device',
    );
  });

  it('keeps a healthy device usable when another device fails', async () => {
    const healthy = fakeTransport(runtimeFor('device-1', ['agent-a1']));
    const broken = fakeTransport();
    broken.start.mockRejectedValue(new Error('Bridge did not start.'));
    const repository = repositoryWith([healthy, broken]);

    await repository.connect('ssh-1', 'device-1');
    await expect(repository.connect('ssh-2', 'device-2')).rejects.toThrow(
      'Bridge did not start.',
    );

    const state = repository.getSnapshot();
    expect(state.devices['device-1'].connection).toBe('connected');
    expect(state.devices['device-2'].connection).toBe('error');

    repository.selectDevice('device-1');
    expect(repository.getSnapshot().connection).toBe('connected');
  });

  it('applies a snapshot event to the device that produced it', async () => {
    const { repository, second } = await connectTwoDevices();
    repository.selectDevice('device-1');

    second.emit({
      protocol: 1,
      type: 'event',
      event: 'runtime.snapshot',
      data: runtimeFor('device-2', ['agent-b1']),
    });
    await Promise.resolve();

    const state = repository.getSnapshot();
    expect(state.devices['device-2'].runtime.agents).toHaveLength(1);
    expect(state.runtime.agents.map((agent) => agent.id)).toEqual(['agent-a1']);
  });

  it('reports connection state for the selected device only', async () => {
    const { repository, second } = await connectTwoDevices();
    second.emit({
      protocol: 1,
      type: 'event',
      event: 'connection.warning',
      data: { message: 'Connection interrupted.' },
    });
    await Promise.resolve();

    repository.selectDevice('device-1');
    expect(repository.getSnapshot().connection).toBe('connected');

    repository.selectDevice('device-2');
    expect(repository.getSnapshot().connection).toBe('reconnecting');
  });

  it('reuses an existing bridge when reconnecting the same session', async () => {
    const { repository, first } = await connectTwoDevices();
    first.start.mockClear();

    await repository.connect('ssh-1', 'device-1');

    expect(first.start).not.toHaveBeenCalled();
  });

  it('keeps the queued message after a dropped send and reuses its command ID', async () => {
    const { repository, first } = await connectTwoDevices();
    const onFailure = jest.fn();
    repository.setConnectionObserver(onFailure);

    first.request.mockClear();
    first.request
      .mockResolvedValueOnce({ agentId: 'agent-a1', provider: 'copilot', semantic: true, items: [] })
      .mockRejectedValueOnce(new ConnectionError('ERR_BRIDGE_CLOSED', 'Closed'));

    await repository.sendMessage('agent-a1', 'Hello after background');
    await repository.flushCommands('device-1');
    const pending = repository.getPendingCommands()[0];
    expect(pending.state).toBe('queued');
    expect(repository.getConversation('agent-a1')?.items[0]).toMatchObject({
      text: 'Hello after background', delivery: 'queued',
    });
    expect(onFailure).toHaveBeenCalledWith('device-1', expect.objectContaining({ code: 'ERR_BRIDGE_CLOSED' }));

    await repository.flushCommands('device-1');
    const sends = first.request.mock.calls.filter((call) => call[0] === 'agent.send_message');
    expect(sends).toHaveLength(2);
    expect(sends.map((call) => call[2])).toEqual([pending.id, pending.id]);
    expect(repository.getPendingCommands()[0].state).toBe('sent');
  });

  it('does not automatically retry a command with ambiguous delivery', async () => {
    const { repository, first } = await connectTwoDevices();
    first.request
      .mockResolvedValueOnce({ agentId: 'agent-a1', provider: 'copilot', semantic: true, items: [] })
      .mockRejectedValueOnce(new ConnectionError('COMMAND_UNCERTAIN', 'Review this message'));
    await repository.sendMessage('agent-a1', 'Hello');
    await repository.flushCommands('device-1');
    expect(repository.getPendingCommands()[0].state).toBe('uncertain');
    const count = first.request.mock.calls.length;
    await repository.flushCommands('device-1');
    expect(first.request.mock.calls).toHaveLength(count);
  });

  it('refreshing a remote snapshot does not erase a queued message', async () => {
    const { repository } = await connectTwoDevices();
    await repository.loadConversation('agent-a1');
    await repository.sendMessage('agent-a1', 'Saved offline');
    await repository.releaseDevice('device-1');
    expect(repository.getConversation('agent-a1')?.items).toEqual([
      expect.objectContaining({ kind: 'user_message', text: 'Saved offline', delivery: 'queued' }),
    ]);
  });

  it('coalesces simultaneous conversation refreshes', async () => {
    const { repository, first } = await connectTwoDevices();
    first.request.mockClear();
    await Promise.all([repository.loadConversation('agent-a1'), repository.loadConversation('agent-a1')]);
    expect(first.request).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite or republish an unchanged polled transcript', async () => {
    const { repository } = await connectTwoDevices();
    await repository.loadConversation('agent-a1');
    const previous = repository.getConversation('agent-a1');
    const listener = jest.fn();
    const unsubscribe = repository.subscribeConversations(listener);
    jest.mocked(AsyncStorage.setItem).mockClear();
    await repository.loadConversation('agent-a1');
    expect(repository.getConversation('agent-a1')).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('retries an unchanged response after a cache write failure', async () => {
    const { repository, first } = await connectTwoDevices();
    await repository.loadConversation('agent-a1');
    first.request.mockResolvedValue({
      agentId: 'agent-a1', provider: 'copilot', semantic: true,
      items: [{ kind: 'assistant_message', id: 'reply', markdown: 'Latest output' }],
    });
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(repository.loadConversation('agent-a1')).rejects.toThrow('storage unavailable');
    await repository.loadConversation('agent-a1');
    expect(repository.getConversation('agent-a1')?.items[0]).toMatchObject({ markdown: 'Latest output' });
  });

  it('does not consume an earlier identical user message as a new send', async () => {
    const { repository, first } = await connectTwoDevices();
    first.request.mockImplementation(async (action: string) => action === 'agent.conversation' ? {
      agentId: 'agent-a1', provider: 'copilot', semantic: true,
      items: [{ kind: 'user_message', id: 'old', text: 'Again' }],
    } : { accepted: true });
    await repository.sendMessage('agent-a1', 'Again');
    await repository.flushCommands('device-1');
    await repository.loadConversation('agent-a1');
    expect(repository.getPendingCommands()).toEqual([
      expect.objectContaining({ state: 'sent', text: 'Again', baselineIds: ['old'] }),
    ]);
    first.request.mockResolvedValue({
      agentId: 'agent-a1', provider: 'copilot', semantic: true,
      items: [{ kind: 'user_message', id: 'old', text: 'Again' },
        { kind: 'user_message', id: 'new', text: 'Again' }],
    });
    await repository.loadConversation('agent-a1');
    expect(repository.getPendingCommands()).toHaveLength(0);
  });

  it('does not send queued work to a changed host endpoint', async () => {
    const { repository, first } = await connectTwoDevices();
    await repository.sendMessage('agent-a1', 'For this server only');
    await repository.cancelDeviceCommands('device-1');
    first.request.mockClear();
    await repository.flushCommands('device-1');
    expect(first.request).not.toHaveBeenCalled();
    const command = repository.getPendingCommands()[0];
    expect(command.invalidated).toBe(true);
    await expect(repository.retryCommand(command.id)).rejects.toThrow('device configuration changed');
  });

  it('rejects a conversation response from a previous attachment', async () => {
    const { repository, first } = await connectTwoDevices();
    let resolve!: (value: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>((done) => { began = done; });
    first.request.mockImplementation(() => {
      began();
      return new Promise((done) => { resolve = done; });
    });
    const request = repository.loadConversation('agent-a1');
    await started;
    await repository.releaseDevice('device-1');
    resolve({ agentId: 'agent-a1', provider: 'copilot', semantic: true, items: [] });
    await expect(request).rejects.toMatchObject({ code: 'ERR_BRIDGE_CLOSED' });
  });

  it('restores a cached conversation without requiring any live connection', async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify({
      agentId: 'offline-agent', provider: 'copilot', semantic: true,
      items: [{ kind: 'assistant_message', id: 'remote-1', markdown: 'Previously received' }],
    }));
    const transport = fakeTransport();
    const repository = repositoryWith([transport]);
    await repository.restoreConversation('offline-agent');
    expect(repository.getConversation('offline-agent')?.items[0]).toMatchObject({ markdown: 'Previously received' });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('does not dispatch a message discarded while its baseline is loading', async () => {
    const { repository, first } = await connectTwoDevices();
    let complete!: (value: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    first.request.mockImplementation((action: string) => {
      if (action !== 'agent.conversation') return Promise.resolve({});
      began();
      return new Promise((resolve) => { complete = resolve; });
    });
    await repository.sendMessage('agent-a1', 'Cancel this');
    const flushing = repository.flushCommands('device-1');
    await started;
    await repository.discardCommand(repository.getPendingCommands()[0].id);
    complete({ agentId: 'agent-a1', provider: 'copilot', semantic: true, items: [] });
    await flushing;
    expect(repository.getPendingCommands()).toHaveLength(0);
    expect(first.request.mock.calls.filter((call) => call[0] === 'agent.send_message')).toHaveLength(0);
  });

  it('does not queue or replay a live interrupt', async () => {
    const { repository, first } = await connectTwoDevices();
    await repository.interrupt('agent-a1');
    await repository.releaseDevice('device-1');
    await repository.connect('ssh-new', 'device-1');
    await repository.flushCommands('device-1');
    expect(first.request.mock.calls.filter((call) => call[0] === 'agent.interrupt')).toEqual([
      ['agent.interrupt', { agentId: 'agent-a1' }],
    ]);
    expect(repository.getPendingCommands()).toHaveLength(0);
  });
});
