import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, FlatList } from 'react-native';

import FilesScreen from '@/app/files/[id]';
import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { NeedsSession } from '@/components/ui/needs-session';
import { TextField } from '@/components/ui/text-field';
import type { RemoteFile, SessionSnapshot } from '@/domain/remote';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { remoteClient } from '@/services/native-remote-client';
import { RemotePathBar } from './remote-path-bar';

let mockFocused = true;
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: jest.fn(),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const focused = mockFocused;
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));
jest.mock('@/components/ui/screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/app-button', () => ({ AppButton: () => null }));
jest.mock('@/components/ui/text-field', () => ({ TextField: () => null }));
jest.mock('@/components/ui/needs-session', () => ({ NeedsSession: () => null }));
jest.mock('./remote-path-bar', () => ({ RemotePathBar: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));
jest.mock('@/features/connection/use-host-session', () => ({
  useHostSession: jest.fn(), refreshSessions: jest.fn(),
}));
jest.mock('@/services/native-remote-client', () => ({
  remoteClient: {
    getSession: jest.fn(), sftpList: jest.fn(), sftpMkdir: jest.fn(), sftpRemove: jest.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const item: RemoteFile = { name: 'file.txt', path: '/home/user/file.txt', isDirectory: false, size: 3 };

describe('file manager directory integration', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let session: SessionSnapshot | null;
  let alert: jest.SpyInstance<ReturnType<typeof Alert.alert>, Parameters<typeof Alert.alert>>;

  async function mount() {
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(FilesScreen)); });
  }

  async function update() {
    await TestRenderer.act(async () => { renderer!.update(createElement(FilesScreen)); });
  }

  function button(label: string) {
    const result = renderer!.root.findAllByType(AppButton).find((node) => node.props.label === label);
    if (!result) throw new Error(`Button not found: ${label}`);
    return result;
  }

  function pathBar() { return renderer!.root.findByType(RemotePathBar); }
  function field() { return renderer!.root.findByType(TextField); }
  function list() { return renderer!.root.findByType(FlatList); }
  function text() {
    return renderer!.root.findAllByType(ThemedText).map((node) => node.props.children).join(' ');
  }

  function promptDelete() {
    list().props.renderItem({ item }).props.onLongPress();
    const confirm = alert.mock.calls.at(-1)?.[2]?.find((entry) => entry.text === 'Delete')?.onPress;
    if (!confirm) throw new Error('Delete confirmation missing');
    return confirm;
  }

  beforeEach(() => {
    jest.resetAllMocks();
    mockFocused = true;
    session = { hostId: 'device-a', sessionId: 'session-a', status: 'connected' };
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: 'device-a' });
    jest.mocked(useHostSession).mockImplementation(() => session);
    jest.mocked(remoteClient.getSession).mockImplementation(() => session);
    jest.mocked(remoteClient.sftpList).mockResolvedValue([item]);
    jest.mocked(remoteClient.sftpMkdir).mockResolvedValue(undefined);
    jest.mocked(remoteClient.sftpRemove).mockResolvedValue(undefined);
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(async () => {
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
    alert.mockRestore();
  });

  it('does not label a pending directory read as an empty folder', async () => {
    const pending = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValueOnce(pending.promise);
    await mount();
    expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(text()).not.toContain('This folder is empty.');
    await TestRenderer.act(async () => { pending.resolve([]); });
    expect(text()).toContain('This folder is empty.');
    expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('shows list errors inline and retries through the shared reader', async () => {
    jest.mocked(remoteClient.sftpList).mockRejectedValueOnce(new Error('Permission denied'));
    await mount();
    expect(text()).toContain('Permission denied');
    expect(text()).not.toContain('This folder is empty.');
    await TestRenderer.act(async () => { button('Try again').props.onPress(); });
    expect(list().props.data).toEqual([item]);
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(2);
    expect(refreshSessions).toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('creates a trimmed home-relative folder and refreshes only after success', async () => {
    await mount();
    await TestRenderer.act(async () => { field().props.onChangeText(' New folder '); });
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    expect(remoteClient.sftpMkdir).toHaveBeenCalledWith('session-a', './New folder');
    expect(field().props.value).toBe('');
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(2);
    expect(alert).not.toHaveBeenCalled();
  });

  it('keeps a newer folder name while the previous creation completes', async () => {
    const creating = deferred<void>();
    jest.mocked(remoteClient.sftpMkdir).mockReturnValueOnce(creating.promise);
    await mount();
    await TestRenderer.act(async () => { field().props.onChangeText('First'); });
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    await TestRenderer.act(async () => { field().props.onChangeText('Next'); creating.resolve(); });
    expect(field().props.value).toBe('Next');
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed creation refresh another folder or clear its name', async () => {
    const creating = deferred<void>();
    jest.mocked(remoteClient.sftpMkdir).mockReturnValueOnce(creating.promise);
    await mount();
    await TestRenderer.act(async () => { field().props.onChangeText('First'); });
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    await TestRenderer.act(async () => { pathBar().props.onNavigate('/other'); field().props.onChangeText('Next'); });
    await TestRenderer.act(async () => { creating.resolve(); });
    expect(pathBar().props.path).toBe('/other');
    expect(field().props.value).toBe('Next');
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(2);
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-a', '/other');
  });

  it.each(['path', 'session', 'blur'] as const)('refuses an old delete confirmation after a %s change', async (change) => {
    await mount();
    const confirm = promptDelete();
    if (change === 'path') await TestRenderer.act(async () => { pathBar().props.onNavigate('/other'); });
    else if (change === 'session') session = { hostId: 'device-a', sessionId: 'session-b', status: 'connected' };
    else { mockFocused = false; await update(); }
    await TestRenderer.act(async () => { confirm(); });
    expect(remoteClient.sftpRemove).not.toHaveBeenCalled();
    expect(alert).toHaveBeenLastCalledWith('Folder changed', 'The folder or connection changed. Try again.');
  });

  it('deletes using the captured session and remote path without disturbing a newer listing', async () => {
    const removing = deferred<void>();
    jest.mocked(remoteClient.sftpRemove).mockReturnValueOnce(removing.promise);
    await mount();
    const confirm = promptDelete();
    await TestRenderer.act(async () => { confirm(); });
    expect(remoteClient.sftpRemove).toHaveBeenCalledWith('session-a', item.path);
    await TestRenderer.act(async () => { pathBar().props.onNavigate('/other'); });
    await TestRenderer.act(async () => { removing.resolve(); });
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(2);
    expect(pathBar().props.path).toBe('/other');
  });

  it('does not report a successful mutation as failed when its directory refresh fails', async () => {
    await mount();
    jest.mocked(remoteClient.sftpList).mockRejectedValueOnce(new Error('List failed'));
    await TestRenderer.act(async () => { field().props.onChangeText('Created'); });
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    expect(field().props.value).toBe('');
    expect(text()).toContain('List failed');
    expect(alert).not.toHaveBeenCalled();
  });

  it('preserves mutation errors and invalid-name protection', async () => {
    await mount();
    await TestRenderer.act(async () => { field().props.onChangeText('../bad'); });
    expect(button('Create').props.disabled).toBe(true);
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    expect(remoteClient.sftpMkdir).not.toHaveBeenCalled();
    jest.mocked(remoteClient.sftpMkdir).mockRejectedValueOnce(new Error('Create denied'));
    await TestRenderer.act(async () => { field().props.onChangeText('Valid'); });
    await TestRenderer.act(async () => { button('Create').props.onPress(); });
    expect(field().props.value).toBe('Valid');
    expect(alert).toHaveBeenLastCalledWith('Could not create folder', 'Create denied');
    expect(remoteClient.sftpList).toHaveBeenCalledTimes(1);
  });

  it('does not retain file actions for a disconnected snapshot and resumes when connected', async () => {
    session = { hostId: 'device-a', sessionId: 'session-a', status: 'disconnected' };
    await mount();
    expect(renderer!.root.findAllByType(NeedsSession)).toHaveLength(1);
    expect(remoteClient.sftpList).not.toHaveBeenCalled();
    session = { ...session, status: 'connected' };
    await update();
    expect(list().props.data).toEqual([item]);
  });
});
