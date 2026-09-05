import { supportsTuning, tuningForModel } from '@/domain/agent-catalogue';
import {
  createAgentInputSchema,
  launchableAgentProviderSchema,
  type CreateAgentInput,
  type LaunchableAgentProvider,
} from '@/domain/herdr';
import { flowDrafts, type NewAgentDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import type { DeviceRuntimeState } from '@/services/herdr-repository';

function firstProvider(device: DeviceRuntimeState): LaunchableAgentProvider {
  return launchableAgentProviderSchema.options.find((provider) =>
    device.runtime.providers.some((manifest) => manifest.provider === provider && manifest.available),
  ) ?? 'copilot';
}

export function newAgentDraft(device: DeviceRuntimeState, initialSpaceId?: string | null): NewAgentDraft {
  const spaces = device.runtime.workspaces.filter((space) => !space.deviceId || space.deviceId === device.deviceId);
  const provider = firstProvider(device);
  return {
    kind: 'new-agent',
    deviceId: device.deviceId,
    name: '',
    workspaceId: spaces.find((space) => space.id === initialSpaceId)?.id ?? spaces[0]?.id ?? '',
    provider,
    tuning: tuningForModel(provider, null, { model: null, effort: null, context: null }),
    bypassPermissions: true,
  };
}

export function beginNewAgentFlow(device: DeviceRuntimeState, initialSpaceId?: string | null): string {
  return flowDrafts.create(newAgentDraft(device, initialSpaceId));
}

export function beginNewSpaceFlow(deviceId: string): string {
  return flowDrafts.create({ kind: 'new-space', deviceId, label: '', cwd: '~/' });
}

export function agentDraftForProvider(draft: NewAgentDraft, provider: LaunchableAgentProvider): NewAgentDraft {
  if (provider === draft.provider) return draft;
  return { ...draft, provider, tuning: tuningForModel(provider, null, draft.tuning) };
}

export function agentDraftForDevice(draft: NewAgentDraft, device: DeviceRuntimeState): NewAgentDraft {
  if (device.deviceId === draft.deviceId) return draft;
  const defaults = newAgentDraft(device);
  const provider = device.runtime.providers.some((item) => item.provider === draft.provider && item.available)
    ? draft.provider : defaults.provider;
  // Workspace IDs and account/model availability are scoped to the owning host.
  return { ...draft, deviceId: device.deviceId, workspaceId: defaults.workspaceId, provider, tuning: defaults.tuning };
}

export function spaceDraftForDevice(draft: NewSpaceDraft, deviceId: string): NewSpaceDraft {
  return draft.deviceId === deviceId ? draft : { ...draft, deviceId, cwd: '~/' };
}

export function agentCreationInput(draft: NewAgentDraft): CreateAgentInput {
  const tunable = supportsTuning(draft.provider);
  return createAgentInputSchema.parse({
    provider: draft.provider,
    workspaceId: draft.workspaceId,
    bypassPermissions: draft.bypassPermissions,
    name: draft.name.trim() || undefined,
    model: (tunable && draft.tuning.model) || undefined,
    effort: (tunable && draft.tuning.effort) || undefined,
    context: (tunable && draft.tuning.context) || undefined,
  });
}

export function agentCreationError(draft: NewAgentDraft, device: DeviceRuntimeState | undefined): string | null {
  if (!device || device.deviceId !== draft.deviceId) return 'This device is no longer available. Choose another device.';
  if (device.connection !== 'connected') return 'This device is not connected. Your draft is kept while it reconnects.';
  if (!device.runtime.workspaces.some((space) =>
    space.id === draft.workspaceId && (!space.deviceId || space.deviceId === draft.deviceId),
  )) return 'Choose an available space on this device.';
  const provider = device.runtime.providers.find((manifest) => manifest.provider === draft.provider);
  if (!provider?.available) return provider?.unavailableReason || 'This provider is unavailable on this device. Choose another provider.';
  if (draft.name.trim().length > 60) return 'Agent names must be 60 characters or fewer.';
  return null;
}
