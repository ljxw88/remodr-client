import { CommandOutbox } from '@/services/command-outbox';

jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

function store() {
  let value: string | null = null;
  return {
    getItem: jest.fn(async () => value),
    setItem: jest.fn(async (_key: string, next: string) => { value = next; }),
  };
}
const message = {
  deviceId: 'device-1', agentId: 'agent-1',
  action: 'agent.send_message' as const,
  payload: { text: 'hello', agentId: 'agent-1' }, text: 'hello', baselineIds: [],
};

describe('durable command outbox', () => {
  it('survives restart with the same command ID after an unacknowledged send', async () => {
    const disk = store();
    const first = new CommandOutbox(disk);
    const command = await first.enqueue(message);
    await first.update(command.id, { state: 'sending', attempted: true });
    const restarted = new CommandOutbox(disk);
    await restarted.hydrate();
    expect(restarted.getSnapshot()).toEqual([expect.objectContaining({
      id: command.id, state: 'queued', attempted: true,
    })]);
  });

  it('never retries an interrupt after restart', async () => {
    const disk = store();
    const first = new CommandOutbox(disk);
    const command = await first.enqueue({ ...message, action: 'agent.interrupt' });
    await first.update(command.id, { state: 'sending', attempted: true });
    const restarted = new CommandOutbox(disk);
    await restarted.hydrate();
    expect(restarted.getSnapshot()[0].state).toBe('uncertain');
  });

  it('also invalidates an interrupt that had not started before process death', async () => {
    const disk = store();
    await new CommandOutbox(disk).enqueue({ ...message, action: 'agent.interrupt' });
    const restarted = new CommandOutbox(disk);
    await restarted.hydrate();
    expect(restarted.getSnapshot()[0]).toMatchObject({ state: 'failed', invalidated: true });
  });

  it('makes claim and discard mutually exclusive', async () => {
    const outbox = new CommandOutbox(store());
    const command = await outbox.enqueue(message);
    await outbox.claim(command.id);
    await expect(outbox.discard(command.id)).rejects.toThrow('Wait for delivery');
    expect(outbox.getSnapshot()[0].state).toBe('sending');
  });

  it('serializes concurrent enqueues without losing messages', async () => {
    const outbox = new CommandOutbox(store());
    const commands = await Promise.all([outbox.enqueue(message), outbox.enqueue(message)]);
    expect(outbox.getSnapshot().map((item) => item.id)).toEqual(commands.map((item) => item.id));
    expect(new Set(commands.map((item) => item.id)).size).toBe(2);
  });

  it('deduplicates answers across controls before either enqueue completes', async () => {
    const outbox = new CommandOutbox(store());
    const answer = { ...message, action: 'human_request.answer' as const,
      payload: { requestId: 'question-1', answer: { customText: 'Yes' } } };
    const results = await Promise.allSettled([outbox.enqueue(answer), outbox.enqueue(answer)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(outbox.getSnapshot()).toHaveLength(1);
  });

  it('does not publish an enqueue which could not be saved', async () => {
    const disk = store();
    const outbox = new CommandOutbox(disk);
    await outbox.hydrate();
    disk.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(outbox.enqueue(message)).rejects.toThrow('disk full');
    expect(outbox.getSnapshot()).toEqual([]);
    await outbox.enqueue(message);
    expect(outbox.getSnapshot()).toHaveLength(1);
  });

  it('fails closed on a corrupt queue without overwriting it', async () => {
    const disk = store();
    disk.getItem.mockResolvedValue('not-json');
    const outbox = new CommandOutbox(disk);
    await expect(outbox.enqueue(message)).rejects.toThrow();
    expect(disk.setItem).not.toHaveBeenCalled();
  });

  it('never matches two identical sends to the same remote message across refreshes', async () => {
    const disk = store();
    const outbox = new CommandOutbox(disk);
    const first = await outbox.enqueue(message);
    const second = await outbox.enqueue(message);
    await outbox.reconcile(first.id, 'remote-message-1');
    const restarted = new CommandOutbox(disk);
    await restarted.hydrate();
    expect(restarted.getSnapshot()).toEqual([
      expect.objectContaining({ id: second.id, baselineIds: ['remote-message-1'] }),
    ]);
  });
});
