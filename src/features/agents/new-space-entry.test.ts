import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router } from 'expo-router';

import AgentsScreen from '@/app/(tabs)/index';
import { ThemedText } from '@/components/themed-text';
import { EMPTY_RUNTIME } from '@/domain/herdr';
import type { HerdrRepositoryState } from '@/services/herdr-repository';
import { LiquidGlassButton } from './liquid-glass-button';
import { beginNewSpaceFlow } from './creation-flow';

let mockState: HerdrRepositoryState;

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/ui/screen', () => ({ Screen: ({ children }: { children: import('react').ReactNode }) => children }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/liquid-glass-rim', () => ({ LiquidGlassRim: () => null }));
jest.mock('./liquid-glass-button', () => ({ LiquidGlassButton: () => null }));
jest.mock('./header-round-button', () => ({ HeaderRoundButton: () => null }));
jest.mock('./use-herdr', () => ({ useHerdr: () => mockState }));
jest.mock('./workspace-selection', () => ({ useWorkspaceSelection: () => null, selectWorkspace: jest.fn() }));
jest.mock('./connect-runtime', () => ({ connectAgentRuntime: jest.fn() }));
jest.mock('./creation-flow', () => ({ beginNewAgentFlow: jest.fn(), beginNewSpaceFlow: jest.fn(() => 'space-flow') }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: () => ({ hosts: [{ id: 'server-a', name: 'Development' }], loading: false }) }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: () => null }));
jest.mock('@/features/connection/connection-status', () => ({ ConnectionStatus: () => null }));
jest.mock('@/features/navigation/floating-dock', () => ({ useDockScrollHandler: () => jest.fn(), useDockContentInset: () => 100 }));
jest.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ agentFiltersExpanded: true, setAgentFiltersExpanded: jest.fn() }),
}));
jest.mock('@/services/herdr-repository', () => ({ herdrRepository: { selectDevice: jest.fn(), closeSpace: jest.fn() } }));
jest.mock('@/services/herdr-bridge-transport', () => ({ HerdrBridgeRequestError: class extends Error {} }));

describe('New Space entry point', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.clearAllMocks();
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
