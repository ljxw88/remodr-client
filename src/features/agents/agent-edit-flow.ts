import {
  modelLabel,
  modelsFor,
  tuningForModel,
  type Tuning,
} from '@/domain/agent-catalogue';
import type { AgentProvider, RemoteAgent } from '@/domain/herdr';
import {
  flowDrafts,
  type AgentSettingsDraft,
  type RenameAgentDraft,
} from '@/features/forms/flow-drafts';
import { herdrRepository, type DeviceRuntimeState } from '@/services/herdr-repository';

function deviceFor(agent: RemoteAgent): string {
  const deviceId = agent.deviceId || herdrRepository.deviceIdForAgent(agent.id);
  if (!deviceId) throw new Error('This agent no longer belongs to an available device.');
  return deviceId;
}

export function beginAgentSettingsFlow(agent: RemoteAgent): string {
  const initialTuning = Object.freeze({
    model: agent.tuning?.model ?? null,
    effort: agent.tuning?.effort ?? null,
    context: agent.tuning?.context ?? null,
  });
  return flowDrafts.create({
    kind: 'agent-settings',
    deviceId: deviceFor(agent),
    agentId: agent.id,
    provider: agent.provider,
    providerSessionId: agent.providerSessionId,
    initialTuning,
    tuning: { ...initialTuning },
  });
}

export function beginRenameAgentFlow(agent: RemoteAgent): string {
  return flowDrafts.create({
    kind: 'rename-agent',
    deviceId: deviceFor(agent),
    agentId: agent.id,
    provider: agent.provider,
    providerSessionId: agent.providerSessionId,
    initialName: agent.title,
    name: agent.title,
  });
}

export function agentEditError(
  devices: Record<string, DeviceRuntimeState>,
  draft: AgentSettingsDraft | RenameAgentDraft,
): string | null {
  const device = devices[draft.deviceId];
  if (!device) return 'This device is no longer available. Your changes have not been applied.';
  if (device.connection !== 'connected') {
    return 'Reconnect this agent’s device before saving. Your changes are kept here.';
  }
  const agent = device.runtime.agents.find((item) => item.id === draft.agentId);
  if (!agent) return 'This agent is no longer available. Your changes have not been applied.';
  if (draft.provider && agent.provider !== draft.provider) {
    return 'This agent’s provider has changed. Go back and open a new form.';
  }
  if (draft.providerSessionId != null && agent.providerSessionId !== draft.providerSessionId) {
    return 'This agent’s session has changed. Go back and open a new form.';
  }
  return null;
}

export function tuningChanges(initial: Tuning, next: Tuning) {
  const restarts = initial.effort !== next.effort || initial.context !== next.context;
  return { changed: restarts || initial.model !== next.model, restarts };
}

export function renameError(name: string, initialName: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for this agent.';
  if (trimmed.length > 60) return 'Use 60 characters or fewer.';
  if (trimmed === initialName.trim()) return 'Choose a different name.';
  return null;
}

export type ModelChoice = {
  model: string | null;
  label: string;
  description?: string;
};

export function modelChoices(
  provider: AgentProvider,
  selectedModel: string | null,
  query = '',
  runningModel?: string | null,
): ModelChoice[] {
  const known = modelsFor(provider);
  const extras = [...new Set([runningModel, selectedModel])].filter(
    (model): model is string =>
      model != null && !known.some((option) => option.id === model),
  );
  const choices: ModelChoice[] = [
    { model: null, label: 'Auto', description: 'Let the agent choose its model.' },
    ...extras.map((model) => ({
      model,
      label: modelLabel(provider, model),
      description: model === runningModel
        ? 'Currently running · not in this app’s catalogue'
        : 'Selected model · not in this app’s catalogue',
    })),
    ...known.map((model) => ({ model: model.id, label: model.label })),
  ];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter((choice) => {
    const text = `${choice.label} ${choice.model ?? ''}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function chooseModel(provider: AgentProvider, model: string | null, previous: Tuning): Tuning {
  // Selecting the same row is not a model change: preserve off-catalogue settings.
  return previous.model === model ? previous : tuningForModel(provider, model, previous);
}
