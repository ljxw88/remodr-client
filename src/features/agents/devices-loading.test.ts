import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import DevicesPage from '@/app/flows/devices';
import { SelectionRow, SelectionRowSkeleton } from '@/components/ui/form-page';
import { useHerdr } from '@/features/agents/use-herdr';
import { useHosts } from '@/features/hosts/use-hosts';
import { useFlowDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { EMPTY_RUNTIME } from '@/domain/herdr';
import type { NewAgentDraft } from '@/features/forms/flow-drafts';
import type { HerdrRepositoryState } from '@/services/herdr-repository';

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ flowId: 'flow-1' })),
}));
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
jest.mock('@/components/themed-text', () => ({
  ThemedText: ({ children }: { children: import('react').ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      children,
    ),
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));
jest.mock('@/features/agents/use-herdr', () => ({ useHerdr: jest.fn() }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: jest.fn() }));
jest.mock('@/features/forms/flow-drafts', () => ({
  flowDrafts: { update: jest.fn(), get: jest.fn() },
  useFlowDraft: jest.fn(),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn() },
}));

const draft: NewAgentDraft = {
  kind: 'new-agent', deviceId: 'device-a', name: '', workspaceId: '', provider: 'opencode',
  tuning: { model: null, effort: null, context: null }, bypassPermissions: false,
};
const snapshot: HerdrRepositoryState = {
  selectedDeviceId: 'device-a', connection: 'connected', runtime: EMPTY_RUNTIME,
  devices: {
    'device-a': { deviceId: 'device-a', connection: 'connected', runtime: EMPTY_RUNTIME, hello: null, lastError: null },
    'device-b': { deviceId: 'device-b', connection: 'disconnected', runtime: EMPTY_RUNTIME, hello: null, lastError: null },
  },
  agentCountsByDevice: {}, hello: null, lastError: null, lastSemanticEvent: null,
};

describe('device selection loading states', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  function render() {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(DevicesPage));
    });
  }

  function list() {
    return renderer.root.findByType(FlatList);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId: 'flow-1' });
    jest.mocked(useFlowDraft).mockReturnValue(draft);
    jest.mocked(useHerdr).mockReturnValue(snapshot);
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue(snapshot);
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
  });

  it('renders skeleton rows while the host list is still loading', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: true, error: null, reload: jest.fn() });
    render();
    expect(list().props.data).toEqual(['0', '1', '2', '3']);
    expect(list().props.renderItem({ item: '0', index: 0 }).type).toBe(SelectionRowSkeleton);
  });

  it('renders actual selectable rows once hosts are available', () => {
    jest.mocked(useHosts).mockReturnValue({
      hosts: [{ id: 'device-a', name: 'Laptop', username: 'alex', hostname: 'laptop.local' }],
      loading: false,
      error: null,
      reload: jest.fn(),
    });
    render();
    expect(list().props.data).toHaveLength(1);
    expect(list().props.renderItem({ item: { id: 'device-a', name: 'Laptop', username: 'alex', hostname: 'laptop.local' }, index: 0 }).type).toBe(SelectionRow);
  });

  it('keeps cached rows visible during a refresh', () => {
    jest.mocked(useHosts).mockReturnValue({
      hosts: [{ id: 'device-a', name: 'Laptop', username: 'alex', hostname: 'laptop.local' }],
      loading: true,
      error: null,
      reload: jest.fn(),
    });
    render();
    expect(list().props.renderItem({ item: { id: 'device-a', name: 'Laptop', username: 'alex', hostname: 'laptop.local' }, index: 0 }).type).toBe(SelectionRow);
    expect(renderer.root.findAllByType(SelectionRowSkeleton)).toHaveLength(0);
  });

  it('shows the empty state only after loading has settled', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: false, error: null, reload: jest.fn() });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'No saved devices. Add a device before continuing.')).toBe(true);
  });

  it('surfaces list errors and the retry action', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: false, error: 'Permission denied', reload: jest.fn() });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Permission denied')).toBe(true);
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Try again')).toBe(true);
  });
});
