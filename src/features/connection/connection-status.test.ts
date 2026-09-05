import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { AppState, Modal, PermissionsAndroid, Platform, StyleSheet } from 'react-native';
import { router, useIsFocused } from 'expo-router';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import {
  CommandDelivery,
  ConnectionStatus,
  ConnectionDetails,
  getConnectionStatus,
  getDeliveryStatus,
  UNCERTAIN_DELIVERY_COPY,
} from './connection-status';
import { useConnectionLifecycle } from './use-connection-lifecycle';
import type { ConnectionSnapshot } from './connection-supervisor';
import { connectionSupervisor, retryDeviceConnection, startConnectionRuntime, stopConnectionRuntime } from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';
import { getRemoteCoreNativeModule } from '@/services/native-remote-client';
import { HumanRequestBar } from '@/features/agents/human-request-bar';
import { useConnectionSnapshot, useForeground, usePendingCommands } from './use-connection';
import type { HumanRequest } from '@/domain/herdr';
import { Spacing } from '@/constants/theme';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useIsFocused: jest.fn(() => true),
}));
jest.mock('@/features/agents/connect-runtime', () => ({
  connectionSupervisor: {
    setEnvironment: jest.fn(),
    checkHealth: jest.fn().mockResolvedValue(undefined),
    networkChanged: jest.fn(),
    getSnapshot: jest.fn(() => ({ 'device-1': { phase: 'connected' } })),
    subscribe: jest.fn(() => jest.fn()),
  },
  startConnectionRuntime: jest.fn().mockResolvedValue(undefined),
  stopConnectionRuntime: jest.fn(),
  retryDeviceConnection: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/features/connection/use-connection', () => ({
  useConnectionSnapshot: jest.fn(),
  useForeground: jest.fn(() => true),
  usePendingCommands: jest.fn(() => []),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 20 }),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    getSnapshot: jest.fn(() => ({ devices: {} })),
    getPendingCommands: jest.fn(() => []),
    subscribe: jest.fn(() => jest.fn()),
    subscribeCommands: jest.fn(() => jest.fn()),
    retryCommand: jest.fn().mockResolvedValue(undefined),
    discardCommand: jest.fn().mockResolvedValue(undefined),
    answerHumanRequest: jest.fn().mockResolvedValue(undefined),
    loadConversation: jest.fn(),
  },
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({
  GlassSurface: ({ children }: { children: unknown }) => children,
  glassRim: () => ({}),
}));
jest.mock('@/services/native-remote-client', () => ({
  getRemoteCoreNativeModule: jest.fn(),
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(),
  },
}));

const disconnected: ConnectionSnapshot = {
  phase: 'reconnecting',
  disconnectedAt: 1_000,
  attempt: 1,
  nextRetryAt: null,
  lastError: null,
  errorCode: null,
};

describe('connection status', () => {
  it.each([0, 1, 9_999])('hides an idle disconnect at %d ms', (duration) => {
    expect(getConnectionStatus(disconnected, 1_000 + duration).kind).toBe('hidden');
  });

  it.each([10_000, 39_999])('uses small accessible status at %d ms', (duration) => {
    expect(getConnectionStatus(disconnected, 1_000 + duration)).toEqual({
      kind: 'small', text: 'Reconnecting…', reconnect: false,
    });
  });

  it.each([40_000, 119_999])('uses a non-guaranteeing banner at %d ms', (duration) => {
    expect(getConnectionStatus(disconnected, 1_000 + duration)).toEqual({
      kind: 'banner', text: 'Reconnecting… remote work may still be running', reconnect: false,
    });
  });

  it('promotes the reconnect indicator after two minutes', () => {
    expect(getConnectionStatus(disconnected, 121_000).reconnect).toBe(true);
  });

  it('shows queued messages immediately and retains them when connected', () => {
    expect(getConnectionStatus(disconnected, 1_001, 2)).toEqual({
      kind: 'small', text: '◷ 2 queued', reconnect: false,
    });
    expect(getConnectionStatus({ ...disconnected, phase: 'connected' }, 200_000, 1).text)
      .toBe('◷ 1 queued');
  });

  it('does not resurrect an old disconnect banner after recovery', () => {
    expect(getConnectionStatus({ ...disconnected, phase: 'connected' }, 200_000).kind).toBe('hidden');
  });

  it.each([
    ['ERR_AUTHENTICATION', 'Sign in'],
    ['ERR_HOST_KEY_UNKNOWN', 'Verify'],
    ['ERR_HOST_KEY_MISMATCH', 'identity changed'],
  ])('makes %s actionable immediately, never an endless retry', (errorCode, text) => {
    const result = getConnectionStatus({ ...disconnected, phase: 'fatal', errorCode }, 1_001);
    expect(result.kind).toBe('fatal');
    expect(result.text).toContain(text);
    expect(result.reconnect).toBe(false);
  });

  it('uses an explicit waiting-network label', () => {
    expect(getConnectionStatus({ ...disconnected, phase: 'waiting_network' }, 11_000).text)
      .toBe('Waiting for a network…');
  });

  it('keeps uncertain delivery distinct from queued and acknowledged delivery', () => {
    expect(getDeliveryStatus('uncertain')).toEqual({
      label: 'Delivery uncertain', detail: UNCERTAIN_DELIVERY_COPY,
    });
    expect(getDeliveryStatus('queued')?.label).toBe('◷ Queued');
    expect(getDeliveryStatus('sent')?.label).toBe('Sent');
    expect(getDeliveryStatus()).toBeNull();
  });
});

describe('connection overlay and server details', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  const outage = { ...disconnected, disconnectedAt: Date.now() - 150_000 };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(useIsFocused).mockReturnValue(true);
    jest.mocked(useForeground).mockReturnValue(true);
    jest.mocked(useConnectionSnapshot).mockReturnValue(outage);
    jest.mocked(usePendingCommands).mockReturnValue([]);
    jest.mocked(retryDeviceConnection).mockResolvedValue(false);
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  async function mount(deviceId = 'device-1') {
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(ConnectionStatus, { deviceId, bottomInset: 120 }));
    });
  }

  async function press(label: string) {
    await TestRenderer.act(async () => {
      renderer.root.findAll((node) => node.props.accessibilityLabel === label)[0].props.onPress();
    });
  }

  it('keeps retry out of page layout and opens server details without a sheet', async () => {
    await mount();
    const overlay = renderer.root.findAllByProps({ testID: 'connection-status-overlay' })[0];
    expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({
      position: 'absolute', bottom: 120 + Spacing.one,
    });
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    await press('Open connection details');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/hosts/[id]', params: { id: 'device-1' } });
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    await press('Reconnect now');
    expect(retryDeviceConnection).toHaveBeenCalledWith('device-1');
  });

  it('deduplicates retry taps without opening a blocking modal', async () => {
    let finish!: (value: boolean) => void;
    jest.mocked(retryDeviceConnection).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount();
    const retry = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Reconnect now')[0];
    await TestRenderer.act(async () => {
      retry.props.onPress();
      retry.props.onPress();
    });
    expect(retryDeviceConnection).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    jest.mocked(useConnectionSnapshot).mockReturnValue({ ...outage, attempt: 4 });
    await TestRenderer.act(async () => {
      renderer.update(createElement(ConnectionStatus, { deviceId: 'device-1', bottomInset: 120 }));
      finish(false);
    });
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('removes the overlay when automatic recovery succeeds', async () => {
    await mount();
    jest.mocked(useConnectionSnapshot).mockReturnValue({
      ...outage, phase: 'connected', disconnectedAt: null,
    });
    await TestRenderer.act(async () => {
      renderer.update(createElement(ConnectionStatus, { deviceId: 'device-1', bottomInset: 120 }));
    });
    expect(renderer.toJSON()).toBeNull();
    expect(retryDeviceConnection).not.toHaveBeenCalled();
  });

  it('keeps a failed retry inline in the floating control', async () => {
    jest.mocked(retryDeviceConnection).mockRejectedValueOnce(new Error('Retry could not start'));
    await mount();
    await press('Reconnect now');
    expect(JSON.stringify(renderer.toJSON())).toContain('Retry could not start');
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('cannot apply an old device retry result to a newly selected device', async () => {
    let fail!: (error: Error) => void;
    jest.mocked(retryDeviceConnection).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    await mount('device-1');
    await press('Reconnect now');
    await TestRenderer.act(async () => {
      renderer.update(createElement(ConnectionStatus, { deviceId: 'device-2', bottomInset: 120 }));
    });
    await TestRenderer.act(async () => fail(new Error('Old device error')));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Old device error');
    const retry = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Reconnect now')[0];
    expect(retry.props.disabled).toBe(false);
  });

  it('routes fatal failures to server settings without offering a blind retry', async () => {
    jest.mocked(useConnectionSnapshot).mockReturnValue({
      ...outage, phase: 'fatal', errorCode: 'ERR_AUTHENTICATION',
    });
    await mount();
    await press('Open connection details');
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Reconnect now')).toHaveLength(0);
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/hosts/[id]', params: { id: 'device-1' } });
  });

  it.each(['unfocused', 'background'])('hides the overlay when %s', async (reason) => {
    await mount();
    if (reason === 'unfocused') jest.mocked(useIsFocused).mockReturnValue(false);
    else jest.mocked(useForeground).mockReturnValue(false);
    await TestRenderer.act(async () => {
      renderer.update(createElement(ConnectionStatus, { deviceId: 'device-1', bottomInset: 120 }));
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('shows agent connection details on the owning server page', async () => {
    jest.mocked(useConnectionSnapshot).mockReturnValue({ ...outage, lastError: 'Network unavailable' });
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(ConnectionDetails, { deviceId: 'device-2' }));
    });
    expect(useConnectionSnapshot).toHaveBeenCalledWith('device-2');
    expect(JSON.stringify(renderer.toJSON())).toContain('Network unavailable');
    await press('Reconnect now');
    expect(retryDeviceConnection).toHaveBeenCalledWith('device-2');
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
  });
});

describe('command controls', () => {
  it.each(['sent', 'failed'] as const)('allows discarding a previous-session %s entry without offering retry', async (delivery) => {
    jest.mocked(herdrRepository.discardCommand).mockClear();
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(CommandDelivery, {
        commandId: 'previous-command', delivery, previousSession: true,
      }));
    });
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Retry the same message')).toHaveLength(0);
    const discard = renderer.root.findAll((node) => node.props.accessibilityRole === 'button')
      .find((node) => node.props.onPress);
    expect(discard).toBeDefined();
    await TestRenderer.act(async () => discard!.props.onPress());
    expect(herdrRepository.discardCommand).toHaveBeenCalledWith('previous-command');
    TestRenderer.act(() => renderer.unmount());
  });

  it('guards duplicate retries synchronously and reuses the existing command ID', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.retryCommand).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(CommandDelivery, {
        commandId: 'existing-command', delivery: 'failed',
      }));
    });
    const retry = renderer.root.findAll((node) =>
      node.props.accessibilityLabel === 'Retry the same message',
    )[0];
    await TestRenderer.act(async () => {
      retry.props.onPress();
      retry.props.onPress();
    });
    expect(herdrRepository.retryCommand).toHaveBeenCalledTimes(1);
    expect(herdrRepository.retryCommand).toHaveBeenCalledWith('existing-command');
    await TestRenderer.act(async () => { finish(); });
    TestRenderer.act(() => renderer.unmount());
  });

  it('requires reviewing uncertain delivery rather than offering a blind retry', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(CommandDelivery, {
        commandId: 'uncertain-command', delivery: 'uncertain',
      }));
    });
    expect(renderer.root.findAll((node) =>
      node.props.accessibilityLabel === 'Retry the same message',
    )).toHaveLength(0);
    TestRenderer.act(() => renderer.unmount());
  });
});

describe('queued human answers', () => {
  const session = { provider: 'copilot', paneId: 'pane-a', providerSessionId: 'session-a' };
  const request: HumanRequest = {
    id: 'question-a', kind: 'choice', question: 'Continue?',
    options: [{ id: 'yes', label: 'Yes' }], allowCustomAnswer: true, multiSelect: false,
  };
  const queued = {
    id: 'answer-a', agentId: 'agent-a', action: 'human_request.answer',
    payload: { requestId: 'question-a', precondition: session }, state: 'queued',
  } as ReturnType<typeof herdrRepository.getPendingCommands>[number];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([]);
    jest.mocked(usePendingCommands).mockImplementation(() => herdrRepository.getPendingCommands());
  });

  it('locks a durable answer without claiming delivery or refreshing immediately', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.answerHumanRequest).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    const enqueueGuard = { current: false };
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(HumanRequestBar, {
        agentId: 'agent-a', session, request, enqueueGuard,
      }));
    });
    const option = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Yes')[0];
    await TestRenderer.act(async () => {
      option.props.onPress();
      option.props.onPress();
    });
    expect(enqueueGuard.current).toBe(true);
    expect(herdrRepository.answerHumanRequest).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => {
      jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([queued]);
      finish();
    });
    expect(enqueueGuard.current).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain('ANSWER QUEUED');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('ANSWER SENT');
    expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Yes')[0].props.disabled)
      .toBe(true);
    expect(herdrRepository.loadConversation).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.unmount());
  });

  it('restores the pending question lock and permits only deliberate uncertainty recovery', async () => {
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([
      { ...queued, state: 'uncertain' },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(HumanRequestBar, { agentId: 'agent-a', session, request }));
    });
    const option = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Yes')[0];
    expect(option.props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain(UNCERTAIN_DELIVERY_COPY);
    expect(JSON.stringify(renderer.toJSON())).toContain('Discard answer and choose again');
    TestRenderer.act(() => option.props.onPress());
    expect(herdrRepository.answerHumanRequest).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.unmount());
  });

    it('does not lock a reused question ID because a previous session has a queued answer', async () => {
      jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([
        { ...queued, state: 'sent', payload: { ...queued.payload, precondition: { ...session, providerSessionId: 'old-session' } } },
      ]);
      let renderer!: TestRenderer.ReactTestRenderer;
      await TestRenderer.act(async () => {
        renderer = TestRenderer.create(createElement(HumanRequestBar, { agentId: 'agent-a', session, request }));
      });
      expect(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Yes')[0].props.disabled).toBe(false);
      expect(JSON.stringify(renderer.toJSON())).not.toContain('ANSWER SENT');
      TestRenderer.act(() => renderer.unmount());
    });
});

describe('connection lifecycle', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let network: (state: NetInfoState) => void;
  let appState: (state: string) => void;
  let serviceEvent: (event: { active: boolean; reason?: string }) => void;
  const networkRemove = jest.fn();
  const stateRemove = jest.fn();
  const serviceRemove = jest.fn();
  const setService = jest.fn(async (active: boolean) => active);
  const networkState = (connected: boolean | null, reachable: boolean | null, ip = '192.168.1.2') =>
    ({ type: 'wifi', isConnected: connected, isInternetReachable: reachable, details: { ipAddress: ip } }) as NetInfoState;

  function Probe() {
    useConnectionLifecycle();
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, value: 33 });
    AppState.currentState = 'active';
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
      appState = callback;
      return { remove: stateRemove };
    });
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    jest.mocked(NetInfo.addEventListener).mockImplementation((callback) => {
      network = callback;
      return networkRemove;
    });
    jest.mocked(NetInfo.fetch).mockResolvedValue(networkState(true, false));
    jest.mocked(getRemoteCoreNativeModule).mockReturnValue({
      setConnectionService: setService,
      addListener: jest.fn((_event, callback) => {
        serviceEvent = callback;
        return { remove: serviceRemove };
      }),
    } as unknown as ReturnType<typeof getRemoteCoreNativeModule>);
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([]);
  });

  afterEach(async () => {
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function mount() {
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
  }

  it('gates only on a disconnected interface, debounces changes, and cleans up', async () => {
    await mount();
    expect(startConnectionRuntime).toHaveBeenCalledTimes(1);
    TestRenderer.act(() => {
      network(networkState(true, false));
      jest.advanceTimersByTime(300);
    });
    expect(connectionSupervisor.setEnvironment).toHaveBeenLastCalledWith({
      online: true, foreground: true, backgroundAllowed: false,
    });
    TestRenderer.act(() => {
      network(networkState(null, false, '192.168.1.3'));
      network(networkState(null, false, '192.168.1.4'));
      jest.advanceTimersByTime(299);
    });
    expect(connectionSupervisor.networkChanged).not.toHaveBeenCalled();
    TestRenderer.act(() => jest.advanceTimersByTime(1));
    expect(connectionSupervisor.networkChanged).toHaveBeenCalledTimes(1);
    expect(connectionSupervisor.setEnvironment).toHaveBeenLastCalledWith({
      online: true, foreground: true, backgroundAllowed: false,
    });
    TestRenderer.act(() => {
      network(networkState(false, false));
      jest.advanceTimersByTime(300);
      appState('background');
    });
    expect(connectionSupervisor.setEnvironment).toHaveBeenLastCalledWith({
      online: false, foreground: false, backgroundAllowed: false,
    });
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
    expect(networkRemove).toHaveBeenCalledTimes(1);
    expect(stateRemove).toHaveBeenCalledTimes(1);
    expect(serviceRemove).toHaveBeenCalledTimes(1);
    expect(stopConnectionRuntime).toHaveBeenCalledTimes(1);
    const changes = jest.mocked(connectionSupervisor.networkChanged).mock.calls.length;
    TestRenderer.act(() => jest.runOnlyPendingTimers());
    expect(connectionSupervisor.networkChanged).toHaveBeenCalledTimes(changes);
  });

  it('requires native confirmation for background work despite permission denial', async () => {
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([
      { state: 'queued', deviceId: 'device-1' } as ReturnType<typeof herdrRepository.getPendingCommands>[number],
    ]);
    await mount();
    expect(setService).toHaveBeenCalledWith(true, expect.any(String));
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
    TestRenderer.act(() => appState('background'));
    expect(connectionSupervisor.setEnvironment).toHaveBeenLastCalledWith({
      online: true, foreground: false, backgroundAllowed: true,
    });
    setService.mockClear();
    TestRenderer.act(() => serviceEvent({ active: false, reason: 'timeout' }));
    expect(connectionSupervisor.setEnvironment).toHaveBeenLastCalledWith({
      online: true, foreground: false, backgroundAllowed: false,
    });
    expect(setService).not.toHaveBeenCalled();
    await TestRenderer.act(async () => appState('active'));
    expect(connectionSupervisor.checkHealth).toHaveBeenCalledTimes(1);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
  });

  it('serializes service teardown before a lifecycle remount starts it again', async () => {
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([
      { state: 'queued', deviceId: 'device-1' } as ReturnType<typeof herdrRepository.getPendingCommands>[number],
    ]);
    await mount();
    await TestRenderer.act(async () => {
      renderer?.unmount();
      renderer = TestRenderer.create(createElement(Probe));
    });
    expect(setService.mock.calls.map(([active]) => active)).toEqual([true, false, true]);
    expect(startConnectionRuntime).toHaveBeenCalledTimes(2);
    expect(stopConnectionRuntime).toHaveBeenCalledTimes(1);
    expect(networkRemove).toHaveBeenCalledTimes(1);
  });
});
