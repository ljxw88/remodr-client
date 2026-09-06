import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import DiagnosticsScreen from './index';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

jest.mock('@/components/ui/screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => children,
}));

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    backgroundElement: '#141519',
    border: '#252830',
    success: '#5BE49B',
    warning: '#FFC65C',
    textMuted: '#A2A8B6',
    danger: '#FF716B',
  }),
}));

jest.mock('@/features/agents/use-herdr', () => ({
  useHerdr: () => ({
    selectedDeviceId: null,
    devices: {
      'server-1': {
        connection: 'connected',
        lastError: null,
        hello: null,
        runtime: { agents: [] },
      },
      'server-2': {
        connection: 'disconnected',
        lastError: 'Connection lost: reset by peer',
        hello: null,
        runtime: { agents: [] },
      },
    },
  }),
}));

jest.mock('@/services/native-remote-client', () => ({
  remoteClient: {
    getSession: jest.fn((hostId: string) => {
      if (hostId === 'server-1') return { sessionId: 's-1', status: 'connected' };
      if (hostId === 'server-2') return { sessionId: 's-2', status: 'disconnected' };
      return null;
    }),
    listSessions: jest.fn(() => [{ sessionId: 's-1', status: 'connected' }]),
    exec: jest.fn(),
  },
}));

describe('DiagnosticsScreen multi-server status', () => {
  const mockHosts = [
    {
      id: 'server-1',
      name: 'GPU Server',
      hostname: '192.168.1.50',
      port: 22,
      username: 'ubuntu',
      auth: { type: 'password' as const, password: 'pw' },
    },
    {
      id: 'server-2',
      name: 'Build Node',
      hostname: '192.168.1.60',
      port: 2222,
      username: 'developer',
      auth: { type: 'password' as const, password: 'pw' },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(hostRepository, 'list').mockResolvedValue(mockHosts);
  });

  it('reports degraded status when one of multiple servers loses connection', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(DiagnosticsScreen));
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as any);
    const allText = textNodes.map((n) => n.props.children).flat().join(' ');

    expect(allText).toContain('Degraded (1/2 connected)');
    expect(allText).toContain('GPU Server');
    expect(allText).toContain('Build Node');
    expect(allText).toContain('Connection lost: reset by peer');

    TestRenderer.act(() => renderer.unmount());
  });

  it('reports all connected when every server session is active', async () => {
    jest.mocked(remoteClient.getSession).mockReturnValue({ sessionId: 's-all', status: 'connected' });

    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(DiagnosticsScreen));
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as any);
    const allText = textNodes.map((n) => n.props.children).flat().join(' ');

    expect(allText).toContain('All connected (2/2)');

    TestRenderer.act(() => renderer.unmount());
  });
});
