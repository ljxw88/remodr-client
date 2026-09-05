import { FlowDraftStore, type NewAgentDraft } from './flow-drafts';

const draft = (): NewAgentDraft => ({
  kind: 'new-agent', deviceId: 'a', workspaceId: 'w1', name: 'Review changes',
  provider: 'copilot', tuning: { model: null, effort: null, context: null }, bypassPermissions: true,
});

describe('form flow drafts', () => {
  it('keeps editing state while a nested selector is open and returns to its parent', async () => {
    const store = new FlowDraftStore();
    const id = store.create(draft());
    const parent = store.retain(id);
    const selector = store.retain(id);
    store.update(id, (current) => current.kind === 'new-agent'
      ? { ...current, tuning: { ...current.tuning, model: 'claude-sonnet-5' } } : current);
    selector();
    await Promise.resolve();
    expect(store.get(id)).toMatchObject({ name: 'Review changes', tuning: { model: 'claude-sonnet-5' } });
    parent();
    await Promise.resolve();
    expect(store.get(id)).toBeUndefined();
  });

  it('does not lose the form during a StrictMode effect remount', async () => {
    const store = new FlowDraftStore();
    const id = store.create(draft());
    store.retain(id)();
    const remount = store.retain(id);
    await Promise.resolve();
    expect(store.get(id)).toBeDefined();
    remount();
    await Promise.resolve();
    expect(store.get(id)).toBeUndefined();
  });

  it('isolates concurrent drafts and publishes replacements', () => {
    const store = new FlowDraftStore();
    const a = store.create(draft());
    const b = store.create({ ...draft(), deviceId: 'b' });
    const listener = jest.fn();
    store.subscribe(listener);
    store.update(a, (current) => current.kind === 'new-agent' ? { ...current, name: 'Changed' } : current);
    expect(store.get(a)).toMatchObject({ name: 'Changed' });
    expect(store.get(b)).toMatchObject({ name: 'Review changes', deviceId: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects editing an expired form or changing its workflow kind', () => {
    const store = new FlowDraftStore();
    const id = store.create(draft());
    expect(() => store.update(id, () => ({ kind: 'new-space', deviceId: 'a', label: '', cwd: '~/' })))
      .toThrow('workflow type');
    store.discard(id);
    expect(() => store.update(id, () => draft())).toThrow('no longer available');
  });
});
