import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList, Keyboard } from 'react-native';

import DevicesPage from '@/app/flows/devices';
import NewAgentPage from '@/app/flows/new-agent';
import NewSpacePage from '@/app/flows/new-space';
import FoldersPage from '@/app/flows/folders';
import ProvidersPage from '@/app/flows/providers';
import SpacesPage from '@/app/flows/spaces';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormSection, SelectionRow } from '@/components/ui/form-page';
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
import { selectWorkspace } from '@/features/agents/workspace-selection';
import { useHostSession } from '@/features/connection/use-host-session';
import { flowDrafts, type NewAgentDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { herdrRepository, type DeviceRuntimeState, type HerdrRepositoryState } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';

jest.mock('@/domain/model-catalogues/copilot.json', () => require('../../domain/__fixtures__/copilot.json'));

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
jest.mock('@/features/agents/workspace-selection', () => ({ selectWorkspace: jest.fn() }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: jest.fn(), refreshSessions: jest.fn() }));
jest.mock('@/features/hosts/use-hosts', () => ({ useHosts: () => ({ hosts: [], loading: false, error: null, reload: jest.fn() }) }));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn(), createAgent: jest.fn(), createSpace: jest.fn(), selectDevice: jest.fn() },
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

  it.each(['claude', 'codex', 'cursor'] as const)('sends explicit launch models for %s', (provider) => {
    expect(agentCreationInput({
      ...newAgentDraft(device()), provider,
      tuning: { model: 'account-model', effort: null, context: null },
    })).toMatchObject({ provider, model: 'account-model', effort: undefined, context: undefined });
  });
});

describe('creation pages and folder lifetime', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let flowId: string;
  let owner: DeviceRuntimeState;
  let session: SessionSnapshot;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(remoteClient.sftpList).mockReset();
    jest.mocked(herdrRepository.createAgent).mockReset();
    jest.mocked(herdrRepository.createSpace).mockReset();
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

  function control(label: string) {
    const found = renderer?.root.findAllByProps({ accessibilityLabel: label }).find((node) => typeof node.props.onPress === 'function');
    if (!found) throw new Error(`Missing control: ${label}`);
    return found;
  }

  function updateConnection() {
    jest.mocked(useHerdr).mockReturnValue(repositoryState(owner));
    TestRenderer.act(() => renderer?.update(createElement(FoldersPage)));
  }

  it.each([
    { name: 'device', Page: DevicesPage },
    { name: 'provider', Page: ProvidersPage },
    { name: 'space', Page: SpacesPage },
  ])('uses one bounded group for the $name selector list', ({ Page }) => {
    flowId = beginNewAgentFlow(owner);
    render(Page);
    const groups = renderer?.root.findAllByType(FormSection);
    expect(groups).toHaveLength(1);
    expect(groups?.[0].props.fill).toBe(true);
    expect(groups?.[0].findByType(FlatList).props.showsVerticalScrollIndicator).toBe(false);
  });

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
    expect(herdrRepository.selectDevice).not.toHaveBeenCalled();
    expect(selectWorkspace).not.toHaveBeenCalled();
    await TestRenderer.act(async () => result.resolve({ agentId: 'created', paneId: 'pane', name: 'Draft name', runtime: owner.runtime }));
    expect(herdrRepository.selectDevice).toHaveBeenCalledWith('device-a');
    expect(selectWorkspace).toHaveBeenCalledWith('device-a', 'space-1');
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/agents/[id]', params: { id: 'created' } });
    expect(flowDrafts.get(flowId)).toBeDefined();
    expect(renderer?.root.findAllByProps({ testID: 'missing-flow' })).toHaveLength(0);
    expect(button('Starting agent…').props.disabled).toBe(true);
    await TestRenderer.act(async () => { renderer?.unmount(); });
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
    expect(herdrRepository.selectDevice).not.toHaveBeenCalled();
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('submits spaces once to their owner and replaces the form with an agent draft from the fresh snapshot', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const result = deferred<CreateSpaceResult>();
    jest.mocked(herdrRepository.createSpace).mockReturnValue(result.promise);
    render(NewSpacePage);
    TestRenderer.act(() => field('Root folder').props.onChangeText('/projects'));
    const submit = button('Create space and continue').props.onPress;
    TestRenderer.act(() => { submit(); submit(); });
    expect(herdrRepository.createSpace).toHaveBeenCalledTimes(1);
    expect(herdrRepository.createSpace).toHaveBeenCalledWith({ cwd: '/projects', label: '' }, 'device-a');
    expect(field('Root folder').props.editable).toBe(false);
    expect(field('Space name (optional)').props.editable).toBe(false);
    expect(herdrRepository.selectDevice).not.toHaveBeenCalled();
    expect(selectWorkspace).not.toHaveBeenCalled();
    owner = {
      ...owner, runtime: {
        ...owner.runtime,
        providers: [{ provider: 'codex', available: true, aliases: [] }],
        workspaces: [...owner.runtime.workspaces, { id: 'created-space', name: 'Created', status: 'idle' }],
      },
    };
    await TestRenderer.act(async () => result.resolve({ workspaceId: 'created-space', runtime: owner.runtime }));
    expect(herdrRepository.selectDevice).toHaveBeenCalledWith('device-a');
    expect(selectWorkspace).toHaveBeenCalledWith('device-a', 'created-space');
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/flows/new-agent', params: { flowId: expect.any(String) } });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(herdrRepository.createAgent).not.toHaveBeenCalled();
    const destination = jest.mocked(router.replace).mock.calls[0]?.[0];
    if (!destination || typeof destination === 'string' || !('params' in destination) ||
      !destination.params || !('flowId' in destination.params) || typeof destination.params.flowId !== 'string') {
      throw new Error('The handoff must pass a new flow ID');
    }
    expect(destination.params.flowId).not.toBe(flowId);
    expect(flowDrafts.get(destination.params.flowId)).toMatchObject({
      kind: 'new-agent', deviceId: 'device-a', workspaceId: 'created-space', provider: 'codex',
    });
    flowDrafts.discard(destination.params.flowId);
    expect(flowDrafts.get(flowId)).toBeDefined();
    expect(renderer?.root.findAllByProps({ testID: 'missing-flow' })).toHaveLength(0);
    await TestRenderer.act(async () => { renderer?.unmount(); });
    expect(flowDrafts.get(flowId)).toBeUndefined();
  });

  it('does not hand off to the wrong workspace if the created space disappears before continuation', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(herdrRepository.createSpace).mockResolvedValue({ workspaceId: 'created-space', runtime: owner.runtime });
    render(NewSpacePage);
    await TestRenderer.act(async () => button('Create space and continue').props.onPress());
    expect(router.replace).not.toHaveBeenCalled();
    expect(herdrRepository.selectDevice).toHaveBeenCalledWith('device-a');
    expect(selectWorkspace).toHaveBeenCalledWith('device-a', 'created-space');
    expect(router.dismissTo).toHaveBeenCalledWith('/');
    await TestRenderer.act(async () => { renderer?.unmount(); });
    expect(flowDrafts.get(flowId)).toBeUndefined();
  });

  it('requires explicit path opening and Use this folder, with no backend mutations', async () => {
    const dismissKeyboard = jest.spyOn(Keyboard, 'dismiss');
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(remoteClient.sftpList).mockResolvedValue([]);
    render(FoldersPage);
    await TestRenderer.act(async () => {});
    expect(renderer?.root.findAllByType(FormSection)).toHaveLength(1);
    expect(renderer?.root.findByType(FormSection).props.fill).toBe(true);
    expect(renderer?.root.findByType(FlatList).props.showsVerticalScrollIndicator).toBe(false);
    expect(renderer?.root.findAllByType(TextField)).toHaveLength(1);
    expect(field('Folder path').props.rightAccessory).toBeDefined();
    expect(renderer?.root.findAllByType(AppButton).some((node) => node.props.label === 'Open path')).toBe(false);
    expect(remoteClient.sftpList).toHaveBeenCalledWith('session-a', '.');
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects'));
    expect(button('Use this folder').props.disabled).toBe(true);
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
    await TestRenderer.act(async () => control('Open path').props.onPress());
    expect(dismissKeyboard).toHaveBeenCalled();
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-a', '/projects');
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
    TestRenderer.act(() => { button('Use this folder').props.onPress(); button('Use this folder').props.onPress(); });
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '/projects' });
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(herdrRepository.createSpace).not.toHaveBeenCalled();
    dismissKeyboard.mockRestore();
  });

  it('ignores older path responses and automatically refreshes on the owning device reconnect', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const first = deferred<RemoteFile[]>();
    const second = deferred<RemoteFile[]>();
    const reconnect = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(reconnect.promise);
    render(FoldersPage);
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects'));
    TestRenderer.act(() => control('Open path').props.onPress());
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

  it('does not select an old displayed folder through a stale confirmation callback', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(remoteClient.sftpList).mockResolvedValue([]);
    render(FoldersPage);
    await TestRenderer.act(async () => {});
    const oldSelection = button('Use this folder').props.onPress;
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects'));
    await TestRenderer.act(async () => control('Open path').props.onPress());
    TestRenderer.act(() => oldSelection());
    expect(router.back).not.toHaveBeenCalled();
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
    TestRenderer.act(() => button('Use this folder').props.onPress());
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '/projects' });
  });

  it('surfaces a native session change instead of showing an obsolete listing error', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    const pending = deferred<RemoteFile[]>();
    jest.mocked(remoteClient.sftpList).mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    render(FoldersPage);
    const replacement = { ...session, sessionId: 'session-b' };
    jest.mocked(remoteClient.getSession).mockReturnValue(replacement);
    await TestRenderer.act(async () => { pending.reject(new Error('Obsolete permission error')); });
    expect(button('Use this folder').props.disabled).toBe(true);
    const errors = renderer!.root.findAllByType(FormError).map((node) => node.props.message);
    expect(errors).toContain('This device disconnected. Reconnect and try again.');
    expect(errors).not.toContain('Obsolete permission error');
    session = replacement;
    updateConnection();
    await TestRenderer.act(async () => {});
    expect(button('Use this folder').props.disabled).toBe(false);
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-b', '.');
  });

  it('uses the same address handler for keyboard Go and the accessory, and navigates Up from the opened path', async () => {
    flowId = beginNewSpaceFlow(owner.deviceId);
    jest.mocked(remoteClient.sftpList).mockResolvedValue([]);
    render(FoldersPage);
    await TestRenderer.act(async () => {});
    expect(control('Parent folder').props.disabled).toBe(true);
    TestRenderer.act(() => field('Folder path').props.onChangeText('/projects/mobile'));
    expect(field('Folder path').props.onSubmitEditing).toBe(control('Open path').props.onPress);
    expect(button('Use this folder').props.disabled).toBe(true);
    expect(control('Parent folder').props.disabled).toBe(true);
    expect(renderer?.root.findAllByType(FlatList)).toHaveLength(0);
    await TestRenderer.act(async () => field('Folder path').props.onSubmitEditing());
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-a', '/projects/mobile');
    expect(button('Use this folder').props.disabled).toBe(false);
    await TestRenderer.act(async () => control('Parent folder').props.onPress());
    expect(field('Folder path').props.value).toBe('/projects');
    expect(remoteClient.sftpList).toHaveBeenLastCalledWith('session-a', '/projects');
    expect(flowDrafts.get(flowId)).toMatchObject({ cwd: '~/' });
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
