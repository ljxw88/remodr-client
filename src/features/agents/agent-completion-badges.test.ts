import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import AgentsScreen from '@/app/(tabs)/index';
import { FinishDot } from '@/components/ui/finish-dot';
import { EMPTY_RUNTIME, remoteAgentSchema, type RemoteAgent } from '@/domain/herdr';
import type { HerdrRepositoryState } from '@/services/herdr-repository';
import { selectWorkspace } from './workspace-selection';
import { AgentWorkspaceList, AgentWorkspaceSkeleton } from './agent-workspace-list';
import { EmptyState } from '@/components/ui/empty-state';

let mockState: HerdrRepositoryState;
let mockAgentFiltersExpanded = true;
let mockSelectedWorkspaceId: string | null = null;
let mockHostsLoading = false;
let mockHosts = [{ id: 'server-a', name: 'Alpha' }, { id: 'server-b', name: 'Beta' }];

function agent(id: string, workspaceId: string, unread: boolean): RemoteAgent {
  return remoteAgentSchema.parse({
    id, paneId: id, provider: 'copilot', workspaceId, workspaceName: workspaceId,
    herdrSessionId: 'default', title: id, focused: false, status: 'done', capabilities: {},
    completion: unread ? { id: `finish-${id}`, unread: true, statusRevision: 1 } : undefined,
  });
}

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));
jest.mock('@/components/ui/screen', () => ({ Screen: ({ children }: { children: import('react').ReactNode }) => children }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/liquid-glass-rim', () => ({ LiquidGlassRim: () => null }));
jest.mock('./liquid-glass-button', () => ({ LiquidGlassButton: () => null }));
jest.mock('./header-round-button', () => ({ HeaderRoundButton: () => null }));
jest.mock('./agent-workspace-list', () => ({ AgentWorkspaceList: () => null, AgentWorkspaceSkeleton: () => null }));
jest.mock('./use-herdr', () => ({ useHerdr: () => mockState }));
jest.mock('./workspace-selection', () => ({
  useWorkspaceSelection: () => mockSelectedWorkspaceId,
  selectWorkspace: jest.fn((_deviceId: string, spaceId: string | null) => { mockSelectedWorkspaceId = spaceId; }),
}));
jest.mock('./connect-runtime', () => ({ connectAgentRuntime: jest.fn() }));
jest.mock('./creation-flow', () => ({ beginNewAgentFlow: jest.fn(), beginNewSpaceFlow: jest.fn(() => 'space-flow') }));
jest.mock('@/features/hosts/use-hosts', () => ({
  useHosts: () => ({
    hosts: mockHosts,
    loading: mockHostsLoading,
  }),
}));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: () => null }));
jest.mock('@/features/connection/connection-status', () => ({ ConnectionStatus: () => null }));
jest.mock('@/features/connection/use-connection', () => ({ useForeground: () => true }));
jest.mock('@/features/navigation/floating-dock', () => ({ useDockScrollHandler: () => jest.fn(), useDockContentInset: () => 100 }));
jest.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({
    agentFiltersExpanded: mockAgentFiltersExpanded,
    setAgentFiltersExpanded: jest.fn((next: boolean) => { mockAgentFiltersExpanded = next; }),
  }),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { selectDevice: jest.fn(), closeSpace: jest.fn(), refreshRuntime: jest.fn(async () => {}) },
}));
jest.mock('@/services/herdr-bridge-transport', () => ({ HerdrBridgeRequestError: class extends Error {} }));

describe('unread finish aggregation on the agents screen', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentFiltersExpanded = true;
    mockSelectedWorkspaceId = null;
    mockHostsLoading = false;
    mockHosts = [{ id: 'server-a', name: 'Alpha' }, { id: 'server-b', name: 'Beta' }];
    const deviceARuntime = {
      ...EMPTY_RUNTIME,
      deviceId: 'server-a',
      workspaces: [
        { id: 'space-1', name: 'Space One', status: 'idle' as const },
        { id: 'space-2', name: 'Space Two', status: 'idle' as const },
      ],
      agents: [
        agent('a1', 'space-1', true),
        agent('a2', 'space-1', true),
        agent('a3', 'space-2', true),
      ],
    };
    const deviceBRuntime = {
      ...EMPTY_RUNTIME,
      deviceId: 'server-b',
      workspaces: [],
      agents: [agent('b1', 'space-9', true)],
    };
    mockState = {
      selectedDeviceId: 'server-a', connection: 'connected', runtime: deviceARuntime,
      devices: {
        'server-a': { deviceId: 'server-a', connection: 'connected', runtime: deviceARuntime, hello: null, lastError: null },
        'server-b': { deviceId: 'server-b', connection: 'connected', runtime: deviceBRuntime, hello: null, lastError: null },
      },
      hello: null, lastError: null, lastSemanticEvent: null, agentCountsByDevice: {},
    };
  });
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  function render() {
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AgentsScreen)); });
  }

  function dotWithLabel(label: string) {
    return renderer.root.findAllByType(FinishDot).find((node) => node.props.label === label);
  }

  it.each(['starting_bridge', 'synchronizing', 'reconnecting'] as const)(
    'shows matched agent placeholders while an uncached runtime is %s', (connection) => {
      mockState = { ...mockState, connection, runtime: EMPTY_RUNTIME };
      render();
      expect(renderer.root.findAllByType(AgentWorkspaceSkeleton)).toHaveLength(1);
      expect(renderer.root.findAllByType(EmptyState)).toHaveLength(0);
    },
  );

  it('shows initial placeholders immediately, but keeps cached rows while host metadata loads', () => {
    const cached = mockState.runtime;
    mockHostsLoading = true;
    mockHosts = [];
    mockState = { ...mockState, runtime: EMPTY_RUNTIME };
    render();
    expect(renderer.root.findAllByType(AgentWorkspaceSkeleton)).toHaveLength(1);
    mockState = { ...mockState, runtime: cached };
    TestRenderer.act(() => renderer.update(createElement(AgentsScreen)));
    expect(renderer.root.findAllByType(AgentWorkspaceSkeleton)).toHaveLength(0);
    expect(renderer.root.findAllByType(AgentWorkspaceList)).toHaveLength(1);
  });

  it.each(['connected', 'disconnected', 'error'] as const)(
    'does not confuse a terminal %s empty runtime with loading', (connection) => {
      mockState = { ...mockState, connection, runtime: EMPTY_RUNTIME };
      render();
      expect(renderer.root.findAllByType(AgentWorkspaceSkeleton)).toHaveLength(0);
      expect(renderer.root.findAllByType(EmptyState)).toHaveLength(1);
    },
  );

  it('keeps a received empty snapshot distinct from an uncached reconnect', () => {
    mockState = { ...mockState, connection: 'reconnecting', runtime: { ...EMPTY_RUNTIME } };
    render();
    expect(renderer.root.findAllByType(AgentWorkspaceSkeleton)).toHaveLength(0);
    expect(renderer.root.findAllByType(EmptyState)).toHaveLength(1);
  });

  it('shows an All spaces aggregate covering every unread agent on the current device', () => {
    render();
    expect(dotWithLabel('3 unread finished agents in All spaces')?.props.count).toBe(3);
  });

  it('aggregates each space filter chip independently, unaffected by the other space', () => {
    render();
    expect(dotWithLabel('2 unread finished agents in Space One')?.props.count).toBe(2);
    expect(dotWithLabel('1 unread finished agent in Space Two')?.props.count).toBe(1);
  });

  it('aggregates each device chip from that device alone, including a device that is not selected', () => {
    render();
    expect(dotWithLabel('3 unread finished agents in Alpha')?.props.count).toBe(3);
    expect(dotWithLabel('1 unread finished agent in Beta')?.props.count).toBe(1);
  });

  it('selecting a different space does not acknowledge anything: every count is unchanged', () => {
    render();
    TestRenderer.act(() => { selectWorkspace('server-a', 'space-1'); });
    mockSelectedWorkspaceId = 'space-1';
    TestRenderer.act(() => renderer.update(createElement(AgentsScreen)));
    expect(dotWithLabel('3 unread finished agents in All spaces')?.props.count).toBe(3);
    expect(dotWithLabel('2 unread finished agents in Space One')?.props.count).toBe(2);
    expect(dotWithLabel('1 unread finished agent in Space Two')?.props.count).toBe(1);
  });

  it('surfaces a header aggregate across all devices only while the filters are collapsed', () => {
    render();
    expect(renderer.root.findAllByType(FinishDot).some((node) => node.props.label?.includes('across your devices'))).toBe(false);
    mockAgentFiltersExpanded = false;
    TestRenderer.act(() => renderer.update(createElement(AgentsScreen)));
    expect(dotWithLabel('4 unread finished agents across your devices')?.props.count).toBe(4);
  });

  it('clearing one agent’s receipt lowers its space and device totals without touching the others', () => {
    mockState.runtime = {
      ...mockState.runtime,
      agents: [agent('a1', 'space-1', false), agent('a2', 'space-1', true), agent('a3', 'space-2', true)],
    };
    mockState.devices['server-a'] = { ...mockState.devices['server-a'], runtime: mockState.runtime };
    render();
    expect(dotWithLabel('1 unread finished agent in Space One')?.props.count).toBe(1);
    expect(dotWithLabel('1 unread finished agent in Space Two')?.props.count).toBe(1);
    expect(dotWithLabel('2 unread finished agents in All spaces')?.props.count).toBe(2);
    expect(dotWithLabel('1 unread finished agent in Beta')?.props.count).toBe(1);
  });
});
