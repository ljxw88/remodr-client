import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import FoldersPage from '@/app/flows/folders';
import { SelectionRow, SelectionRowSkeleton } from '@/components/ui/form-page';
import { useRemoteDirectory } from '@/features/files/use-remote-directory';
import { useFlowDraft } from '@/features/forms/flow-drafts';
import { useHerdr } from '@/features/agents/use-herdr';
import { useHosts } from '@/features/hosts/use-hosts';
import { useHostSession } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { EMPTY_RUNTIME } from '@/domain/herdr';
import type { NewSpaceDraft } from '@/features/forms/flow-drafts';
import type { HerdrRepositoryState } from '@/services/herdr-repository';

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    router: { back: jest.fn() },
    useLocalSearchParams: jest.fn(() => ({ flowId: 'flow-1' })),
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual<typeof import('@/components/ui/form-page')>('@/components/ui/form-page'),
    FormPage: ({ children }: { children: import('react').ReactNode }) => React.createElement(React.Fragment, null, children),
    FormSection: ({ children }: { children: import('react').ReactNode }) => React.createElement(React.Fragment, null, children),
    MissingFlow: () => null,
  };
});
jest.mock('@/components/ui/app-button', () => ({
  AppButton: ({ label }: { label: string }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      label,
    ),
}));
jest.mock('@/components/ui/text-field', () => ({
  TextField: () => null,
}));
jest.mock('@/components/themed-text', () => ({
  ThemedText: ({ children }: { children: import('react').ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      children,
    ),
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/features/agents/use-herdr', () => ({ useHerdr: jest.fn() }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: jest.fn() }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: jest.fn(), refreshSessions: jest.fn() }));
jest.mock('@/features/forms/flow-drafts', () => ({
  flowDrafts: { update: jest.fn(), get: jest.fn() },
  useFlowDraft: jest.fn(),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn() },
}));
jest.mock('@/features/files/use-remote-directory', () => ({
  useRemoteDirectory: jest.fn(),
}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type DirectoryState = ReturnType<typeof useRemoteDirectory>;

const draft: NewSpaceDraft = { kind: 'new-space', deviceId: 'device-a', label: '', cwd: '~' };
const snapshot: HerdrRepositoryState = {
  selectedDeviceId: 'device-a', connection: 'connected', runtime: EMPTY_RUNTIME,
  devices: { 'device-a': {
    deviceId: 'device-a', connection: 'connected', runtime: EMPTY_RUNTIME, hello: null, lastError: null,
  } },
  agentCountsByDevice: {}, hello: null, lastError: null, lastSemanticEvent: null,
};
const folder = { name: 'Projects', path: '~/Projects', isDirectory: true, size: 0 };

describe('folder picker loading states', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let directoryState: DirectoryState;

  function render() {
    jest.mocked(useRemoteDirectory).mockReturnValue(directoryState);
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FoldersPage));
    });
  }

  function updateDirectory(next: Partial<DirectoryState>) {
    directoryState = { ...directoryState, ...next };
    if (renderer) {
      jest.mocked(useRemoteDirectory).mockReturnValue(directoryState);
      TestRenderer.act(() => {
        renderer.update(createElement(FoldersPage));
      });
    }
  }

  function list() {
    return renderer.root.findByType(FlatList);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId: 'flow-1' });
    jest.mocked(useFlowDraft).mockReturnValue(draft);
    jest.mocked(useHerdr).mockReturnValue(snapshot);
    jest.mocked(useHosts).mockReturnValue({ hosts: [{ id: 'device-a', name: 'Laptop' }], loading: false, error: null, reload: jest.fn() });
    jest.mocked(useHostSession).mockReturnValue({ sessionId: 'session-a', hostId: 'device-a', status: 'connected' });
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue(snapshot);
    directoryState = {
      path: '~',
      entries: [],
      loading: true,
      error: null,
      ready: false,
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

  it('shows selection skeletons during the first folder load', () => {
    render();
    expect(list().props.data).toEqual(['0', '1', '2', '3']);
    expect(list().props.renderItem({ item: '0', index: 0 }).type).toBe(SelectionRowSkeleton);
  });

  it('renders real rows once a folder listing is ready', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [folder],
      loading: false,
      ready: true,
    });
    render();
    expect(list().props.data).toEqual([folder]);
    expect(list().props.renderItem({ item: folder, index: 0 }).type).toBe(SelectionRow);
  });

  it('keeps the current rows visible while refreshing the same folder', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [folder],
      loading: false,
      ready: true,
    });
    render();
    updateDirectory({
      path: '~/Projects',
      entries: [],
      loading: true,
      ready: false,
    });
    expect(list().props.data).toEqual([folder]);
    expect(list().props.renderItem({ item: folder, index: 0 }).type).toBe(SelectionRow);
    expect(renderer.root.findAllByType(SelectionRowSkeleton)).toHaveLength(0);
  });

  it('shows the empty state only after a ready folder resolves with no entries', () => {
    updateDirectory({
      path: '~/Projects',
      entries: [],
      loading: false,
      ready: true,
    });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'No folders here.')).toBe(true);
  });

  it('surfaces directory errors instead of replacing them with placeholders', () => {
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
