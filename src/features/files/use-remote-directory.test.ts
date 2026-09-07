import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import type { RemoteFile, SessionSnapshot } from '@/domain/remote';
import { useRemoteDirectory } from './use-remote-directory';

let mockFocused = true;
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const focused = mockFocused;
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function file(name: string, isDirectory = true): RemoteFile {
  return { name, path: `./${name}`, isDirectory, size: 0 };
}

type Options = Parameters<typeof useRemoteDirectory>[0];

describe('shared remote directory lifecycle', () => {
  let controller: ReturnType<typeof useRemoteDirectory>;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let options: Options;
  let live: SessionSnapshot | null;
  let client: jest.Mocked<Options['client']>;
  let onSessionChange: jest.Mock;

  function Harness(props: Options) {
    controller = useRemoteDirectory(props);
    return null;
  }

  async function mount(patch: Partial<Options> = {}) {
    options = { ...options, ...patch };
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(Harness, options)); });
  }

  async function update(patch: Partial<Options> = {}) {
    options = { ...options, ...patch };
    await TestRenderer.act(async () => { renderer!.update(createElement(Harness, options)); });
  }

  beforeEach(() => {
    mockFocused = true;
    live = { hostId: 'device-a', sessionId: 'session-a', status: 'connected' };
    client = {
      getSession: jest.fn(() => live),
      sftpList: jest.fn().mockResolvedValue([]),
    };
    onSessionChange = jest.fn();
    options = { hostId: 'device-a', sessionId: 'session-a', client, onSessionChange };
  });

  afterEach(async () => {
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it('normalizes paths, removes navigation entries and preserves folder/hidden/name ordering', async () => {
    const entries = [file('z.txt', false), file('.hidden', false), file('beta'), file('.config'), file('alpha'), file('..'), file('.')];
    const original = [...entries];
    client.sftpList.mockResolvedValue(entries);
    await mount({ initialPath: '~/Projects/../Code/' });
    expect(controller.path).toBe('~/Code');
    expect(client.sftpList).toHaveBeenCalledWith('session-a', './Code');
    expect(controller.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta', '.config', 'z.txt', '.hidden']);
    expect(entries).toEqual(original);
    expect(controller.ready).toBe(true);
    await update({ directoriesOnly: true });
    expect(controller.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta', '.config']);
    expect(client.sftpList).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a pending read from a loaded empty folder', async () => {
    const pending = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValue(pending.promise);
    await mount();
    expect(controller.loading).toBe(true);
    expect(controller.ready).toBe(false);
    expect(controller.request).not.toBeNull();
    await TestRenderer.act(async () => { pending.resolve([]); });
    expect(controller.loading).toBe(false);
    expect(controller.ready).toBe(true);
  });

  it('waits for a session and reloads on reconnection', async () => {
    await mount({ sessionId: null });
    expect(client.sftpList).not.toHaveBeenCalled();
    expect(controller.loading).toBe(false);
    expect(controller.ready).toBe(false);
    await update({ sessionId: 'session-a' });
    expect(client.sftpList).toHaveBeenCalledWith('session-a', '.');
    expect(controller.ready).toBe(true);
  });

  it.each(['success', 'error'] as const)('discards an old path %s even before the next render commits', async (outcome) => {
    const old = deferred<RemoteFile[]>();
    const next = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mount();
    await TestRenderer.act(async () => {
      controller.navigate('/next');
      if (outcome === 'success') old.resolve([file('obsolete')]);
      else old.reject(new Error('Obsolete error'));
      await Promise.resolve();
    });
    expect(controller.path).toBe('/next');
    expect(controller.entries).toEqual([]);
    expect(controller.error).toBeNull();
    expect(controller.loading).toBe(true);
    await TestRenderer.act(async () => { next.resolve([file('current')]); });
    expect(controller.entries.map((entry) => entry.name)).toEqual(['current']);
    expect(client.sftpList).toHaveBeenLastCalledWith('session-a', '/next');
  });

  it('clears an earlier listing while browsing a new path', async () => {
    client.sftpList.mockResolvedValueOnce([file('old-folder')]);
    await mount();
    const next = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(next.promise);
    await TestRenderer.act(async () => { controller.navigate('/next'); });
    expect(controller.entries).toEqual([]);
    expect(controller.ready).toBe(false);
    await TestRenderer.act(async () => { next.resolve([]); });
    expect(controller.ready).toBe(true);
  });

  it('does not let a failed older refresh replace a newer result for the same path', async () => {
    const old = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(old.promise).mockResolvedValueOnce([file('latest')]);
    await mount();
    await TestRenderer.act(async () => { controller.refresh(); });
    await TestRenderer.act(async () => { old.reject(new Error('Old failure')); });
    expect(controller.entries.map((entry) => entry.name)).toEqual(['latest']);
    expect(controller.error).toBeNull();
  });

  it.each(['success', 'error'] as const)('rejects a %s from a silently replaced native session', async (outcome) => {
    const pending = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(pending.promise);
    await mount();
    live = { hostId: 'device-a', sessionId: 'session-b', status: 'connected' };
    await TestRenderer.act(async () => {
      if (outcome === 'success') pending.resolve([file('old-session')]);
      else pending.reject(new Error('Old session error'));
    });
    expect(controller.entries).toEqual([]);
    expect(controller.ready).toBe(false);
    expect(controller.error).toContain('disconnected');
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    await update({ sessionId: 'session-b' });
    expect(client.sftpList).toHaveBeenLastCalledWith('session-b', '.');
    expect(controller.ready).toBe(true);
  });

  it.each(['disconnected', 'connecting'] as const)('does not read a native session whose status is %s', async (status) => {
    live = { hostId: 'device-a', sessionId: 'session-a', status };
    await mount();
    expect(client.sftpList).not.toHaveBeenCalled();
    expect(controller.loading).toBe(false);
    expect(controller.error).toContain('disconnected');
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it('checks session status again before publishing, even if its id did not change', async () => {
    const pending = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(pending.promise);
    await mount();
    live = { hostId: 'device-a', sessionId: 'session-a', status: 'disconnected' };
    await TestRenderer.act(async () => { pending.resolve([file('obsolete')]); });
    expect(controller.ready).toBe(false);
    expect(controller.entries).toEqual([]);
    expect(onSessionChange).toHaveBeenCalled();
  });

  it('resets the path for a different host and ignores the previous host response', async () => {
    const old = deferred<RemoteFile[]>();
    await mount();
    client.sftpList.mockReturnValueOnce(old.promise);
    await TestRenderer.act(async () => { controller.navigate('/private-a'); });
    live = { hostId: 'device-b', sessionId: 'session-b', status: 'connected' };
    await update({ hostId: 'device-b', sessionId: 'session-b' });
    expect(controller.path).toBe('~');
    expect(client.sftpList).toHaveBeenLastCalledWith('session-b', '.');
    await TestRenderer.act(async () => { old.resolve([file('a-only')]); });
    expect(controller.entries).toEqual([]);
  });

  it('does not read while unfocused and reloads on refocus without retaining a previous request token', async () => {
    mockFocused = false;
    await mount();
    expect(client.sftpList).not.toHaveBeenCalled();
    mockFocused = true;
    await update();
    const first = controller.request;
    expect(controller.ready).toBe(true);
    mockFocused = false;
    await update();
    expect(controller.capture()).toBeNull();
    mockFocused = true;
    await update();
    expect(controller.request).not.toBe(first);
    expect(client.sftpList).toHaveBeenCalledTimes(2);
  });

  it.each(['blur', 'unmount', 'cancel'] as const)('discards a late error after %s', async (action) => {
    const pending = deferred<RemoteFile[]>();
    client.sftpList.mockReturnValueOnce(pending.promise);
    await mount();
    if (action === 'blur') { mockFocused = false; await update(); }
    else if (action === 'cancel') await TestRenderer.act(async () => { controller.cancel(); });
    else await TestRenderer.act(async () => { renderer!.unmount(); renderer = undefined; });
    await TestRenderer.act(async () => { pending.reject(new Error('Late failure')); });
    expect(controller.error).toBeNull();
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('surfaces native lookup and listing failures and permits explicit retry', async () => {
    client.getSession.mockImplementationOnce(() => { throw new Error('Native unavailable'); });
    await mount();
    expect(controller.error).toBe('Native unavailable');
    client.sftpList.mockRejectedValueOnce(new Error('Permission denied'));
    await TestRenderer.act(async () => { controller.refresh(); });
    expect(controller.error).toBe('Permission denied');
    await TestRenderer.act(async () => { controller.refresh(); });
    expect(controller.ready).toBe(true);
    expect(controller.error).toBeNull();
  });

  it('allows a same-scope mutation refresh but ignores delayed mutations from another path', async () => {
    await mount();
    const first = controller.request!;
    await TestRenderer.act(async () => { controller.refresh(first); });
    expect(client.sftpList).toHaveBeenCalledTimes(2);
    await TestRenderer.act(async () => { controller.navigate('/next'); });
    const current = controller.request;
    await TestRenderer.act(async () => { controller.refresh(first); });
    expect(client.sftpList).toHaveBeenCalledTimes(3);
    expect(controller.request).toBe(current);
    expect(controller.path).toBe('/next');
  });

  it('validates native session ownership before a captured request is used for an action', async () => {
    await mount();
    const target = controller.request;
    expect(controller.isCurrent(target)).toBe(true);
    live = { hostId: 'device-b', sessionId: 'session-a', status: 'connected' };
    let valid = true;
    await TestRenderer.act(async () => { valid = controller.isCurrent(target); });
    expect(valid).toBe(false);
    expect(controller.error).toContain('disconnected');
  });
});
