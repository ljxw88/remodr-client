import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router, useLocalSearchParams } from 'expo-router';

import NewAgentPage from '@/app/flows/new-agent';
import NewSpacePage from '@/app/flows/new-space';
import FoldersPage from '@/app/flows/folders';
import { AppButton } from '@/components/ui/app-button';
import { FormError, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import type { CreateAgentResult, CreateSpaceResult } from '@/domain/herdr';
import type { RemoteFile, SessionSnapshot } from '@/domain/remote';
import {
  agentCreationError,
  agentCreationInput,
  agentDraftForDevice,
  agentDraftForProvider,
  beginNewAgentFlow,
  beginNewSpaceFlow,
  newAgentDraft,
  spaceDraftForDevice,
} from '@/features/agents/creation-flow';
import { useHerdr } from '@/features/agents/use-herdr';
import { useHostSession } from '@/features/connection/use-host-session';
import { flowDrafts, type NewAgentDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { herdrRepository, type DeviceRuntimeState, type HerdrRepositoryState } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';

jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: jest.fn(),
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
    router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() },
  };
});
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ...jest.requireActual('@/components/ui/form-page'),
    FormPage: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) =>
      React.createElement(View, null, children, footer),
    MissingFlow: () => React.createElement(View, { testID: 'missing-flow' }),
  };
});
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/features/agents/tuning-fields', () => ({ TuningFields: () => null }));
jest.mock('@/features/agents/use-herdr', () => ({ useHerdr: jest.fn() }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: jest.fn(), refreshSessions: jest.fn() }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: () => ({ hosts: [], loading: false, error: null, reload: jest.fn() }) }));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn(), createAgent: jest.fn(), createSpace: jest.fn() },
}));
jest.mock('@/services/native-remote-client', () => ({
  remoteClient: { getSession: jest.fn(), sftpList: jest.fn() },
}));

function device(deviceId = 'device-a'): DeviceRuntimeState {
  return {
    deviceId, connection: 'connected', hello: null, lastError: null,
    runtime: {
      connectionState: 'connected', deviceId,
      providers: [{ provider: 'copilot', available: true, aliases: [] }, { provider: 'codex', available: true, aliases: [] }],
      workspaces: [{ id: 'space-1', name: 'One', status: 'idle' }, { id: 'space-2', name: 'Two', status: 'idle' }],
      agents: [],
    },
  };
}

function repositoryState(owner: DeviceRuntimeState): HerdrRepositoryState {
  return {
    selectedDeviceId: 'another-device', connection: 'connected', runtime: device('another-device').runtime,
    devices: { [owner.deviceId]: owner }, agentCountsByDevice: {}, hello: null, lastError: null, lastSemanticEvent: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('creation drafts', () => {
  it('starts with the requested owning space, CLI defaults, optional name, and existing permission default', () => {
    expect(newAgentDraft(device(), 'space-2')).toEqual({
      kind: 'new-agent', deviceId: 'device-a', name: '', workspaceId: 'space-2', provider: 'copilot',
      tuning: { model: null, effort: null, context: null }, bypassPermissions: true,
    });
    expect(newAgentDraft(device(), 'deleted-space').workspaceId).toBe('space-1');
  });

  it('chooses the first available provider and never a foreign-device space', () => {
    const owner = device();
    owner.runtime.providers[0].available = false;
    owner.runtime.workspaces[0].deviceId = 'different-device';
    expect(newAgentDraft(owner, 'space-1')).toMatchObject({ provider: 'codex', workspaceId: 'space-2' });
  });

  it('reports invalid defaults instead of quietly submitting when no providers or spaces exist', () => {
    const owner = device();
    owner.runtime.workspaces = [];
    expect(agentCreationError(newAgentDraft(owner), owner)).toContain('Choose an available space');
    owner.runtime.workspaces = device().runtime.workspaces;
    owner.runtime.providers = [];
    expect(agentCreationError(newAgentDraft(owner), owner)).toContain('provider is unavailable');
  });

  it('starts stored flows without backend mutations', () => {
    const agentId = beginNewAgentFlow(device(), 'space-2');
    const spaceId = beginNewSpaceFlow('device-b');
    expect(flowDrafts.get(agentId)).toMatchObject({ kind: 'new-agent', deviceId: 'device-a', workspaceId: 'space-2' });
    expect(flowDrafts.get(spaceId)).toEqual({ kind: 'new-space', deviceId: 'device-b', label: '', cwd: '~/' });
    expect(herdrRepository.createAgent).not.toHaveBeenCalled();
    expect(herdrRepository.createSpace).not.toHaveBeenCalled();
    flowDrafts.discard(agentId);
    flowDrafts.discard(spaceId);
  });

  it('resets tuning on provider changes but preserves explicit choices when reselecting the same provider', () => {
    const draft: NewAgentDraft = {
      ...newAgentDraft(device()), name: 'Investigate', bypassPermissions: false,
      tuning: { model: 'future-model', effort: 'max', context: 'long_context' },
    };
    expect(agentDraftForProvider(draft, 'copilot')).toBe(draft);
    expect(agentDraftForProvider(draft, 'codex')).toMatchObject({
      name: 'Investigate', bypassPermissions: false, provider: 'codex', tuning: { model: null, effort: null, context: null },
    });
    expect(agentCreationInput(draft)).toMatchObject({ model: 'future-model', effort: 'max', context: 'long_context' });
  });

  it('resets account-specific tuning and workspace ownership when changing devices, preserving name and permissions', () => {
    const draft: NewAgentDraft = {
      ...newAgentDraft(device(), 'space-2'), name: 'My work', bypassPermissions: false,
      tuning: { model: 'claude-opus-5', effort: 'max', context: 'long_context' },
    };
    const other = device('device-b');
    other.runtime.providers[0].available = false;
    expect(agentDraftForDevice(draft, other)).toMatchObject({
      deviceId: 'device-b', workspaceId: 'space-1', provider: 'codex', name: 'My work', bypassPermissions: false,
      tuning: { model: null, effort: null, context: null },
    });
    expect(agentDraftForDevice(draft, device())).toBe(draft);
  });

  it('never carries a folder path to another server', () => {
    const draft: NewSpaceDraft = { kind: 'new-space', deviceId: 'device-a', cwd: '/secret-project', label: 'Project' };
    expect(spaceDraftForDevice(draft, 'device-a')).toBe(draft);
    expect(spaceDraftForDevice(draft, 'device-b')).toEqual({ ...draft, deviceId: 'device-b', cwd: '~/' });
  });

  it('validates deleted devices, deleted spaces, disconnected owners, unavailable providers, and long names', () => {
    const owner = device();
    const draft = newAgentDraft(owner);
    expect(agentCreationError(draft, undefined)).toContain('device is no longer available');
    expect(agentCreationError(draft, { ...owner, connection: 'reconnecting' })).toContain('not connected');
    expect(agentCreationError({ ...draft, workspaceId: 'deleted' }, owner)).toContain('available space');
    owner.runtime.providers[0] = { provider: 'copilot', available: false, aliases: [], unavailableReason: 'Sign in first' };
    expect(agentCreationError(draft, owner)).toBe('Sign in first');
    expect(agentCreationError({ ...draft, name: 'a'.repeat(61) }, device())).toContain('60 characters');
  });

  it('trims names and omits CLI tuning flags unless explicitly selected', () => {
    expect(agentCreationInput({ ...newAgentDraft(device()), name: '   ' })).toEqual({
      provider: 'copilot', workspaceId: 'space-1', bypassPermissions: true,
      name: undefined, model: undefined, effort: undefined, context: undefined,
    });
    expect(agentCreationInput({ ...newAgentDraft(device()), name: '  Plan  ' }).name).toBe('Plan');
  });
});

describe('creation pages and folder lifetime', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let flowId: string;
  let owner: DeviceRuntimeState;
  let session: SessionSnapshot;

  beforeEach(() => {
    jest.clearAllMocks();
    owner = device();
    session = { hostId: owner.deviceId, sessionId: 'session-a', status: 'connected' };
    jest.mocked(useHerdr).mockReturnValue(repositoryState(owner));
    jest.mocked(herdrRepository.getSnapshot).mockImplementation(() => repositoryState(owner));
    jest.mocked(useHostSession).mockImplementation(() => session);
    jest.mocked(remoteClient.getSession).mockImplementation(() => session);
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    if (flowId) flowDrafts.discard(flowId);
  });

  function render(page: typeof NewAgentPage) {
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(page)); });
  }

  function button(label: string) {
    const found = renderer?.root.findAllByType(AppButton).find((node) => node.props.label === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }

  function field(label: string) {
    const found = renderer?.root.findAllByType(TextField).find((node) => node.props.label === label);
    if (!found) throw new Error(`Missing field: ${label}`);
    return found;
  }

  function updateConnection() {
    jest.mocked(useHerdr).mockReturnValue(repositoryState(owner));
    TestRenderer.act(() => renderer?.update(createElement(FoldersPage)));
  }

  it('keeps editing local, locks inputs during submit, fences double taps, and targets the captured device', async () => {
    flowId = beginNewAgentFlow(owner);
    const result = deferred<CreateAgentResult>();
    jest.mocked(herdrRepository.createAgent).mockReturnValue(result.promise);
    render(NewAgentPage);
    TestRenderer.act(() => field('Name (optional)').props.onChangeText('Draft name'));
    expect(herdrRepository.createAgent).not.toHaveBeenCalled();
    const submit = button('Start agent').props.onPress;
    TestRenderer.act(() => { submit(); submit(); });
    expect(herdrRepository.createAgent).toHaveBeenCalledTimes(1);
    expect(herdrRepository.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Draft name', bypassPermissions: true }), 'device-a');
    expect(field('Name (optional)').props.editable).toBe(false);
    await TestRenderer.act(async () => result.resolve({ agentId: 'created', paneId: 'pane', name: 'Draft name', runtime: owner.runtime }));
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/agents/[id]', params: { id: 'created' } });
    expect(flowDrafts.get(flowId)).toBeUndefined();
  });

  it('preserves a local draft when the native connection is absent even if cached runtime says connected', () => {
    flowId = beginNewAgentFlow(owner);
    jest.mocked(useHostSession).mockReturnValue(null);
    render(NewAgentPage);
    TestRenderer.act(() => field('Name (optional)').props.onChangeText('Keep this'));
    expect(button('Start agent').props.disabled).toBe(true);
    expect(flowDrafts.get(flowId)).toMatchObject({ name: 'Keep this' });
    expect(herdrRepository.createAgent).not.toHaveBeenCalled();
  });

  it('does not overwrite edited fields when a live snapshot changes', () => {
    flowId = beginNewAgentFlow(owner, 'space-2');
    render(NewAgentPage);
    TestRenderer.act(() => field('Name (optional)').props.onChangeText('Keep this name'));
    owner = { ...owner, runtime: { ...owner.runtime, workspaces: [owner.runtime.workspaces[0]] } };
    jest.mocked(useHerdr).mockReturnValue(repositoryState(owner));
    TestRenderer.act(() => renderer?.update(createElement(NewAgentPage)));
    expect(flowDrafts.get(flowId)).toMatchObject({ name: 'Keep this name', workspaceId: 'space-2' });
    expect(button('Start agent').props.disabled).toBe(true);
  });

  it('shows the missing-flow state for an expired or wrong-kind draft', () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    render(NewAgentPage);
    expect(renderer?.root.findAllByProps({ testID: 'missing-flow' }).length).toBeGreaterThan(0);
    expect(herdrRepository.createAgent).not.toHaveBeenCalled();
  });

  it('preserves editing after a failed creation and unlocks inputs', async () => {
    flowId = beginNewAgentFlow(owner);
    jest.mocked(herdrRepository.createAgent).mockRejectedValue(new Error('Provider refused this model'));
    render(NewAgentPage);
    await TestRenderer.act(async () => button('Start agent').props.onPress());
    expect(flowDrafts.get(flowId)?.kind).toBe('new-agent');
    expect(field('Name (optional)').props.editable).toBe(true);
    expect(renderer?.root.findAllByType(FormError).some((node) => node.props.message === 'Provider refused this model')).toBe(true);
  });

  it('submits spaces only once, to their owner, and dismisses with the created workspace selected', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const result = deferred<CreateSpaceResult>();
    jest.mocked(herdrRepository.createSpace).mockReturnValue(result.promise);
    render(NewSpacePage);
    TestRenderer.act(() => field('Root folder').props.onChangeText('/projects'));
    const submit = button('Create space').props.onPress;
    TestRenderer.act(() => { submit(); submit(); });
    expect(herdrRepository.createSpace).toHaveBeenCalledTimes(1);
    expect(herdrRepository.createSpace).toHaveBeenCalledWith({ cwd: '/projects', label: '' }, 'device-a');
    expect(field('Root folder').props.editable).toBe(false);
    expect(field('Space name (optional)').props.editable).toBe(false);
    await TestRenderer.act(async () => result.resolve({ workspaceId: 'created-space', runtime: owner.runtime }));
    expect(router.dismissTo).toHaveBeenCalledWith({ pathname: '/', params: { selectedSpace: 'created-space', selectedDevice: 'device-a' } });
    expect(flowDrafts.get(flowId)).toBeUndefined();
  });

  it('requires explicit path opening and Use this folder, with no backend mutations', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(remoteClient.sftpList).mockResolvedValue([]);
    render(FoldersPage);
    await TestRenderer.act(async () => {});
    expect(remoteClient.sftpList).toHaveBeenCalledWith('session-a', '.');
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects'));
    expect(button('Use this folder').props.disabled).toBe(true);
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
    await TestRenderer.act(async () => button('Open path').props.onPress());
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-a', '/projects');
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
    TestRenderer.act(() => { button('Use this folder').props.onPress(); button('Use this folder').props.onPress(); });
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '/projects' });
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(herdrRepository.createSpace).not.toHaveBeenCalled();
  });

  it('ignores older path responses and automatically refreshes on the owning device reconnect', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const first = deferred<RemoteFile[]>();
    const second = deferred<RemoteFile[]>();
    const reconnect = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(reconnect.promise);
    render(FoldersPage);
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects'));
    TestRenderer.act(() => button('Open path').props.onPress());
    await TestRenderer.act(async () => first.resolve([{ name: 'stale-folder', path: './stale-folder', isDirectory: true, size: 0 }]));
    expect(button('Use this folder').props.disabled).toBe(true);
    expect(renderer?.root.findAllByType(SelectionRow)).toHaveLength(0);
    await TestRenderer.act(async () => second.resolve([]));
    expect(button('Use this folder').props.disabled).toBe(false);
    owner = { ...owner, connection: 'reconnecting' };
    session = { ...session, status: 'disconnected' };
    updateConnection();
    expect(button('Use this folder').props.disabled).toBe(true);
    owner = { ...owner, connection: 'connected' };
    session = { ...session, status: 'connected', sessionId: 'session-b' };
    updateConnection();
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-b', '/projects');
    expect(button('Use this folder').props.disabled).toBe(true);
    await TestRenderer.act(async () => reconnect.resolve([]));
    expect(button('Use this folder').props.disabled).toBe(false);
  });

  it('shows list failures, permits retry, and never selects an unreadable folder', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(remoteClient.sftpList).mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce([]);
    render(FoldersPage);
    await TestRenderer.act(async () => {});
    expect(button('Use this folder').props.disabled).toBe(true);
    expect(renderer?.root.findAllByType(FormError).some((node) => node.props.message === 'Permission denied')).toBe(true);
    await TestRenderer.act(async () => button('Try again').props.onPress());
    expect(button('Use this folder').props.disabled).toBe(false);
  });

  it('discards the old session response after reconnect even when it resolves last', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const oldSession = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValueOnce(oldSession.promise).mockResolvedValueOnce([]);
    render(FoldersPage);
    session = { ...session, sessionId: 'session-b' };
    updateConnection();
    await TestRenderer.act(async () => {});
    expect(button('Use this folder').props.disabled).toBe(false);
    await TestRenderer.act(async () => oldSession.resolve([{ name: 'old-session', path: './old-session', isDirectory: true, size: 0 }]));
    expect(renderer?.root.findAllByType(SelectionRow)).toHaveLength(0);
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-b', '.');
  });

  it('fences folder responses and mutations after cancellation', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const result = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValue(result.promise);
    render(FoldersPage);
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    await TestRenderer.act(async () => result.resolve([{ name: 'late', path: './late', isDirectory: true, size: 0 }]));
    expect(router.back).not.toHaveBeenCalled();
    expect(herdrRepository.createSpace).not.toHaveBeenCalled();
    expect(flowDrafts.get(flowId)).toBeUndefined();
  });
});
