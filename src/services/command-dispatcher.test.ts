import { agentSession } from '@/domain/agent-session';
import { ConnectionError } from '@/domain/connection-error';
import { remoteAgentSchema, type AgentConversation } from '@/domain/herdr';
import { CommandDispatcher, type CommandDispatchSource } from './command-dispatcher';
import { CommandOutbox, type PendingCommand } from './command-outbox';

jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

function agent(id = 'a', session = 'session-a') {
  return remoteAgentSchema.parse({
    id, provider: 'copilot', providerSessionId: session, paneId: `pane-${id}`,
    herdrSessionId: 'default', workspaceId: 'workspace', workspaceName: 'Workspace',
    status: 'idle', title: id, focused: true, capabilities: {},
  });
}

function conversation(id = 'a', session = 'session-a'): AgentConversation {
  return { agentId: id, provider: 'copilot', providerSessionId: session, semantic: true, items: [] };
}

function message(id = 'a', deviceId = 'device-a', session = 'session-a') {
  return {
    agentId: id, deviceId, action: 'agent.send_message' as const,
    text: 'Hello', baselineIds: [],
    payload: { agentId: id, text: 'Hello', precondition: agentSession(agent(id, session)) },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  let saved: string | null = null;
  const storage = {
    getItem: jest.fn(async () => saved),
    setItem: jest.fn(async (_key: string, value: string) => { saved = value; }),
  };
  const outbox = new CommandOutbox(storage);
  const agents = new Map([['a', agent()], ['b', agent('b')]]);
  const transcripts = new Map([['a', conversation()], ['b', conversation('b')]]);
  const devices = new Map([
    ['device-a', { connected: true, generation: 0, durable: true }],
    ['device-b', { connected: true, generation: 0, durable: true }],
  ]);
  const send = jest.fn<Promise<unknown>, [PendingCommand]>().mockResolvedValue({ accepted: true });
  const source: jest.Mocked<CommandDispatchSource> = {
    open: jest.fn((id) => {
      const device = devices.get(id);
      if (!device?.connected) return null;
      const generation = device.generation;
      return {
        isCurrent: () => device.generation === generation,
        supportsDurableCommands: () => device.durable,
        send,
      };
    }),
    isConnected: jest.fn((id) => devices.get(id)?.connected === true),
    getAgent: jest.fn((id) => agents.get(id)),
    getConversation: jest.fn((id) => transcripts.get(id) ?? null),
    readConversation: jest.fn(async (id) => transcripts.get(id) ?? conversation(id)),
    reconnect: jest.fn().mockResolvedValue(true),
    onSent: jest.fn(), onConnectionError: jest.fn(), onQueueError: jest.fn(),
  };
  const dispatcher = new CommandDispatcher(outbox, source);
  return { dispatcher, source, send, storage, outbox, agents, transcripts, devices };
}

describe('CommandDispatcher delivery ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not publish, schedule or recover an enqueue that failed durable persistence', async () => {
    const { dispatcher, storage, source } = setup();
    await dispatcher.hydrate();
    const listener = jest.fn();
    dispatcher.subscribe(listener);
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(dispatcher.enqueue(message())).rejects.toThrow('disk full');
    expect(dispatcher.getSnapshot()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(source.reconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('persists offline work and joins recovery without reporting a failed attachment', async () => {
    const { dispatcher, source, devices } = setup();
    devices.get('device-a')!.connected = false;
    source.reconnect.mockRejectedValueOnce(new Error('still offline'));
    await dispatcher.enqueue(message());
    expect(dispatcher.getSnapshot()[0]).toMatchObject({ state: 'queued', attempted: false });
    expect(source.reconnect).toHaveBeenCalledWith('device-a');
    expect(source.onConnectionError).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith('[CONNECTION] Queued message is waiting for recovery', expect.any(Error));
  });

  it('coalesces each device flush while another device remains usable', async () => {
    const { dispatcher, source, send } = setup();
    const baseline = deferred<AgentConversation>();
    source.readConversation.mockImplementation((id) =>
      id === 'a' ? baseline.promise : Promise.resolve(conversation(id)));
    await dispatcher.enqueue(message());
    await dispatcher.enqueue(message('b', 'device-b'));
    const first = dispatcher.flush('device-a');
    expect(dispatcher.flush('device-a')).toBe(first);
    await dispatcher.flush('device-b');
    expect(send.mock.calls.map(([command]) => command.agentId)).toEqual(['b']);
    baseline.resolve(conversation());
    await first;
    expect(send.mock.calls.map(([command]) => command.agentId)).toEqual(['b', 'a']);
  });

  it('recovers a failed ACK write with the same ID and only publishes sent after persistence', async () => {
    const { dispatcher, source, storage, send } = setup();
    await dispatcher.enqueue(message());
    const id = dispatcher.getSnapshot()[0].id;
    const persist = storage.setItem.getMockImplementation()!;
    const applied = new Set<string>();
    send.mockImplementationOnce(async (command) => {
      applied.add(command.id);
      storage.setItem.mockRejectedValue(new Error('storage unavailable'));
      return { accepted: true };
    }).mockImplementation(async (command) => {
      applied.add(command.id);
      return { accepted: true };
    });
    await expect(dispatcher.flush('device-a')).rejects.toThrow('storage unavailable');
    expect(dispatcher.getSnapshot()[0]).toMatchObject({ id, state: 'sending', attempted: true });
    expect(source.onSent).not.toHaveBeenCalled();
    storage.setItem.mockImplementation(persist);
    await dispatcher.flush('device-a');
    expect(send.mock.calls.map(([command]) => command.id)).toEqual([id, id]);
    expect(applied.size).toBe(1);
    expect(dispatcher.getSnapshot()[0].state).toBe('sent');
    expect(source.onSent).toHaveBeenCalledTimes(1);
  });

  it('does not replay an acknowledged command when the subsequent refresh fails', async () => {
    const { dispatcher, source, send } = setup();
    source.readConversation.mockResolvedValueOnce(conversation()).mockRejectedValueOnce(new Error('read failed'));
    await dispatcher.enqueue(message());
    await dispatcher.flush('device-a');
    await dispatcher.flush('device-a');
    expect(send).toHaveBeenCalledTimes(1);
    expect(dispatcher.getSnapshot()[0].state).toBe('sent');
    expect(source.onConnectionError).not.toHaveBeenCalled();
  });

  it('cancels scheduled work on detach and fences a pending baseline from sending', async () => {
    const { dispatcher, source, devices, send } = setup();
    const baseline = deferred<AgentConversation>();
    const began = deferred<void>();
    source.readConversation.mockImplementationOnce(() => { began.resolve(); return baseline.promise; });
    await dispatcher.enqueue(message());
    const flushing = dispatcher.flush('device-a');
    await began.promise;
    devices.get('device-a')!.connected = false;
    devices.get('device-a')!.generation++;
    await dispatcher.detach('device-a');
    baseline.resolve(conversation());
    await flushing;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0]).toMatchObject({ state: 'queued', attempted: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not report an obsolete attachment failure against its replacement', async () => {
    const { dispatcher, source, devices, send } = setup();
    const sending = deferred<unknown>();
    const began = deferred<void>();
    send.mockImplementationOnce(() => { began.resolve(); return sending.promise; });
    await dispatcher.enqueue(message());
    const flushing = dispatcher.flush('device-a');
    await began.promise;
    devices.get('device-a')!.generation++;
    sending.reject(new ConnectionError('ERR_BRIDGE_CLOSED', 'old attachment'));
    await flushing;
    expect(source.onConnectionError).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0].state).toBe('queued');
    await dispatcher.flush('device-a');
    expect(send.mock.calls[0][0].id).toBe(send.mock.calls[1][0].id);
  });

  it('invalidates first-send work when its session changes during baseline capture', async () => {
    const { dispatcher, source, agents, send } = setup();
    source.readConversation.mockImplementationOnce(async () => {
      agents.set('a', agent('a', 'replacement'));
      return conversation('a', 'replacement');
    });
    await dispatcher.enqueue(message());
    await dispatcher.flush('device-a');
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0]).toMatchObject({ state: 'failed', invalidated: true, attempted: false });
    await expect(dispatcher.retry(dispatcher.getSnapshot()[0].id)).rejects.toThrow('previous session');
  });

  it('blocks uncertain work only within the same agent session', async () => {
    const { dispatcher, send, agents, transcripts } = setup();
    send.mockRejectedValueOnce(new ConnectionError('COMMAND_UNCERTAIN', 'Delivery unknown'));
    await dispatcher.enqueue(message());
    await dispatcher.flush('device-a');
    const uncertain = dispatcher.getSnapshot()[0];
    await dispatcher.enqueue(message());
    await dispatcher.enqueue(message('b'));
    await dispatcher.flush('device-a');
    expect(send.mock.calls.map(([command]) => command.agentId)).toEqual(['a', 'b']);
    await expect(dispatcher.retry(uncertain.id)).rejects.toThrow('Delivery is uncertain');
    agents.set('a', agent('a', 'new'));
    transcripts.set('a', conversation('a', 'new'));
    await dispatcher.enqueue(message('a', 'device-a', 'new'));
    await dispatcher.flush('device-a');
    expect(send.mock.calls.at(-1)?.[0].payload.precondition).toEqual(agentSession(agent('a', 'new')));
    expect(dispatcher.getSnapshot().find((command) => command.id === uncertain.id)?.state).toBe('uncertain');
  });

  it('uses the bounded command-in-progress retry without issuing a new durable ID', async () => {
    const { dispatcher, send, source } = setup();
    send.mockRejectedValueOnce(new ConnectionError('COMMAND_IN_PROGRESS', 'Still working'));
    await dispatcher.enqueue(message());
    await dispatcher.flush('device-a');
    await jest.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].id).toBe(send.mock.calls[1][0].id);
    expect(source.onConnectionError).not.toHaveBeenCalled();
  });

  it.each([false, true])('expires attempted=%s work without delivery', async (attempted) => {
    const { dispatcher, outbox, send } = setup();
    const command = await outbox.enqueue(message());
    if (attempted) await outbox.update(command.id, { attempted: true });
    jest.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    await dispatcher.flush('device-a');
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0].state).toBe(attempted ? 'uncertain' : 'failed');
  });

  it('rejects delivery when the attachment does not support durable commands', async () => {
    const { dispatcher, devices, send } = setup();
    devices.get('device-a')!.durable = false;
    await dispatcher.enqueue(message());
    await dispatcher.flush('device-a');
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0].state).toBe('failed');
  });

  it.each([false, true])('does not replay a persisted legacy interrupt (attempted=%s)', async (attempted) => {
    const { outbox, storage, source, send } = setup();
    const command = await outbox.enqueue({ ...message(), action: 'agent.interrupt' });
    if (attempted) await outbox.update(command.id, { state: 'sending', attempted: true });
    const restarted = new CommandDispatcher(new CommandOutbox(storage), source);
    await restarted.flush('device-a');
    expect(send).not.toHaveBeenCalled();
    expect(restarted.getSnapshot()[0]).toMatchObject({
      id: command.id, invalidated: true, state: attempted ? 'uncertain' : 'failed',
    });
  });

  it('persists reconciliation and consumes each remote echo only once', async () => {
    const { dispatcher, outbox, storage } = setup();
    const first = await outbox.enqueue(message());
    const second = await outbox.enqueue(message());
    await outbox.update(first.id, { state: 'sent' });
    await outbox.update(second.id, { state: 'sent' });
    const echo: AgentConversation = {
      ...conversation(), items: [{ id: 'echo', kind: 'user_message', text: 'Hello' }],
    };
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(dispatcher.reconcile(echo)).rejects.toThrow('disk full');
    expect(dispatcher.getSnapshot()).toHaveLength(2);
    await dispatcher.reconcile(echo);
    await dispatcher.reconcile(echo);
    expect(dispatcher.getSnapshot()).toEqual([expect.objectContaining({
      id: second.id, state: 'sent', baselineIds: ['echo'],
    })]);
  });

  it('cancels pending endpoint work without replaying it or discarding receipts', async () => {
    const { dispatcher, outbox, send } = setup();
    const queued = await outbox.enqueue(message());
    const attempted = await outbox.enqueue(message());
    const sent = await outbox.enqueue(message());
    await outbox.update(attempted.id, { attempted: true });
    await outbox.update(sent.id, { state: 'sent', attempted: true });
    await dispatcher.cancelDevice('device-a');
    expect(dispatcher.getSnapshot()).toEqual([
      expect.objectContaining({ id: queued.id, state: 'failed', invalidated: true }),
      expect.objectContaining({ id: attempted.id, state: 'uncertain', invalidated: true }),
      expect.objectContaining({ id: sent.id, state: 'sent', invalidated: false }),
    ]);
    await expect(dispatcher.retry(queued.id)).rejects.toThrow('device configuration changed');
    await dispatcher.flush('device-a');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a scheduled durable-storage failure without pretending delivery succeeded', async () => {
    const { dispatcher, storage, source, send } = setup();
    await dispatcher.enqueue(message());
    storage.setItem.mockRejectedValue(new Error('disk offline'));
    await jest.advanceTimersByTimeAsync(0);
    expect(source.onQueueError).toHaveBeenCalledWith('device-a');
    expect(send).not.toHaveBeenCalled();
    expect(dispatcher.getSnapshot()[0].state).toBe('queued');
  });
});
