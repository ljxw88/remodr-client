import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, Text, TextInput } from 'react-native';

import HostsScreen from '@/app/(tabs)/servers';
import { HostRow, HostRowSkeleton } from '@/features/hosts/HostRow';
import { useHosts } from '@/features/hosts/use-hosts';
import { useHostSession } from '@/features/connection/use-host-session';

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { push: jest.fn() },
}));
jest.mock('@/components/ui/screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/components/ui/scroll-edge-frame', () => ({
  ScrollEdgeFrame: ({ children }: { children: (edge: Record<string, never>) => import('react').ReactNode }) =>
    children({}),
}));
jest.mock('@/components/ui/glass-surface', () => ({
  GlassSurface: ({ children }: { children: import('react').ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').View,
      null,
      children,
    ),
}));
jest.mock('@/components/ui/empty-state', () => ({
  EmptyState: ({ message }: { message: string }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      message,
    ),
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/marquee-text', () => ({
  MarqueeText: ({ children }: { children: import('react').ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement(
      jest.requireActual<typeof import('react-native')>('react-native').Text,
      null,
      children,
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
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: jest.fn() }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: jest.fn() }));
jest.mock('@/features/navigation/floating-dock', () => ({
  useDockContentInset: () => 24,
  useDockScrollHandler: () => jest.fn(),
}));

const host = {
  id: 'server-a',
  name: 'Development',
  hostname: 'dev.example.com',
  username: 'user',
  port: 22,
  authType: 'password',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('servers screen loading states', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  function render() {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(HostsScreen));
    });
  }

  function list() {
    return renderer.root.findByType(FlatList);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(useHostSession).mockReturnValue({ sessionId: 'ssh-1', hostId: host.id, status: 'connected' });
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
  });

  it('shows stable search controls and skeleton cards while the initial list is loading', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: true, error: null, reload: jest.fn() });
    render();
    expect(renderer.root.findAllByType(TextInput)).toHaveLength(1);
    expect(list().props.data).toEqual(['0', '1', '2', '3', '4']);
    expect(list().props.renderItem({ item: '0', index: 0 }).type).toBe(HostRowSkeleton);
  });

  it('renders the live list once host data exists, even if a refresh is still pending', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [host], loading: true, error: null, reload: jest.fn() });
    render();
    expect(list().props.data).toEqual([host]);
    expect(list().props.renderItem({ item: host, index: 0 }).type).toBe(HostRow);
    expect(renderer.root.findAllByType(HostRowSkeleton)).toHaveLength(0);
  });

  it('keeps known hosts visible when their background refresh fails', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [host], loading: false, error: 'Refresh failed', reload: jest.fn() });
    render();
    expect(list().props.data).toEqual([host]);
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Refresh failed')).toBe(true);
    expect(renderer.root.findAllByType(HostRowSkeleton)).toHaveLength(0);
  });

  it('shows the empty state only after the list has settled', () => {
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: false, error: null, reload: jest.fn() });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'No servers')).toBe(true);
    expect(renderer.root.findAllByType(FlatList)).toHaveLength(0);
  });

  it('surfaces loading failures without hiding the retry control', () => {
    const reload = jest.fn();
    jest.mocked(useHosts).mockReturnValue({ hosts: [], loading: false, error: 'Network unavailable', reload });
    render();
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Network unavailable')).toBe(true);
    expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Try again')).toBe(true);
  });
});
