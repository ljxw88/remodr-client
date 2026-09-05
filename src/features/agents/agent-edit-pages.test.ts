import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList } from 'react-native';

import AgentSettingsPage from '@/app/flows/agent-settings';
import ModelsPage from '@/app/flows/models';
import RenameAgentPage from '@/app/flows/rename-agent';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { EMPTY_RUNTIME, remoteAgentSchema } from '@/domain/herdr';
import { flowDrafts, type AgentSettingsDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { beginAgentSettingsFlow, beginRenameAgentFlow } from './agent-edit-flow';
import { TuningFields } from './tuning-fields';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FormPage: ({ children, footer }: { children: import('react').ReactNode; footer?: import('react').ReactNode }) =>
      React.createElement(View, null, children, footer),
    FormSection: ({ children }: { children: import('react').ReactNode }) => children,
    SelectionRow: () => null,
    FormError: () => null,
    MissingFlow: () => null,
  };
});
jest.mock('@/components/ui/app-button', () => ({ AppButton: () => null }));
jest.mock('@/components/ui/text-field', () => ({ TextField: () => null }));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    deviceIdForAgent: jest.fn(),
    getSnapshot: jest.fn(),
    retuneAgent: jest.fn(),
    renameAgent: jest.fn(),
  },
}));
jest.mock('./use-herdr', () => ({
  useHerdr: () => jest.requireMock('@/services/herdr-repository').herdrRepository.getSnapshot(),
}));

const agent = () => remoteAgentSchema.parse({
  id: 'agent-a', deviceId: 'device-a', provider: 'copilot', providerSessionId: 'session-a',
  herdrSessionId: 'herdr-a', workspaceId: 'space-a', workspaceName: 'Work',
  paneId: 'pane-a', status: 'working', title: 'Review changes', focused: true, capabilities: {},
  tuning: { model: 'private-model', effort: 'max', context: 'long_context' },
});

describe('agent settings and model pages', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let flowId: string;

  beforeEach(() => {
    jest.clearAllMocks();
    const live = agent();
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue({
      selectedDeviceId: 'other-device', connection: 'disconnected', runtime: EMPTY_RUNTIME,
      devices: {
        'device-a': {
          deviceId: 'device-a', connection: 'connected',
          runtime: { ...EMPTY_RUNTIME, agents: [live] }, hello: null, lastError: null,
        },
      },
      hello: null, lastError: null, lastSemanticEvent: null, agentCountsByDevice: {},
    });
    flowId = beginAgentSettingsFlow(live);
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    flowDrafts.discard(flowId);
  });

  it('preserves off-catalogue tuning on mount and polls, then applies once with restart warning', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.retuneAgent).mockImplementation(() =>
      new Promise((resolve) => { finish = () => resolve({ agentId: 'agent-a', runtime: EMPTY_RUNTIME }); }));
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AgentSettingsPage)); });
    expect(renderer.root.findByType(AppButton).props.disabled).toBe(true);
    expect(renderer.root.findByType(TuningFields).props.value.model).toBe('private-model');
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
    const current = (flowDrafts.get(flowId) as AgentSettingsDraft).tuning;
    TestRenderer.act(() => renderer.root.findByType(TuningFields).props.onChange({ ...current, effort: 'high' }));
    const live = herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0];
    live.tuning = { ...current, effort: 'high' };
    TestRenderer.act(() => renderer.update(createElement(AgentSettingsPage)));
    expect(renderer.root.findByType(AppButton).props.label).toBe('Apply and restart');
    expect(renderer.root.findByType(AppButton).props.disabled).toBe(false);
    const action = renderer.root.findByType(AppButton).props.onPress;
    await TestRenderer.act(async () => { action(); action(); });
    expect(herdrRepository.retuneAgent).toHaveBeenCalledTimes(1);
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith({
      agentId: 'agent-a', model: 'private-model', effort: 'high', context: 'long_context',
    });
    expect(renderer.root.findByType(FormPage).props.busy).toBe(true);
    await TestRenderer.act(async () => finish());
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('retains a failed draft and blocks requests if the owning connection or provider changed', async () => {
    jest.mocked(herdrRepository.retuneAgent).mockRejectedValueOnce(new Error('Runtime refused settings'));
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AgentSettingsPage)); });
    TestRenderer.act(() => renderer.root.findByType(TuningFields).props.onChange({
      model: 'gpt-5.6-sol', effort: 'max', context: 'long_context',
    }));
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(renderer.root.findByType(FormError).props.message).toBe('Runtime refused settings');
    expect(renderer.root.findByType(FormPage).props.busy).toBe(false);
    expect(flowDrafts.get(flowId)).toMatchObject({ tuning: { model: 'gpt-5.6-sol' } });
    const device = herdrRepository.getSnapshot().devices['device-a'];
    device.connection = 'reconnecting';
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType(FormError).props.message).toContain('Reconnect');
    device.connection = 'connected';
    device.runtime.agents[0].provider = 'claude';
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType(FormError).props.message).toContain('provider has changed');
  });

  it('selects only the draft and uses a non-nested searchable list with the running model selected', () => {
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(ModelsPage)); });
    expect(renderer.root.findByType(FormPage).props.scroll).toBe(false);
    expect(renderer.root.findAllByType(FormSection)).toHaveLength(1);
    expect(renderer.root.findByType(FormSection).props.fill).toBe(true);
    const list = renderer.root.findByType(FlatList);
    expect(list.props.showsVerticalScrollIndicator).toBe(false);
    expect(list.props.renderItem({ item: { model: 'private-model', label: 'private-model' } }).type)
      .toBe(SelectionRow);
    expect(renderer.root.findAllByProps({ testID: 'current-model' })[0].props.children)
      .toEqual(['Current: ', 'private-model']);
    const current = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === 'private-model')!;
    expect(current.props.selected).toBe(true);
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('claude opus 5'));
    const model = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === 'Claude Opus 5')!;
    TestRenderer.act(() => { model.props.onPress(); model.props.onPress(); });
    expect(flowDrafts.get(flowId)).toMatchObject({
      tuning: { model: 'claude-opus-5', effort: 'max', context: 'long_context' },
      initialTuning: { model: 'private-model' },
    });
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('allows new-agent drafts to use the same model route, including Auto', () => {
    flowDrafts.discard(flowId);
    flowId = flowDrafts.create({
      kind: 'new-agent', deviceId: 'device-a', name: 'New task', workspaceId: 'space-a',
      provider: 'copilot', bypassPermissions: true,
      tuning: { model: 'private-model', effort: 'max', context: 'long_context' },
    });
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(ModelsPage)); });
    const auto = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === 'Auto')!;
    TestRenderer.act(() => auto.props.onPress());
    expect(flowDrafts.get(flowId)).toMatchObject({
      kind: 'new-agent', name: 'New task', tuning: { model: null, effort: null, context: null },
    });
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
  });

  it('leaves the live model untouched when a selector is cancelled without a selection', async () => {
    const releaseParent = flowDrafts.retain(flowId);
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(ModelsPage)); });
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('gpt'));
    await TestRenderer.act(async () => renderer.unmount());
    expect(flowDrafts.get(flowId)).toMatchObject({
      tuning: { model: 'private-model', effort: 'max', context: 'long_context' },
    });
    expect(herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0].tuning?.model)
      .toBe('private-model');
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
    releaseParent();
  });

  it('does not navigate after an asynchronous completion if the page was unmounted', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.retuneAgent).mockImplementation(() =>
      new Promise((resolve) => { finish = () => resolve({ agentId: 'agent-a', runtime: EMPTY_RUNTIME }); }));
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AgentSettingsPage)); });
    TestRenderer.act(() => renderer.root.findByType(TuningFields).props.onChange({
      model: 'new-model', effort: 'max', context: 'long_context',
    }));
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    TestRenderer.act(() => renderer.unmount());
    await TestRenderer.act(async () => finish());
    expect(router.back).not.toHaveBeenCalled();
  });

  it.each([AgentSettingsPage, ModelsPage, RenameAgentPage])('shows unavailable UI for missing and incompatible drafts', (Page) => {
    jest.mocked(useLocalSearchParams).mockReturnValue({});
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Page)); });
    expect(renderer.root.findByType(MissingFlow)).toBeDefined();
    const incompatible = flowDrafts.create({ kind: 'new-space', deviceId: 'a', label: '', cwd: '~/' });
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId: incompatible });
    TestRenderer.act(() => renderer.update(createElement(Page)));
    expect(renderer.root.findByType(MissingFlow)).toBeDefined();
    flowDrafts.discard(incompatible);
  });

  it('uses one guarded rename for keyboard and footer, with blank and unchanged names disabled', async () => {
    flowDrafts.discard(flowId);
    flowId = beginRenameAgentFlow(agent());
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
    let finish!: () => void;
    jest.mocked(herdrRepository.renameAgent).mockImplementation(() =>
      new Promise((resolve) => { finish = () => resolve({ agentId: 'agent-a', runtime: EMPTY_RUNTIME }); }));
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(RenameAgentPage)); });
    expect(renderer.root.findByType(AppButton).props.disabled).toBe(true);
    expect(renderer.root.findByType(TextField).props.autoFocus).toBe(true);
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onSubmitEditing());
    expect(herdrRepository.renameAgent).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('  '));
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onSubmitEditing());
    expect(renderer.root.findByType(TextField).props.error).toContain('Enter a name');
    expect(herdrRepository.renameAgent).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('  Ship release  '));
    const keyboard = renderer.root.findByType(TextField).props.onSubmitEditing;
    const footer = renderer.root.findByType(AppButton).props.onPress;
    await TestRenderer.act(async () => { keyboard(); footer(); });
    expect(herdrRepository.renameAgent).toHaveBeenCalledTimes(1);
    expect(herdrRepository.renameAgent).toHaveBeenCalledWith('agent-a', 'Ship release');
    expect(renderer.root.findByType(FormPage).props.busy).toBe(true);
    expect(renderer.root.findByType(TextField).props.editable).toBe(false);
    await TestRenderer.act(async () => finish());
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('keeps the edited name after a failed rename and allows an explicit retry', async () => {
    flowDrafts.discard(flowId);
    flowId = beginRenameAgentFlow(agent());
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
    jest.mocked(herdrRepository.renameAgent)
      .mockRejectedValueOnce(new Error('Could not save the name'))
      .mockResolvedValueOnce({ agentId: 'agent-a', runtime: EMPTY_RUNTIME });
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(RenameAgentPage)); });
    TestRenderer.act(() => renderer.root.findByType(TextField).props.onChangeText('Ship release'));
    await TestRenderer.act(async () => renderer.root.findByType(TextField).props.onSubmitEditing());
    expect(renderer.root.findByType(FormError).props.message).toBe('Could not save the name');
    expect(renderer.root.findByType(TextField).props.value).toBe('Ship release');
    expect(renderer.root.findByType(TextField).props.editable).toBe(true);
    expect(renderer.root.findByType(FormPage).props.busy).toBe(false);
    expect(router.back).not.toHaveBeenCalled();
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(herdrRepository.renameAgent).toHaveBeenCalledTimes(2);
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
