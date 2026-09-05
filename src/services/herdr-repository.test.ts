import type { BridgeEvent, HerdrRuntimeState } from '@/domain/herdr';
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
