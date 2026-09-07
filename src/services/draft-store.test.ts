import { DraftStore } from './draft-store';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('DraftStore', () => {
  it('preserves the existing key format and removes the key for an empty draft', async () => {
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    const drafts = new DraftStore(storage);
    expect(await drafts.loadDraft('agent-a')).toBe('');
    await drafts.saveDraft('agent-a', '');
    expect(storage.getItem).toHaveBeenCalledWith('remote-workspace.herdr.draft.agent-a');
    expect(storage.removeItem).toHaveBeenCalledWith('remote-workspace.herdr.draft.agent-a');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('orders writes for one agent without blocking another, and loads wait for writes', async () => {
    const first = deferred();
    const values = new Map<string, string>();
    const storage = {
      getItem: jest.fn(async (key: string) => values.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        if (value === 'first') await first.promise;
        values.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => { values.delete(key); }),
    };
    const drafts = new DraftStore(storage);
    const one = drafts.saveDraft('a', 'first');
    const two = drafts.saveDraft('a', 'second');
    const clear = drafts.saveDraft('a', '');
    const load = drafts.loadDraft('a');
    await drafts.saveDraft('b', 'independent');
    expect(storage.setItem.mock.calls).toEqual([
      ['remote-workspace.herdr.draft.a', 'first'],
      ['remote-workspace.herdr.draft.b', 'independent'],
    ]);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    first.resolve();
    await Promise.all([one, two, clear]);
    expect(await load).toBe('');
    expect(storage.setItem.mock.calls.slice(2)).toEqual([
      ['remote-workspace.herdr.draft.a', 'second'],
    ]);
    expect(storage.removeItem).toHaveBeenCalledWith('remote-workspace.herdr.draft.a');
  });

  it('surfaces pending and completed write failures to loads, then permits recovery', async () => {
    const pending = deferred();
    const failure = new Error('disk full');
    const storage = {
      getItem: jest.fn().mockResolvedValue('recovered'),
      setItem: jest.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    const drafts = new DraftStore(storage);
    const write = drafts.saveDraft('a', 'failed');
    const writeAssertion = expect(write).rejects.toBe(failure);
    const loadAssertion = expect(drafts.loadDraft('a')).rejects.toBe(failure);
    pending.reject(failure);
    await Promise.all([writeAssertion, loadAssertion]);
    await expect(drafts.loadDraft('a')).rejects.toBe(failure);
    expect(storage.getItem).not.toHaveBeenCalled();
    await drafts.saveDraft('a', 'recovered');
    expect(await drafts.loadDraft('a')).toBe('recovered');
  });

  it('does not poison already queued writes after a failure', async () => {
    const failure = new Error('write failed');
    const storage = {
      getItem: jest.fn().mockResolvedValue('latest'),
      setItem: jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    const drafts = new DraftStore(storage);
    const failed = drafts.saveDraft('a', 'old');
    const latest = drafts.saveDraft('a', 'latest');
    await expect(failed).rejects.toBe(failure);
    await latest;
    expect(storage.setItem.mock.calls.map((call) => call[1])).toEqual(['old', 'latest']);
    expect(await drafts.loadDraft('a')).toBe('latest');
  });

  it('surfaces read failures instead of returning an empty draft', async () => {
    const failure = new Error('read failed');
    const drafts = new DraftStore({
      getItem: jest.fn().mockRejectedValue(failure), setItem: jest.fn(), removeItem: jest.fn(),
    });
    await expect(drafts.loadDraft('a')).rejects.toBe(failure);
  });

  it('surfaces failed removals to loads and retries the clear through the same queue', async () => {
    const failure = new Error('remove failed');
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    };
    const drafts = new DraftStore(storage);
    await expect(drafts.saveDraft('a', '')).rejects.toBe(failure);
    await expect(drafts.loadDraft('a')).rejects.toBe(failure);
    expect(storage.getItem).not.toHaveBeenCalled();
    await drafts.saveDraft('a', '');
    expect(await drafts.loadDraft('a')).toBe('');
    expect(storage.removeItem).toHaveBeenCalledTimes(2);
  });

  it('orders newer input after a slow clear so removal cannot erase the new draft', async () => {
    const removing = deferred();
    const storage = {
      getItem: jest.fn().mockResolvedValue('new draft'),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockReturnValue(removing.promise),
    };
    const drafts = new DraftStore(storage);
    const clear = drafts.saveDraft('a', '');
    const next = drafts.saveDraft('a', 'new draft');
    await Promise.resolve();
    await Promise.resolve();
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    removing.resolve();
    await Promise.all([clear, next]);
    expect(storage.setItem).toHaveBeenCalledWith('remote-workspace.herdr.draft.a', 'new draft');
    expect(await drafts.loadDraft('a')).toBe('new draft');
  });
});
