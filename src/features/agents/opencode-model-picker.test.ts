import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList } from 'react-native';

import ModelsPage from '@/app/flows/models';
import { AppButton } from '@/components/ui/app-button';
import { FormError, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { EMPTY_RUNTIME } from '@/domain/herdr';
import type { OpenCodeModels } from '@/domain/opencode-models';
import { flowDrafts } from '@/features/forms/flow-drafts';
import { herdrRepository, type HerdrRepositoryState } from '@/services/herdr-repository';

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useLocalSearchParams: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FormPage: ({ children }: { children: import('react').ReactNode }) => React.createElement(View, null, children),
    FormSection: ({ children }: { children: import('react').ReactNode }) => children,
    SelectionRow: () => null, FormError: () => null, MissingFlow: () => null,
  };
});
jest.mock('@/components/ui/app-button', () => ({ AppButton: () => null }));
jest.mock('@/components/ui/text-field', () => ({ TextField: () => null }));
jest.mock('@/features/agents/use-herdr', () => ({
  useHerdr: () => jest.requireMock('@/services/herdr-repository').herdrRepository.getSnapshot(),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn(), openCodeModels: jest.fn() },
}));

const result: OpenCodeModels = { workspaceId: 'w1', cwd: '/project', models: ['account/model', 'custom/vendor/model'] };

function pending() {
  let resolve!: (value: OpenCodeModels) => void;
  const promise = new Promise<OpenCodeModels>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('server-scoped OpenCode models', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let flowId: string;
  let state: HerdrRepositoryState;
  beforeEach(() => {
    jest.clearAllMocks();
    state = {
      selectedDeviceId: 'other-device', connection: 'disconnected', runtime: EMPTY_RUNTIME,
      hello: null, lastError: null, lastSemanticEvent: null, agentCountsByDevice: {},
      devices: {
        owner: { deviceId: 'owner', connection: 'connected', hello: null, lastError: null,
          runtime: { ...EMPTY_RUNTIME, workspaces: [{ id: 'w1', cwd: '/project', name: 'Project', status: 'idle' }] } },
      },
    };
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue(state);
    jest.mocked(herdrRepository.openCodeModels).mockResolvedValue(result);
    flowId = flowDrafts.create({
      kind: 'new-agent', deviceId: 'owner', workspaceId: 'w1', name: 'Task', provider: 'opencode',
      tuning: { model: null, effort: null, context: null }, bypassPermissions: true,
    });
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    flowDrafts.discard(flowId);
  });
  async function mount() {
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(ModelsPage)); });
  }
  function rows() { return renderer.root.findAllByType(SelectionRow); }
  function row(label: string) { return rows().find((item) => item.props.label === label)!; }

  it('fetches from the form owner, searches provider namespaces, and keeps selection local', async () => {
    await mount();
    expect(herdrRepository.openCodeModels).toHaveBeenCalledWith('owner', 'w1', false);
    expect(rows().map((item) => item.props.label)).toEqual(['Auto', ...result.models]);
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('custom vendor'));
    expect(rows().map((item) => item.props.label)).toEqual(['custom/vendor/model']);
    TestRenderer.act(() => row('custom/vendor/model').props.onPress());
    expect(flowDrafts.get(flowId)).toMatchObject({ tuning: { model: 'custom/vendor/model', effort: null, context: null } });
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('explicitly refreshes the server cache and replaces, rather than appends, provider models', async () => {
    await mount();
    jest.mocked(herdrRepository.openCodeModels).mockResolvedValueOnce({ ...result, models: ['new/model'] });
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(herdrRepository.openCodeModels).toHaveBeenLastCalledWith('owner', 'w1', true);
    expect(rows().map((item) => item.props.label)).toEqual(['Auto', 'new/model']);
  });

  it('shows a fetch error without falling back to the bundled catalogue and permits retry', async () => {
    jest.mocked(herdrRepository.openCodeModels).mockRejectedValueOnce(new Error('Provider configuration failed'));
    await mount();
    expect(renderer.root.findByType(FormError).props.message).toBe('Provider configuration failed');
    expect(rows().map((item) => item.props.label)).toEqual(['Auto']);
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(row('account/model').props.disabled).toBe(false);
  });

  it('does not reuse old results after a failed refresh or silently change the selected model', async () => {
    flowDrafts.update(flowId, (draft) => draft.kind === 'new-agent'
      ? { ...draft, tuning: { ...draft.tuning, model: 'account/model' } } : draft);
    await mount();
    jest.mocked(herdrRepository.openCodeModels).mockRejectedValueOnce(new Error('Refresh failed'));
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(row('account/model').props.disabled).toBe(true);
    expect(flowDrafts.get(flowId)).toMatchObject({ tuning: { model: 'account/model' } });
    expect(rows().some((item) => item.props.label === 'custom/vendor/model')).toBe(false);
  });

  it('keeps Auto available offline without claiming remote model availability', async () => {
    state.devices.owner.connection = 'disconnected';
    await mount();
    expect(herdrRepository.openCodeModels).not.toHaveBeenCalled();
    expect(renderer.root.findByType(AppButton).props.disabled).toBe(true);
    expect(renderer.root.findByType(FormError).props.message).toContain('Connect this device');
    TestRenderer.act(() => row('Auto').props.onPress());
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('records that a refreshed list removed the selected model so creation can refuse it', async () => {
    flowDrafts.update(flowId, (draft) => draft.kind === 'new-agent'
      ? { ...draft, tuning: { ...draft.tuning, model: 'removed/model' } } : draft);
    await mount();
    expect(row('removed/model').props.disabled).toBe(true);
    expect(flowDrafts.get(flowId)).toMatchObject({
      tuning: { model: 'removed/model' },
      modelAvailability: { deviceId: 'owner', workspaceId: 'w1', cwd: '/project', model: 'removed/model', available: false },
    });
    TestRenderer.act(() => row('account/model').props.onPress());
    expect(flowDrafts.get(flowId)).toMatchObject({ tuning: { model: 'account/model' }, modelAvailability: undefined });
  });

  it('handles a genuinely empty list without manufacturing providers', async () => {
    jest.mocked(herdrRepository.openCodeModels).mockResolvedValueOnce({ ...result, models: [] });
    await mount();
    expect(renderer.root.findByType(FormError).props.message).toBeNull();
    expect(rows().map((item) => item.props.label)).toEqual(['Auto']);
  });

  it('ignores late responses from a previous workspace', async () => {
    const first = pending();
    jest.mocked(herdrRepository.openCodeModels).mockReturnValueOnce(first.promise);
    await mount();
    state.devices.owner.runtime.workspaces.push({ id: 'w2', cwd: '/other', name: 'Other', status: 'idle' });
    jest.mocked(herdrRepository.openCodeModels).mockResolvedValueOnce({ workspaceId: 'w2', cwd: '/other', models: ['other/model'] });
    await TestRenderer.act(async () => flowDrafts.update(flowId, (draft) =>
      draft.kind === 'new-agent' ? { ...draft, workspaceId: 'w2' } : draft));
    await TestRenderer.act(async () => first.resolve(result));
    expect(rows().map((item) => item.props.label)).toEqual(['Auto', 'other/model']);
  });

  it('refuses stale row callbacks when the form owner or native connection changed', async () => {
    await mount();
    const choose = row('account/model').props.onPress;
    state.devices.owner.connection = 'disconnected';
    TestRenderer.act(() => choose());
    expect(router.back).not.toHaveBeenCalled();
    expect(flowDrafts.get(flowId)).toMatchObject({ tuning: { model: null } });
    state.devices.owner.connection = 'connected';
    await TestRenderer.act(async () => flowDrafts.update(flowId, (draft) =>
      draft.kind === 'new-agent' ? { ...draft, deviceId: 'other-device' } : draft));
    TestRenderer.act(() => choose());
    expect(router.back).not.toHaveBeenCalled();
  });

  it('allows leaving during discovery without applying a late response', async () => {
    const request = pending();
    jest.mocked(herdrRepository.openCodeModels).mockReturnValueOnce(request.promise);
    await mount();
    expect(renderer.root.findByType(FlatList).props.data).toHaveLength(1);
    TestRenderer.act(() => renderer.unmount());
    await TestRenderer.act(async () => request.resolve(result));
    expect(router.back).not.toHaveBeenCalled();
  });
});
