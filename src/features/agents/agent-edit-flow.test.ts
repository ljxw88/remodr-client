import { tuningForModel } from '@/domain/agent-catalogue';
import { EMPTY_RUNTIME, remoteAgentSchema } from '@/domain/herdr';
import { flowDrafts, type AgentSettingsDraft } from '@/features/forms/flow-drafts';
import { herdrRepository, type DeviceRuntimeState } from '@/services/herdr-repository';
import {
  agentEditError,
  beginAgentSettingsFlow,
  beginRenameAgentFlow,
  chooseModel,
  modelChoices,
  renameError,
  tuningChanges,
} from './agent-edit-flow';

jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    deviceIdForAgent: jest.fn(),
    retuneAgent: jest.fn(),
    renameAgent: jest.fn(),
  },
}));

const agent = () => remoteAgentSchema.parse({
  id: 'agent-a', deviceId: 'device-a', provider: 'copilot', providerSessionId: 'session-a',
  herdrSessionId: 'herdr-a', workspaceId: 'space-a', workspaceName: 'Work',
  paneId: 'pane-a', status: 'working', title: 'Review changes', focused: true, capabilities: {},
  tuning: { model: 'private-model', effort: 'max', context: 'long_context' },
});

describe('agent edit drafts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('freezes an independent initial snapshot and never mutates the running agent on opening', () => {
    const live = agent();
    const id = beginAgentSettingsFlow(live);
    const draft = flowDrafts.get(id) as AgentSettingsDraft;
    expect(draft).toMatchObject({
      kind: 'agent-settings', deviceId: 'device-a', providerSessionId: 'session-a',
      initialTuning: live.tuning, tuning: live.tuning,
    });
    expect(draft.initialTuning).not.toBe(live.tuning);
    expect(draft.tuning).not.toBe(draft.initialTuning);
    expect(Object.isFrozen(draft.initialTuning)).toBe(true);
    live.tuning!.model = 'polled-model';
    draft.tuning.model = 'draft-model';
    expect(draft.initialTuning.model).toBe('private-model');
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
    flowDrafts.discard(id);
  });

  it('resolves missing ownership from the repository and fails explicitly if unavailable', () => {
    const live = { ...agent(), deviceId: undefined };
    jest.mocked(herdrRepository.deviceIdForAgent).mockReturnValue('indexed-device');
    const id = beginRenameAgentFlow(live);
    expect(flowDrafts.get(id)).toMatchObject({
      kind: 'rename-agent', deviceId: 'indexed-device', name: live.title,
      initialName: live.title, provider: live.provider, providerSessionId: 'session-a',
    });
    expect(herdrRepository.renameAgent).not.toHaveBeenCalled();
    flowDrafts.discard(id);
    jest.mocked(herdrRepository.deviceIdForAgent).mockReturnValue(null);
    expect(() => beginAgentSettingsFlow(live)).toThrow('available device');
    expect(() => beginRenameAgentFlow(live)).toThrow('available device');
  });

  it('guards the owning device, deletion, provider replacement and session replacement', () => {
    const live = agent();
    const id = beginAgentSettingsFlow(live);
    const draft = flowDrafts.get(id) as AgentSettingsDraft;
    const device: DeviceRuntimeState = {
      deviceId: 'device-a', connection: 'connected',
      runtime: { ...EMPTY_RUNTIME, agents: [live] }, hello: null, lastError: null,
    };
    expect(agentEditError({ 'device-a': device }, draft)).toBeNull();
    expect(agentEditError({ 'selected-other-device': device }, draft)).toContain('device');
    expect(agentEditError({ 'device-a': { ...device, connection: 'reconnecting' } }, draft)).toContain('Reconnect');
    expect(agentEditError({
      'device-a': { ...device, runtime: { ...EMPTY_RUNTIME, agents: [] } },
    }, draft)).toContain('agent is no longer');
    live.provider = 'claude';
    expect(agentEditError({ 'device-a': device }, draft)).toContain('provider has changed');
    live.provider = 'copilot';
    live.providerSessionId = 'replacement';
    expect(agentEditError({ 'device-a': device }, draft)).toContain('session has changed');
    flowDrafts.discard(id);
  });

  it('requires restart only for reasoning or context changes and validates a trimmed rename', () => {
    const initial = { model: 'private-model', effort: 'max' as const, context: 'long_context' as const };
    expect(tuningChanges(initial, { ...initial })).toEqual({ changed: false, restarts: false });
    expect(tuningChanges(initial, { ...initial, model: 'new-model' })).toEqual({ changed: true, restarts: false });
    expect(tuningChanges(initial, { ...initial, effort: null })).toEqual({ changed: true, restarts: true });
    expect(tuningChanges(initial, { ...initial, context: null })).toEqual({ changed: true, restarts: true });
    expect(renameError('  ', 'Agent')).toContain('Enter a name');
    expect(renameError(' Agent ', 'Agent')).toContain('different name');
    expect(renameError('a'.repeat(61), 'Agent')).toContain('60 characters');
    expect(renameError(' New name ', 'Agent')).toBeNull();
  });
});

describe('page model choices', () => {
  it('keeps Auto and both running and draft out-of-catalogue models without duplicates', () => {
    const choices = modelChoices('copilot', 'private-draft', '', 'private-running');
    expect(choices[0]).toMatchObject({ model: null, label: 'Auto' });
    expect(choices.filter((choice) => choice.model === 'private-running')).toHaveLength(1);
    expect(choices.filter((choice) => choice.model === 'private-draft')).toHaveLength(1);
    expect(modelChoices('copilot', 'private-running', '', 'private-running')
      .filter((choice) => choice.model === 'private-running')).toHaveLength(1);
    expect(modelChoices('copilot', 'claude-opus-5', '', 'claude-opus-5')
      .filter((choice) => choice.model === 'claude-opus-5')).toHaveLength(1);
  });

  it('searches labels and IDs case-insensitively, including unknown current models', () => {
    expect(modelChoices('copilot', 'Private-Model', '  PRIVATE model '))
      .toEqual([expect.objectContaining({ model: 'Private-Model' })]);
    expect(modelChoices('copilot', null, 'gpt-5.6-sol'))
      .toEqual([expect.objectContaining({ label: 'GPT-5.6 Sol' })]);
    expect(modelChoices('copilot', null, ' CLAUDE   OPUS ')).toHaveLength(3);
    expect(modelChoices('copilot', null, 'not-a-model')).toEqual([]);
    expect(modelChoices('copilot', null, 'auto')).toEqual([expect.objectContaining({ model: null })]);
  });

  it('preserves current off-catalogue settings until an actual different model is selected', () => {
    const previous = { model: 'private-model', effort: 'max' as const, context: 'long_context' as const };
    expect(chooseModel('copilot', 'private-model', previous)).toBe(previous);
    for (const model of ['gpt-5.6-sol', 'gemini-3.8-flash', 'claude-haiku-4.5', null]) {
      expect(chooseModel('copilot', model, previous)).toEqual(tuningForModel('copilot', model, previous));
    }
    const automatic = { ...previous, model: null };
    expect(chooseModel('copilot', null, automatic)).toBe(automatic);
    expect(previous).toEqual({ model: 'private-model', effort: 'max', context: 'long_context' });
  });
});
