import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { DraftStore, type DraftRepository } from '@/services/draft-store';
import { usePersistedDraft, type DraftSendToken } from './use-persisted-draft';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('persisted conversation drafts', () => {
  let controller: ReturnType<typeof usePersistedDraft>;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let repository: DraftRepository & {
    loadDraft: jest.Mock<Promise<string>, [string]>;
    saveDraft: jest.Mock<Promise<void>, [string, string]>;
  };
  let warning: jest.SpyInstance;

  function Harness({ id = 'a', focused = true, foreground = true }: {
    id?: string; focused?: boolean; foreground?: boolean;
  }) {
    controller = usePersistedDraft({ agentId: id, repository, focused, foreground });
    return null;
  }

  async function mount(props: Parameters<typeof Harness>[0] = {}) {
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(Harness, props)); });
  }

  async function update(props: Parameters<typeof Harness>[0]) {
    await TestRenderer.act(async () => { renderer!.update(createElement(Harness, props)); });
  }

  async function unmount() {
    await TestRenderer.act(async () => { renderer?.unmount(); renderer = undefined; });
  }

  async function type(text: string) {
    await TestRenderer.act(async () => { controller.changeDraft(text); });
  }

  async function advance(ms = 250) {
    await TestRenderer.act(async () => { jest.advanceTimersByTime(ms); });
  }

  function capture() {
    return controller.captureSend() as DraftSendToken;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    repository = { loadDraft: jest.fn().mockResolvedValue(''), saveDraft: jest.fn().mockResolvedValue(undefined) };
    warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await unmount();
    warning.mockRestore();
    jest.useRealTimers();
  });

  it('restores without rewriting disk on mount, idle, or unmount', async () => {
    repository.loadDraft.mockResolvedValue('saved');
    await mount();
    expect(controller.draft).toBe('saved');
    await advance();
    await unmount();
    expect(repository.saveDraft).not.toHaveBeenCalled();
  });

  it('debounces only input changes and flushes the latest same-tick input on immediate exit', async () => {
    await mount();
    await type('h');
    await advance(100);
    await type('he');
    await advance(100);
    await type('hello');
    expect(repository.saveDraft).not.toHaveBeenCalled();
    await advance(249);
    expect(repository.saveDraft).not.toHaveBeenCalled();
    await advance(1);
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'hello']]);
    await TestRenderer.act(async () => {
      controller.changeDraft('latest');
      renderer!.unmount();
      renderer = undefined;
    });
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'hello'], ['a', 'latest']]);
    await advance();
    expect(repository.saveDraft).toHaveBeenCalledTimes(2);
  });

  it.each([{ focused: false }, { foreground: false }])('flushes while still mounted on %j', async (props) => {
    await mount();
    await type('pending');
    await update(props);
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'pending']]);
    await advance();
    await unmount();
    expect(repository.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite typing with a slow restore and flushes it after immediate exit', async () => {
    const restore = deferred<string>();
    repository.loadDraft.mockReturnValue(restore.promise);
    await mount();
    await type('new text');
    await unmount();
    expect(repository.saveDraft).not.toHaveBeenCalled();
    await TestRenderer.act(async () => { restore.resolve('old disk text'); });
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'new text']]);
  });

  it('fences route changes without displaying old text or saving a blank to the new id', async () => {
    const restoreB = deferred<string>();
    repository.loadDraft.mockImplementation((id) => id === 'a' ? Promise.resolve('saved a') : restoreB.promise);
    await mount();
    await type('edited a');
    await update({ id: 'b' });
    expect(controller.draft).toBe('');
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'edited a']]);
    await advance();
    expect(repository.saveDraft).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => { restoreB.resolve('saved b'); });
    expect(controller.draft).toBe('saved b');
    await unmount();
    expect(repository.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('ignores the old agent restore after routing to a new agent', async () => {
    const restoreA = deferred<string>();
    repository.loadDraft.mockImplementation((id) => id === 'a' ? restoreA.promise : Promise.resolve('b text'));
    await mount();
    await update({ id: 'b' });
    await TestRenderer.act(async () => { restoreA.resolve('a text'); });
    expect(controller.draft).toBe('b text');
    expect(repository.saveDraft).not.toHaveBeenCalled();
  });

  it('never overwrites disk following a failed restore, and retries on a lifecycle event', async () => {
    repository.loadDraft.mockRejectedValue(new Error('read failed'));
    await mount();
    expect(controller.error).toMatch(/Could not restore/);
    await type('new text');
    await advance();
    expect(repository.saveDraft).not.toHaveBeenCalled();
    expect(controller.draft).toBe('new text');
    repository.loadDraft.mockResolvedValue('existing disk');
    await update({ foreground: false });
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'new text']]);
    expect(controller.draft).toBe('new text');
    expect(controller.error).toBeNull();
    expect(warning).toHaveBeenCalledWith('[CONVERSATION] Could not load draft', expect.any(Error));
  });

  it('does not replace unread disk with an untouched blank after a failed restore', async () => {
    repository.loadDraft.mockRejectedValue(new Error('read failed'));
    await mount();
    await update({ focused: false });
    await unmount();
    expect(repository.saveDraft).not.toHaveBeenCalled();
  });

  it('retries a failed restore after new input without applying the old disk text', async () => {
    repository.loadDraft.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue('old disk');
    await mount();
    await type('replacement');
    await advance();
    expect(controller.draft).toBe('replacement');
    expect(controller.error).toBeNull();
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'replacement']]);
  });

  it.each(['lifecycle', 'input', 'remount'])('surfaces save failures and retries on %s', async (retry) => {
    repository.saveDraft.mockRejectedValueOnce(new Error('disk full'));
    await mount();
    await type('keep me');
    await advance();
    expect(controller.draft).toBe('keep me');
    expect(controller.error).toMatch(/Could not save/);
    expect(warning).toHaveBeenCalledWith('[CONVERSATION] Could not save draft', expect.any(Error));
    if (retry === 'lifecycle') await update({ focused: false });
    else if (retry === 'input') { await type('newer'); await advance(); }
    else { await unmount(); await mount(); }
    expect(repository.saveDraft).toHaveBeenLastCalledWith('a', retry === 'input' ? 'newer' : 'keep me');
    expect(controller.error).toBeNull();
  });

  it('clears durably on successful enqueue immediately, without waiting for debounce', async () => {
    await mount();
    await type('  send this  ');
    const token = capture();
    expect(token.agentId).toBe('a');
    expect(token.text).toBe('send this');
    await TestRenderer.act(async () => { await token.complete(); });
    expect(controller.draft).toBe('');
    expect(repository.saveDraft.mock.calls).toEqual([['a', '']]);
    await advance();
    await unmount();
    expect(repository.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('retains failed exit writes for retry on remount', async () => {
    repository.saveDraft.mockRejectedValue(new Error('disk full'));
    await mount();
    await type('unsaved');
    await unmount();
    repository.saveDraft.mockResolvedValue(undefined);
    await mount();
    expect(controller.draft).toBe('unsaved');
    expect(controller.error).toBeNull();
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'unsaved'], ['a', 'unsaved']]);
  });

  it('persists the successful clear after unmount, ordered behind the exit flush', async () => {
    const oldWrite = deferred<void>();
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockImplementationOnce(() => oldWrite.promise).mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    const store = new DraftStore(storage);
    repository.loadDraft.mockImplementation((id) => store.loadDraft(id));
    repository.saveDraft.mockImplementation((id, text) => store.saveDraft(id, text));
    await mount();
    await type('sent');
    const token = capture();
    await unmount();
    let completed!: Promise<void>;
    await TestRenderer.act(async () => { completed = token.complete(); });
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'sent'], ['a', '']]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).not.toHaveBeenCalled();
    await TestRenderer.act(async () => { oldWrite.resolve(); await completed; });
    expect(storage.setItem.mock.calls).toEqual([
      ['remote-workspace.herdr.draft.a', 'sent'],
    ]);
    expect(storage.removeItem).toHaveBeenCalledWith('remote-workspace.herdr.draft.a');
    await advance();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it('does not clear edits made while sending, even if the text returns to the same value', async () => {
    await mount();
    await type('sent');
    const token = capture();
    await type('newer');
    await type('sent');
    await TestRenderer.act(async () => { await token.complete(); });
    expect(controller.draft).toBe('sent');
    await advance();
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'sent']]);
  });

  it('does not clear newer edits after unmount or a remount of the same agent', async () => {
    await mount();
    await type('sent');
    const token = capture();
    await unmount();
    await mount();
    expect(controller.draft).toBe('sent');
    await type('new screen edit');
    await unmount();
    await TestRenderer.act(async () => { await token.complete(); });
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'sent'], ['a', 'new screen edit']]);
  });

  it('updates a remounted screen when an earlier send succeeds without newer edits', async () => {
    await mount();
    await type('sent');
    const token = capture();
    await unmount();
    await mount();
    await TestRenderer.act(async () => { await token.complete(); });
    expect(controller.draft).toBe('');
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'sent'], ['a', '']]);
  });

  it('does not mark newer edits clean when a slow clear finishes', async () => {
    const clear = deferred<void>();
    repository.saveDraft.mockReturnValueOnce(clear.promise);
    await mount();
    await type('sent');
    const token = capture();
    let completed!: Promise<void>;
    await TestRenderer.act(async () => { completed = token.complete(); });
    await type('next message');
    await TestRenderer.act(async () => { clear.resolve(); await completed; });
    await unmount();
    expect(repository.saveDraft.mock.calls).toEqual([['a', ''], ['a', 'next message']]);
  });

  it('clears only the captured agent after a route change', async () => {
    await mount();
    await type('send a');
    const token = capture();
    await update({ id: 'b' });
    await type('keep b');
    await TestRenderer.act(async () => { await token.complete(); });
    expect(controller.draft).toBe('keep b');
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'send a'], ['a', '']]);
    await unmount();
    expect(repository.saveDraft).toHaveBeenLastCalledWith('b', 'keep b');
  });

  it('retains the revision fence when routing away and back during a send', async () => {
    await mount();
    await type('send a');
    const token = capture();
    await update({ id: 'b' });
    await update({ id: 'a' });
    await type('new a');
    await TestRenderer.act(async () => { await token.complete(); });
    expect(controller.draft).toBe('new a');
    expect(repository.saveDraft.mock.calls).toEqual([['a', 'send a']]);
  });

  it('does not let a pending restore resurrect a successfully sent draft', async () => {
    const restore = deferred<string>();
    repository.loadDraft.mockReturnValue(restore.promise);
    await mount();
    await type('sent');
    const token = capture();
    await TestRenderer.act(async () => { await token.complete(); restore.resolve('old text'); });
    expect(controller.draft).toBe('');
    expect(repository.saveDraft.mock.calls).toEqual([['a', '']]);
  });

  it('surfaces a failed durable clear and retries it rather than resurrecting sent text', async () => {
    repository.saveDraft.mockRejectedValueOnce(new Error('disk full'));
    await mount();
    await type('sent');
    const token = capture();
    await TestRenderer.act(async () => { await expect(token.complete()).rejects.toThrow('disk full'); });
    expect(controller.draft).toBe('');
    expect(controller.error).toMatch(/Could not save/);
    await update({ foreground: false });
    expect(repository.saveDraft.mock.calls).toEqual([['a', ''], ['a', '']]);
    expect(controller.error).toBeNull();
  });

  it('leaves the draft intact on enqueue failure and consumes tokens only once', async () => {
    await mount();
    await type('not queued');
    const failed = capture();
    failed.cancel();
    await TestRenderer.act(async () => { await failed.complete(); });
    expect(controller.draft).toBe('not queued');
    const success = capture();
    await TestRenderer.act(async () => { await success.complete(); });
    await type('next message');
    await TestRenderer.act(async () => { await success.complete(); success.cancel(); });
    expect(controller.draft).toBe('next message');
    expect(repository.saveDraft.mock.calls).toEqual([['a', '']]);
  });
});
