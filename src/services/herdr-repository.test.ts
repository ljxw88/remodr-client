import type { BridgeEvent, HerdrRuntimeState } from '@/domain/herdr';
import {
  appendOptimisticUserMessage,
  HerdrRepository,
  reduceAgentStatus,
} from '@/services/herdr-repository';
import type { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';

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
  capabilities: {},
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
    request: jest.fn(async (action: string) =>
      action === 'runtime.snapshot' ? snapshot : undefined,
    ),
    emit(event: BridgeEvent) {
      listeners.forEach((listener) => listener(event));
    },
  } as unknown as FakeTransport;
}

/** Builds a repository whose transports are chosen per device, in order. */
function repositoryWith(transports: FakeTransport[]) {
  let index = 0;
  return new HerdrRepository(() => transports[index++]);
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

  it('automatically reconnects and retries when bridge is closed on sendMessage', async () => {
    const { repository, first } = await connectTwoDevices();
    const reconnectMock = jest.fn().mockResolvedValue(true);
    repository.setReconnectHandler(reconnectMock);

    first.request.mockClear();
    // First request fails with bridge closed, retry succeeds
    first.request
      .mockRejectedValueOnce(new Error('Herdr bridge is closed'))
      .mockResolvedValueOnce({ ok: true });

    await repository.sendMessage('agent-a1', 'Hello after background');

    expect(reconnectMock).toHaveBeenCalledWith('device-1');
    expect(first.request).toHaveBeenCalledTimes(2);
  });
});

describe('optimistic conversation messages', () => {
  it('appends a user message without mutating the existing conversation', () => {
    const conversation = {
      agentId: 'agent-1',
      provider: 'copilot' as const,
      semantic: true,
      items: [{ id: 'a1', kind: 'assistant_message' as const, markdown: 'Ready.' }],
    };

    const optimistic = appendOptimisticUserMessage(conversation, 'Run the tests.');

    expect(conversation.items).toHaveLength(1);
    expect(optimistic.items).toHaveLength(2);
    expect(optimistic.items[1]).toMatchObject({
      kind: 'user_message',
      text: 'Run the tests.',
    });
  });
});
