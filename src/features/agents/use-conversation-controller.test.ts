import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { ConnectionError } from '@/domain/connection-error';
import { remoteAgentSchema, type AgentConversation } from '@/domain/herdr';
import { useConversationController, type ConversationReader } from './use-conversation-controller';

type Options = Parameters<typeof useConversationController>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function agent() {
  return remoteAgentSchema.parse({
    id: 'a', provider: 'copilot', providerSessionId: 'session-a', paneId: 'pane-a',
    herdrSessionId: 'default', workspaceId: 'workspace', workspaceName: 'Workspace',
    status: 'idle', title: 'Agent', focused: true, capabilities: { streamingConversation: true },
  });
}

const conversation: AgentConversation = {
  agentId: 'a', provider: 'copilot', providerSessionId: 'session-a',
  semantic: true, items: [], activeHumanRequest: null,
};

describe('conversation lifecycle controller', () => {
  let reader: jest.Mocked<ConversationReader>;
  let options: Options;
  let controller: ReturnType<typeof useConversationController>;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let warning: jest.SpyInstance;

  function Harness(props: Options) {
    controller = useConversationController(props);
    return null;
  }

  async function mount(patch: Partial<Options> = {}) {
    options = { ...options, ...patch };
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(Harness, options)); });
  }

  async function update(patch: Partial<Options>) {
    options = { ...options, ...patch };
    await TestRenderer.act(async () => { renderer!.update(createElement(Harness, options)); });
  }

  async function advance(ms: number) {
    await TestRenderer.act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    reader = {
      hydrate: jest.fn().mockResolvedValue(undefined),
      restoreConversation: jest.fn().mockResolvedValue(undefined),
      loadConversation: jest.fn().mockResolvedValue(conversation),
      getCompletion: jest.fn(),
      markCompletionRead: jest.fn().mockResolvedValue(undefined),
    };
    options = {
      conversationId: 'a', agent: agent(), hasOpenRequest: false,
      connected: true, focused: true, foreground: true, repository: reader,
    };
  });

  afterEach(async () => {
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    warning.mockRestore();
  });

  it.each([
    { connected: false }, { focused: false }, { foreground: false }, { agent: undefined },
  ])('restores offline history but does not poll when inactive: %j', async (patch) => {
    await mount(patch);
    expect(reader.restoreConversation).toHaveBeenCalledWith('a');
    await advance(10_000);
    expect(reader.loadConversation).not.toHaveBeenCalled();
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
  });

  it('starts reading on owner reconnect without requiring an agent status change', async () => {
    await mount({ connected: false });
    await update({ connected: true });
    expect(reader.loadConversation).toHaveBeenCalledWith('a');
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
  });

  it('reports restoration immediately, completes offline, and ignores an older route settling late', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    reader.restoreConversation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount({ connected: false });
    expect(controller.restoring).toBe(true);
    await update({ conversationId: 'b', agent: { ...agent(), id: 'b' } });
    expect(controller.restoring).toBe(true);
    await TestRenderer.act(async () => { second.resolve(); });
    expect(controller.restoring).toBe(false);
    await TestRenderer.act(async () => { first.resolve(); });
    expect(controller.restoring).toBe(false);
    expect(reader.loadConversation).not.toHaveBeenCalled();
  });

  it('finishes the loading state on cache failure instead of leaving an endless skeleton', async () => {
    const restore = deferred<void>();
    reader.restoreConversation.mockReturnValueOnce(restore.promise);
    await mount({ connected: false });
    expect(controller.restoring).toBe(true);
    await TestRenderer.act(async () => { restore.reject(new Error('Storage unavailable')); });
    expect(controller.restoring).toBe(false);
    expect(controller.error).toBe('Storage unavailable');
  });

  it('does not declare metadata unavailable while runtime restoration is still pending', async () => {
    const hydrate = deferred<void>();
    reader.hydrate.mockReturnValueOnce(hydrate.promise);
    await mount({ agent: undefined, connected: false });
    expect(reader.restoreConversation).toHaveBeenCalledWith('a');
    expect(controller.restoring).toBe(true);
    await TestRenderer.act(async () => { hydrate.resolve(); });
    expect(controller.restoring).toBe(false);
  });

  it('does not make online reading wait for runtime or outbox restoration', async () => {
    const hydrate = deferred<void>();
    reader.hydrate.mockReturnValueOnce(hydrate.promise);
    await mount();
    expect(controller.restoring).toBe(true);
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => { hydrate.resolve(); });
    expect(controller.restoring).toBe(false);
  });

  it.each([
    ['working', false, true, 1000],
    ['working', false, false, 2000],
    ['blocked', false, true, 1000],
    ['blocked', true, true, 3000],
    ['idle', false, true, 3000],
    ['done', false, true, 3000],
  ] as const)('preserves cadence for %s, question=%s, streaming=%s', async (status, question, streaming, interval) => {
    const current = agent();
    await mount({
      agent: { ...current, status, capabilities: { ...current.capabilities, streamingConversation: streaming } },
      hasOpenRequest: question,
    });
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
    await advance(interval - 1);
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(reader.loadConversation).toHaveBeenCalledTimes(2);
  });

  it('shares the pending read across status changes and manual retries', async () => {
    const slow = deferred<AgentConversation>();
    reader.loadConversation.mockReturnValueOnce(slow.promise);
    await mount();
    await update({ agent: { ...agent(), status: 'working' } });
    await TestRenderer.act(async () => { controller.retry(); });
    await advance(10_000);
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => { slow.resolve(conversation); });
    expect(reader.loadConversation).toHaveBeenCalledTimes(2);
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
  });

  it.each([{ connected: false }, { focused: false }, { foreground: false }])(
    'suppresses a late read error and stops scheduling after %j',
    async (patch) => {
      const slow = deferred<AgentConversation>();
      reader.loadConversation.mockReturnValueOnce(slow.promise);
      await mount();
      await update(patch);
      await TestRenderer.act(async () => { slow.reject(new Error('obsolete failure')); });
      await advance(10_000);
      expect(controller.error).toBeNull();
      expect(reader.loadConversation).toHaveBeenCalledTimes(1);
      expect(reader.markCompletionRead).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      await update({ connected: true, focused: true, foreground: true });
      expect(reader.loadConversation).toHaveBeenCalledTimes(2);
    },
  );

  it('does not acknowledge a read that finishes after unmount', async () => {
    const slow = deferred<AgentConversation>();
    reader.loadConversation.mockReturnValueOnce(slow.promise);
    reader.getCompletion.mockReturnValue({ id: 'finish-a', unread: true, statusRevision: 1 });
    await mount();
    await TestRenderer.act(async () => { renderer!.unmount(); renderer = undefined; });
    await TestRenderer.act(async () => { slow.resolve(conversation); });
    await advance(10_000);
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
    expect(reader.loadConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Error('Invalid response'), 'Invalid response'],
    [new ConnectionError('ERR_BRIDGE_CLOSED', 'Transport closed'), 'Not connected to this agent\u2019s device.'],
  ])('surfaces read failures and clears them on manual retry: %s', async (error, message) => {
    reader.loadConversation.mockRejectedValueOnce(error);
    await mount();
    expect(controller.error).toBe(message);
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
    await TestRenderer.act(async () => { controller.retry(); });
    expect(reader.loadConversation).toHaveBeenCalledTimes(2);
    expect(controller.error).toBeNull();
  });

  it('acknowledges only the unread completion captured before the successful read', async () => {
    const slow = deferred<AgentConversation>();
    reader.loadConversation.mockReturnValueOnce(slow.promise);
    reader.getCompletion.mockReturnValue({ id: 'finish-a', unread: true, statusRevision: 1 });
    await mount();
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
    reader.getCompletion.mockReturnValue({ id: 'finish-b', unread: true, statusRevision: 2 });
    await TestRenderer.act(async () => { slow.resolve(conversation); });
    expect(reader.markCompletionRead.mock.calls).toEqual([['a', 'finish-a']]);
  });

  it('does not acknowledge a completion that was already read', async () => {
    reader.getCompletion.mockReturnValue({ id: 'finish-a', unread: false, statusRevision: 1 });
    await mount();
    expect(reader.markCompletionRead).not.toHaveBeenCalled();
  });

  it('surfaces failed completion persistence and recovers on the next successful refresh', async () => {
    reader.getCompletion.mockReturnValue({ id: 'finish-a', unread: true, statusRevision: 1 });
    reader.markCompletionRead.mockRejectedValueOnce(new Error('Receipt storage failed'));
    await mount();
    expect(controller.error).toBe('Receipt storage failed');
    await advance(3000);
    expect(reader.markCompletionRead).toHaveBeenCalledTimes(2);
    expect(controller.error).toBeNull();
    expect(warning).toHaveBeenCalledWith('[COMPLETION] Could not save completion read state', expect.any(Error));
  });

  it('does not let an older receipt failure replace the outcome of a newer refresh', async () => {
    const receipt = deferred<void>();
    reader.getCompletion.mockReturnValue({ id: 'finish-a', unread: true, statusRevision: 1 });
    reader.markCompletionRead.mockReturnValueOnce(receipt.promise);
    await mount();
    reader.getCompletion.mockReturnValue({ id: 'finish-b', unread: true, statusRevision: 2 });
    await advance(3000);
    await TestRenderer.act(async () => { receipt.reject(new Error('Obsolete receipt failure')); });
    expect(reader.markCompletionRead.mock.calls).toEqual([['a', 'finish-a'], ['a', 'finish-b']]);
    expect(controller.error).toBeNull();
    expect(warning).toHaveBeenCalled();
  });

  it.each(['route', 'session'] as const)('does not show an earlier %s error in a new conversation identity', async (change) => {
    reader.loadConversation.mockRejectedValueOnce(new Error('Old failure'));
    await mount();
    expect(controller.error).toBe('Old failure');
    await update(change === 'route'
      ? { conversationId: 'b', agent: { ...agent(), id: 'b' }, connected: false }
      : { agent: { ...agent(), providerSessionId: 'session-new' }, connected: false });
    expect(controller.error).toBeNull();
  });

  it('does not apply a late cache failure from a previous route', async () => {
    const restore = deferred<void>();
    reader.restoreConversation.mockReturnValueOnce(restore.promise);
    await mount({ connected: false });
    await update({ conversationId: 'b', agent: { ...agent(), id: 'b' } });
    await TestRenderer.act(async () => { restore.reject(new Error('Old cache failure')); });
    expect(controller.error).toBeNull();
  });

  it('can retry a failed offline restore without polling a disconnected device', async () => {
    reader.restoreConversation.mockRejectedValueOnce(new Error('Cache failure'));
    await mount({ connected: false });
    expect(controller.error).toBe('Cache failure');
    await TestRenderer.act(async () => { controller.retry(); });
    expect(reader.restoreConversation).toHaveBeenCalledTimes(2);
    expect(reader.loadConversation).not.toHaveBeenCalled();
    expect(controller.error).toBeNull();
  });

  it('does not let a successful cache restore hide an online read failure', async () => {
    const restore = deferred<void>();
    reader.restoreConversation.mockReturnValueOnce(restore.promise);
    reader.loadConversation.mockRejectedValueOnce(new Error('Live failure'));
    await mount();
    await TestRenderer.act(async () => { restore.resolve(); });
    expect(controller.error).toBe('Live failure');
  });
});
