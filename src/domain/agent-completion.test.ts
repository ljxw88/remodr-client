import { completionForSnapshot, unreadCompletionCount, unreadCompletionsBySpace } from './agent-completion';
import { remoteAgentSchema, type AgentStatus, type RemoteAgent } from './herdr';

function agent(status: AgentStatus, revision?: number): RemoteAgent {
  return remoteAgentSchema.parse({
    id: 'a1', provider: 'copilot', providerSessionId: 'session-1',
    herdrSessionId: 'default', workspaceId: 'space-1', workspaceName: 'Work',
    paneId: 'p1', status, statusRevision: revision, title: 'Agent', focused: false, capabilities: {},
  });
}

describe('unread completion receipts', () => {
  let sequence: number;
  beforeEach(() => { sequence = 0; });
  const newId = () => `finish-${++sequence}`;
  function track(previous: RemoteAgent | undefined, next: RemoteAgent): RemoteAgent {
    return { ...next, observedStatus: next.status, completion: completionForSnapshot(previous, next, newId) };
  }

  it('marks completed sessions unread on first discovery, but not running or idle sessions', () => {
    expect(track(undefined, agent('done', 10)).completion).toMatchObject({ unread: true, statusRevision: 10 });
    expect(track(undefined, agent('working', 9)).completion).toBeUndefined();
    expect(track(undefined, agent('idle', 9)).completion).toBeUndefined();
  });

  it('preserves acknowledgement across duplicate snapshots and local optimistic status changes', () => {
    const done = track(undefined, agent('done', 10));
    const read = { ...done, completion: { ...done.completion!, unread: false } };
    expect(track(read, agent('done', 10)).completion).toEqual(read.completion);
    expect(track({ ...read, status: 'working' }, agent('done', 10)).completion).toEqual(read.completion);
  });

  it('notifies again for later finishes, including a missed working transition', () => {
    const first = track(undefined, agent('done', 10));
    const running = track(first, agent('working', 11));
    expect(running.completion).toEqual(first.completion);
    const second = track(running, agent('done', 12));
    expect(second.completion?.id).not.toBe(first.completion?.id);
    expect(second.completion?.unread).toBe(true);
    expect(track(second, agent('done', 14)).completion?.id).not.toBe(second.completion?.id);
  });

  it('uses native status edges on legacy bridges rather than optimistic send status', () => {
    const first = track(undefined, agent('done'));
    const read = { ...first, completion: { ...first.completion!, unread: false } };
    expect(track({ ...read, status: 'working' }, agent('done')).completion?.unread).toBe(false);
    const running = track(read, agent('working'));
    expect(track(running, agent('done')).completion?.unread).toBe(true);
  });

  it('adopts a newly available or reset counter without duplicating the same finish', () => {
    const first = track(undefined, agent('done'));
    const read = { ...first, completion: { ...first.completion!, unread: false } };
    const adopted = track(read, agent('done', 20));
    expect(adopted.completion).toEqual({ ...read.completion, statusRevision: 20 });
    const reset = track(adopted, agent('done', 1));
    expect(reset.completion).toEqual({ ...read.completion, statusRevision: 1 });
    expect(track(reset, agent('done', 3)).completion?.unread).toBe(true);
  });

  it('still notifies a real working-to-done transition when a server counter resets', () => {
    const done = track(undefined, agent('done', 20));
    const running = track(done, agent('working', 21));
    expect(track(running, agent('done', 1)).completion?.id).not.toBe(done.completion?.id);
  });

  it('does not carry notifications into replacement sessions or trust server-supplied read state', () => {
    const done = track(undefined, agent('done', 10));
    expect(track(done, { ...agent('idle', 11), providerSessionId: 'new-session' }).completion).toBeUndefined();
    expect(track(done, { ...agent('done', 10), providerSessionId: 'new-session' }).completion?.id)
      .not.toBe(done.completion?.id);
    expect(track(done, { ...agent('done', 10), completion: { ...done.completion!, unread: false } }).completion?.unread)
      .toBe(true);
  });

  it('aggregates independently by space and retains remaining unread work after one is read', () => {
    const one = track(undefined, agent('done', 10));
    const two = { ...track(undefined, agent('done', 11)), id: 'a2' };
    const three = { ...track(undefined, agent('done', 12)), id: 'a3', workspaceId: 'space-2' };
    expect(unreadCompletionCount([one, two, three])).toBe(3);
    expect(unreadCompletionsBySpace([one, two, three])).toEqual({ 'space-1': 2, 'space-2': 1 });
    const read = { ...one, completion: { ...one.completion!, unread: false } };
    expect(unreadCompletionsBySpace([read, two, three])).toEqual({ 'space-1': 1, 'space-2': 1 });
  });
});
