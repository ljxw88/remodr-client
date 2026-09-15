import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { router, useLocalSearchParams } from 'expo-router';

import AgentSettingsPage from '@/app/flows/agent-settings';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, SelectionRow } from '@/components/ui/form-page';
import { agentVariantOptionsSchema, EMPTY_RUNTIME, remoteAgentSchema } from '@/domain/herdr';
import { flowDrafts } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { beginAgentSettingsFlow } from './agent-edit-flow';
import { TuningFields } from './tuning-fields';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() }, useLocalSearchParams: jest.fn(),
}));
jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FormPage: ({ children, footer }: { children: import('react').ReactNode; footer?: import('react').ReactNode }) =>
      React.createElement(View, null, children, footer),
    FormSection: ({ children }: { children: import('react').ReactNode }) => children,
    SelectionRow: () => null, FormError: () => null, MissingFlow: () => null,
  };
});
jest.mock('@/components/ui/app-button', () => ({ AppButton: () => null }));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { getSnapshot: jest.fn(), agentVariantOptions: jest.fn(), retuneAgent: jest.fn(), deviceIdForAgent: jest.fn() },
}));
jest.mock('./use-herdr', () => ({ useHerdr: () => jest.requireMock('@/services/herdr-repository').herdrRepository.getSnapshot() }));

const options = {
  modelLabel: 'Example Model', modelToken: 'Build | Example Model',
  currentVariant: 'high', variants: ['low', 'high', 'custom-deep'],
};

describe('OpenCode reasoning variants', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let flowId: string;
  beforeEach(() => {
    jest.clearAllMocks();
    const agent = remoteAgentSchema.parse({
      id: 'agent-a', deviceId: 'device-a', provider: 'opencode', providerSessionId: 'ses_a',
      herdrSessionId: 'default', workspaceId: 'w1', workspaceName: 'Demo', paneId: 'p1',
      title: 'OpenCode', status: 'idle', focused: true, capabilities: { supportsRetuning: true },
      tuning: { model: 'provider/example' },
    });
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue({
      selectedDeviceId: 'another-device', connection: 'connected', runtime: EMPTY_RUNTIME,
      devices: { 'device-a': {
        deviceId: 'device-a', connection: 'connected', runtime: { ...EMPTY_RUNTIME, agents: [agent] }, hello: null, lastError: null,
      } },
      hello: null, lastError: null, lastSemanticEvent: null, agentCountsByDevice: {},
    });
    jest.mocked(herdrRepository.agentVariantOptions).mockResolvedValue(options);
    jest.mocked(herdrRepository.retuneAgent).mockResolvedValue({ agentId: agent.id, runtime: EMPTY_RUNTIME });
    flowId = beginAgentSettingsFlow(agent);
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    flowDrafts.discard(flowId);
  });
  async function render() {
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(AgentSettingsPage));
    });
  }
  function row(label: string) {
    return renderer.root.findAllByType(SelectionRow).find((node) => node.props.label === label)!;
  }
  function button(label: string) {
    return renderer.root.findAllByType(AppButton).find((node) => node.props.label === label)!;
  }

  function enableApiVariants() {
    const agent = herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0];
    agent.capabilities.apiModelSelection = true;
    agent.capabilities.apiVariantSelection = true;
    flowDrafts.discard(flowId);
    flowId = beginAgentSettingsFlow(agent);
    jest.mocked(useLocalSearchParams).mockReturnValue({ flowId });
    jest.mocked(herdrRepository.agentVariantOptions).mockResolvedValue({ ...options, modelToken: 'provider/example' });
  }

  it('loads API variants and applies the model and custom variant together without restarting', async () => {
    enableApiVariants();
    await render();
    expect(herdrRepository.agentVariantOptions).toHaveBeenCalledWith('agent-a', 'ses_a', 'provider/example');
    expect(row('high').props.selected).toBe(true);
    expect(button('Apply').props.disabled).toBe(true);
    TestRenderer.act(() => row('custom-deep').props.onPress());
    expect(button('Apply').props.disabled).toBe(false);
    await TestRenderer.act(async () => button('Apply').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith({
      agentId: 'agent-a', providerSessionId: 'ses_a', model: 'provider/example',
      effort: null, context: null, variant: 'custom-deep', modelToken: 'provider/example',
    });
  });

  it('clears an API variant through Default', async () => {
    enableApiVariants();
    await render();
    TestRenderer.act(() => row('Default').props.onPress());
    await TestRenderer.act(async () => button('Apply').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith(expect.objectContaining({ variant: null }));
  });

  it('discards the previous model variant and ignores late discovery results', async () => {
    enableApiVariants();
    let resolve!: (value: typeof options) => void;
    jest.mocked(herdrRepository.agentVariantOptions).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    jest.mocked(herdrRepository.agentVariantOptions).mockResolvedValue({
      modelLabel: 'Other model', modelToken: 'provider/other', currentVariant: null, variants: ['other-only'],
    });
    await TestRenderer.act(async () => renderer.root.findByType(TuningFields).props.onChange({
      model: 'provider/other', effort: null, context: null,
    }));
    await TestRenderer.act(async () => resolve({ ...options, modelToken: 'provider/example' }));
    expect(row('custom-deep')).toBeUndefined();
    expect(row('Default').props.selected).toBe(true);
    TestRenderer.act(() => row('other-only').props.onPress());
    await TestRenderer.act(async () => button('Apply').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider/other', variant: 'other-only' }));
  });

  it('keeps Auto available and clears model-specific choices', async () => {
    enableApiVariants();
    await render();
    TestRenderer.act(() => row('custom-deep').props.onPress());
    await TestRenderer.act(async () => renderer.root.findByType(TuningFields).props.onChange({ model: null, effort: null, context: null }));
    expect(row('custom-deep')).toBeUndefined();
    await TestRenderer.act(async () => button('Apply').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith({
      agentId: 'agent-a', providerSessionId: 'ses_a', model: null, effort: null, context: null,
    });
  });

  it('reloads failed API discovery and blocks applying after native connection loss', async () => {
    enableApiVariants();
    jest.mocked(herdrRepository.agentVariantOptions).mockRejectedValueOnce(new Error('Provider unavailable'));
    await render();
    expect(row('custom-deep')).toBeUndefined();
    await TestRenderer.act(async () => button('Reload variants').props.onPress());
    TestRenderer.act(() => row('custom-deep').props.onPress());
    herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0].capabilities.apiModelSelection = false;
    await TestRenderer.act(async () => button('Apply').props.onPress());
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
  });

  it('reads model-specific variants from the owning live session without changing anything', async () => {
    await render();
    expect(herdrRepository.agentVariantOptions).toHaveBeenCalledWith('agent-a', 'ses_a');
    expect(row('Example Model').props.onPress).toBeUndefined();
    expect(row('high').props.selected).toBe(true);
    expect(row('custom-deep')).toBeDefined();
    expect(button('Apply variant').props.disabled).toBe(true);
    expect(herdrRepository.retuneAgent).not.toHaveBeenCalled();
  });

  it('binds a pending form once session discovery finishes, but never follows a later rotation', async () => {
    const live = herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0];
    live.providerSessionId = null;
    flowDrafts.update(flowId, (draft) => draft.kind === 'agent-settings' ? { ...draft, providerSessionId: null } : draft);
    await render();
    expect(herdrRepository.agentVariantOptions).not.toHaveBeenCalled();
    expect(renderer.root.findByType(FormError).props.message).toContain('Waiting for OpenCode');
    live.providerSessionId = 'ses_discovered';
    await TestRenderer.act(async () => renderer.update(createElement(AgentSettingsPage)));
    expect(herdrRepository.agentVariantOptions).toHaveBeenCalledWith('agent-a', 'ses_discovered');
    expect(flowDrafts.get(flowId)).toMatchObject({ providerSessionId: 'ses_discovered' });
    live.providerSessionId = 'ses_replaced';
    await TestRenderer.act(async () => renderer.update(createElement(AgentSettingsPage)));
    expect(herdrRepository.agentVariantOptions).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType(FormError).props.message).toContain('session has changed');
  });

  it('applies only the exact variant with model and session guards, without restart', async () => {
    await render();
    TestRenderer.act(() => row('custom-deep').props.onPress());
    expect(button('Apply variant').props.disabled).toBe(false);
    const apply = button('Apply variant').props.onPress;
    await TestRenderer.act(async () => { apply(); apply(); });
    expect(herdrRepository.retuneAgent).toHaveBeenCalledTimes(1);
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith({
      agentId: 'agent-a', providerSessionId: 'ses_a', variant: 'custom-deep', modelToken: options.modelToken,
    });
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType(FormPage).props.busy).toBe(true);
  });

  it('clears the override using Default, not a fabricated effort name', async () => {
    await render();
    TestRenderer.act(() => row('Default').props.onPress());
    await TestRenderer.act(async () => button('Apply variant').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledWith(expect.objectContaining({ variant: null }));
  });

  it('surfaces discovery failures and reloads instead of inventing effort choices', async () => {
    jest.mocked(herdrRepository.agentVariantOptions).mockRejectedValueOnce(new Error('Clear the terminal draft first.'));
    await render();
    expect(renderer.root.findByType(FormError).props.message).toBe('Clear the terminal draft first.');
    expect(button('Apply variant').props.disabled).toBe(true);
    await TestRenderer.act(async () => button('Reload variants').props.onPress());
    expect(row('high').props.selected).toBe(true);
  });

  it('retains the draft after a refusal and rejects a changed owning session', async () => {
    await render();
    TestRenderer.act(() => row('low').props.onPress());
    jest.mocked(herdrRepository.retuneAgent).mockRejectedValueOnce(new Error('The OpenCode model changed.'));
    await TestRenderer.act(async () => button('Apply variant').props.onPress());
    expect(row('low').props.selected).toBe(true);
    expect(renderer.root.findByType(FormError).props.message).toContain('model changed');
    herdrRepository.getSnapshot().devices['device-a'].runtime.agents[0].providerSessionId = 'ses_replaced';
    await TestRenderer.act(async () => button('Apply variant').props.onPress());
    expect(herdrRepository.retuneAgent).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType(FormError).props.message).toContain('session has changed');
  });

  it('validates arbitrary variant names without confusing them with portable efforts', () => {
    expect(agentVariantOptionsSchema.parse(options).variants).toContain('custom-deep');
    expect(agentVariantOptionsSchema.safeParse({ ...options, variants: ['high', 'high'] }).success).toBe(false);
    expect(agentVariantOptionsSchema.safeParse({ ...options, variants: ['high', 'bad\nname'] }).success).toBe(false);
    expect(agentVariantOptionsSchema.safeParse({ ...options, currentVariant: 'unknown' }).success).toBe(false);
  });
});
