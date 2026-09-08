import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import FilesScreen from '@/app/files/[id]';
import { SelectionRowSkeleton } from '@/components/ui/form-page';
import { useRemoteDirectory } from '@/features/files/use-remote-directory';
import { useHostSession } from '@/features/connection/use-host-session';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: jest.fn(() => ({ id: 'device-a' })),
}));
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('@/components/ui/form-page'),
    FormPage: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children, footer),
  };
});
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: () => ({ hosts: [] }) }));
jest.mock('@/components/ui/text-field', () => ({
  TextField: () => null,
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/themed-text', () => ({
  ThemedText: ({ children }: { children: import('react').ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      children,
    ),
}));
jest.mock('@/components/ui/app-button', () => ({
  AppButton: ({ label }: { label: string }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      label,
    ),
}));
jest.mock('@/features/files/use-remote-directory', () => ({
  useRemoteDirectory: jest.fn(),
}));
jest.mock('@/features/connection/use-host-session', () => ({
  useHostSession: jest.fn(),
  refreshSessions: jest.fn(),
}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type DirectoryState = ReturnType<typeof useRemoteDirectory>;

const file = { name: 'notes.txt', path: '~/Projects/notes.txt', isDirectory: false, size: 12 };

describe('file browser loading states', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let directoryState: DirectoryState;

  function render() {
    jest.mocked(useRemoteDirectory).mockReturnValue(directoryState);
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FilesScreen));
    });
  }

  function updateDirectory(next: Partial<DirectoryState>) {
    directoryState = { ...directoryState, ...next };
    if (renderer) {
      jest.mocked(useRemoteDirectory).mockReturnValue(directoryState);
      TestRenderer.act(() => {
        renderer.update(createElement(FilesScreen));
      });
    }
  }

  function list() {
    return renderer.root.findByType(FlatList);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: 'device-a' });
    jest.mocked(useHostSession).mockReturnValue({ sessionId: 'session-a', hostId: 'device-a', status: 'connected' });
    directoryState = {
      path: '~',
      entries: [],
      loading: true,
      ready: false,
      error: null,
      request: null,
      navigate: jest.fn(),
      refresh: jest.fn(),
      capture: jest.fn(),
      isCurrent: jest.fn(() => true),
      cancel: jest.fn(),
    };
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
  });

  it('renders shared explorer skeleton rows before the first listing resolves', () => {
    render();
    expect(list().props.data).toEqual(['0', '1', '2', '3']);
    expect(list().props.renderItem({ item: '0', index: 0 }).type).toBe(SelectionRowSkeleton);
  });

  it('renders cached entries once the folder is ready', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [file],
      loading: false,
      ready: true,
      error: null,
    });
    render();
    expect(list().props.data).toEqual([file]);
  });

  it('preserves the last resolved folder while a same-path refresh is pending', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [file],
      loading: false,
      ready: true,
      error: null,
    });
    render();
    updateDirectory({
      path: '~/Projects',
      entries: [],
      loading: true,
      ready: false,
      error: null,
    });
    expect(list().props.data).toEqual([file]);
    expect(renderer.root.findAllByType(SelectionRowSkeleton)).toHaveLength(0);
  });

  it('shows the empty state once a ready folder resolves to no entries', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [],
      loading: false,
      ready: true,
      error: null,
    });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'This folder is empty.')).toBe(true);
  });

  it('surfaces read errors without a loading spinner', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [],
      loading: false,
      ready: false,
      error: 'Permission denied',
    });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Permission denied')).toBe(true);
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Try again')).toBe(true);
    expect(list().props.data).toEqual([]);
  });
});
