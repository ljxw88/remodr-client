import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router } from 'expo-router';

import AgentsScreen from '@/app/(tabs)/index';
import { ThemedText } from '@/components/themed-text';
import { EMPTY_RUNTIME, remoteAgentSchema } from '@/domain/herdr';
import type { HerdrRepositoryState } from '@/services/herdr-repository';
import { herdrRepository } from '@/services/herdr-repository';
import { AgentWorkspaceList } from './agent-workspace-list';
import { LiquidGlassButton } from './liquid-glass-button';
import { beginNewSpaceFlow } from './creation-flow';

let mockState: HerdrRepositoryState;
let mockFocusEffect: (() => void | (() => void)) | undefined;
let mockForeground = true;

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => { mockFocusEffect = effect; },
}));
jest.mock('@/components/ui/screen', () => ({ Screen: ({ children }: { children: import('react').ReactNode }) => children }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/liquid-glass-rim', () => ({ LiquidGlassRim: () => null }));
jest.mock('./liquid-glass-button', () => ({ LiquidGlassButton: () => null }));
jest.mock('./header-round-button', () => ({ HeaderRoundButton: () => null }));
jest.mock('./agent-workspace-list', () => ({ AgentWorkspaceList: () => null }));
jest.mock('./use-herdr', () => ({ useHerdr: () => mockState }));
jest.mock('./workspace-selection', () => ({ useWorkspaceSelection: () => null, selectWorkspace: jest.fn() }));
jest.mock('./connect-runtime', () => ({ connectAgentRuntime: jest.fn() }));
jest.mock('./creation-flow', () => ({ beginNewAgentFlow: jest.fn(), beginNewSpaceFlow: jest.fn(() => 'space-flow') }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: () => ({ hosts: [{ id: 'server-a', name: 'Development' }], loading: false }) }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: () => null }));
jest.mock('@/features/connection/connection-status', () => ({ ConnectionStatus: () => null }));
jest.mock('@/features/connection/use-connection', () => ({ useForeground: () => mockForeground }));
jest.mock('@/features/navigation/floating-dock', () => ({ useDockScrollHandler: () => jest.fn(), useDockContentInset: () => 100 }));
jest.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ agentFiltersExpanded: true, setAgentFiltersExpanded: jest.fn() }),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { selectDevice: jest.fn(), closeSpace: jest.fn(), refreshRuntime: jest.fn(async () => {}) },
}));
jest.mock('@/services/herdr-bridge-transport', () => ({ HerdrBridgeRequestError: class extends Error {} }));

describe('New Space entry point', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.clearAllMocks();
    mockForeground = true;
    mockFocusEffect = undefined;
    const runtime = { ...EMPTY_RUNTIME, workspaces: [], agents: [] };
    mockState = {
      selectedDeviceId: 'server-a', connection: 'connected', runtime,
      devices: { 'server-a': { deviceId: 'server-a', connection: 'connected', runtime, hello: null, lastError: null } },
      hello: null, lastError: null, lastSemanticEvent: null, agentCountsByDevice: {},
    };
  });
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  function render() {
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AgentsScreen)); });
  }

  function spaceAction() {
    return renderer.root.findAllByProps({ accessibilityRole: 'button' })
      .find((node) => node.findAllByType(ThemedText).some((text) => text.props.children === '+ New Space'));
  }

  it('updates rendered workspace order when new output arrives', () => {
    const agents = ['a', 'b'].map((id, index) => remoteAgentSchema.parse({
      id, paneId: id, provider: 'copilot', workspaceId: id, workspaceName: id,
      herdrSessionId: 'default', title: id, focused: false, status: 'idle',
      capabilities: {}, lastOutputAt: index + 1,
    }));
    mockState.runtime = {
      ...EMPTY_RUNTIME, agents, workspaces: [
        { id: 'a', name: 'A', status: 'idle' }, { id: 'b', name: 'B', status: 'idle' },
      ],
    };
    render();
    expect(renderer.root.findByType(AgentWorkspaceList).props.sections[0].space.id).toBe('b');
    mockState.runtime = { ...mockState.runtime, agents: [{ ...agents[0], lastOutputAt: 3 }, agents[1]] };
    TestRenderer.act(() => renderer.update(createElement(AgentsScreen)));
    expect(renderer.root.findByType(AgentWorkspaceList).props.sections[0].agents[0].id).toBe('a');
  });

  it('polls the focused owning device and stops activity work when backgrounded', async () => {
    jest.useFakeTimers();
    let stop: void | (() => void);
    try {
      render();
      await TestRenderer.act(async () => { stop = mockFocusEffect?.(); });
      expect(herdrRepository.refreshRuntime).toHaveBeenCalledWith('server-a', true);
      if (typeof stop === 'function') stop();
      mockForeground = false;
      TestRenderer.act(() => renderer.update(createElement(AgentsScreen)));
      expect(mockFocusEffect?.()).toBeUndefined();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(herdrRepository.refreshRuntime).toHaveBeenCalledTimes(1);
    } finally {
      if (typeof stop === 'function') stop();
      jest.useRealTimers();
    }
  });

  it('keeps the original glass header in single-agent mode', () => {
    render();
    const header = renderer.root.findByType(LiquidGlassButton);
    expect(header.props.spaceLabel).toBeUndefined();
    expect(header.props.onPressSpace).toBeUndefined();
    expect(header.props.disabled).toBe(true);
  });

  it('offers creation in Spaces even before the first space exists', () => {
    render();
    const action = spaceAction();
    expect(action).toBeDefined();
    expect(action?.props.disabled).toBe(false);
    TestRenderer.act(() => action?.props.onPress());
    expect(beginNewSpaceFlow).toHaveBeenCalledWith('server-a');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/flows/new-space', params: { flowId: 'space-flow' } });
  });

  it('disables creation for a disconnected device with cached spaces', () => {
    mockState.connection = 'reconnecting';
    mockState.devices['server-a'].connection = 'reconnecting';
    mockState.runtime.workspaces = [{ id: 'space-a', name: 'Project', status: 'idle' }];
    render();
    expect(spaceAction()?.props.disabled).toBe(true);
    TestRenderer.act(() => spaceAction()?.props.onPress());
    expect(beginNewSpaceFlow).not.toHaveBeenCalled();
  });
});
