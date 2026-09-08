import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import type { OpenCodeModels } from '@/domain/opencode-models';
import { flowDrafts, type NewAgentDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';
import { chooseModel, type ModelChoice } from './agent-edit-flow';
import { useHerdr } from './use-herdr';

export function OpenCodeModelPicker({ flowId, draft }: { flowId: string; draft: NewAgentDraft }) {
  const { devices } = useHerdr();
  const device = devices[draft.deviceId];
  const workspace = device?.runtime.workspaces.find((space) =>
    space.id === draft.workspaceId && (!space.deviceId || space.deviceId === draft.deviceId),
  );
  const unavailable = device?.connection !== 'connected' ? 'Connect this device to fetch its OpenCode models.'
    : !workspace?.cwd ? 'Choose an available space before fetching OpenCode models.' : null;
  return <ScopedModelPicker key={JSON.stringify([flowId, draft.deviceId, draft.workspaceId, workspace?.cwd, unavailable])}
    flowId={flowId} draft={draft} cwd={workspace?.cwd ?? null}
    unavailable={unavailable} />;
}

function ScopedModelPicker({ flowId, draft, cwd, unavailable }: {
  flowId: string; draft: NewAgentDraft; cwd: string | null; unavailable: string | null;
}) {
  const [catalogue, setCatalogue] = useState<OpenCodeModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(!unavailable);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const leaving = useRef(false);
  const insets = useSafeAreaInsets();
  const { deviceId, workspaceId } = draft;

  useEffect(() => {
    let cancelled = false;
    if (unavailable) return;
    void herdrRepository.openCodeModels(deviceId, workspaceId, revision > 0).then((result) => {
      if (cancelled) return;
      setCatalogue(result);
      const current = flowDrafts.get(flowId);
      if (cwd && current?.kind === 'new-agent' && current.provider === 'opencode'
        && current.deviceId === deviceId && current.workspaceId === workspaceId && current.tuning.model) {
        const model = current.tuning.model;
        flowDrafts.update(flowId, (value) => value.kind === 'new-agent' ? {
          ...value, modelAvailability: { deviceId, workspaceId, cwd, model, available: result.models.includes(model) },
        } : value);
      }
    }).catch((cause) => {
      if (!cancelled) setError(toUserMessage(cause));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [deviceId, workspaceId, unavailable, revision, flowId, cwd]);

  function refresh() {
    if (busy || unavailable) return;
    setBusy(true);
    setCatalogue(null);
    setError(null);
    setRevision((value) => value + 1);
  }

  function select(model: string | null) {
    if (leaving.current) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-agent' || current.provider !== 'opencode'
      || current.deviceId !== deviceId || current.workspaceId !== workspaceId) {
      setError('This form changed. Reopen the model picker.');
      return;
    }
    if (model !== null) {
      const live = herdrRepository.getSnapshot().devices[deviceId];
      if (busy || unavailable || error || !catalogue?.models.includes(model)
        || live?.connection !== 'connected'
        || !live.runtime.workspaces.some((space) => space.id === workspaceId && space.cwd === cwd
          && (!space.deviceId || space.deviceId === deviceId))) {
        setError('Fetch models for the current device and space before selecting one.');
        return;
      }
    }
    leaving.current = true;
    flowDrafts.update(flowId, (value) => value.kind === 'new-agent'
      ? { ...value, tuning: chooseModel('opencode', model, value.tuning), modelAvailability: undefined } : value);
    router.back();
  }

  const models = catalogue?.models ?? [];
  const selectedModel = draft.tuning.model;
  const choices: ModelChoice[] = [
    { model: null, label: 'Auto', description: "Use OpenCode's default model on this server." },
    ...(selectedModel && !models.includes(selectedModel) ? [{
      model: selectedModel, label: selectedModel,
      description: catalogue ? 'Selected model · not available in this fetched list' : 'Selected model · not yet fetched',
    }] : []),
    ...models.map((model) => ({ model, label: model })),
  ];
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = choices.filter((choice) => terms.every((term) => choice.label.toLowerCase().includes(term)));

  return (
    <FormPage title="Choose Model" scroll={false}>
      <TextField label="Search models" value={query} onChangeText={setQuery} placeholder="Search by provider or model"
        returnKeyType="search" />
      <ThemedText testID="current-model" type="caption" themeColor="textMuted">
        Current: {draft.tuning.model ?? 'Auto'}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Models come from this space&apos;s OpenCode configuration on the selected server.
        Account permissions, quota and provider limits still apply. OpenCode may use cached metadata if refresh is unavailable.
      </ThemedText>
      <AppButton label={busy ? 'Fetching models…' : 'Refresh from server'} variant="secondary"
        disabled={busy || !!unavailable} onPress={refresh} />
      <FormError message={unavailable ?? error} />
      {catalogue ? <ThemedText type="caption" themeColor="textMuted">
        {models.length === 0 ? 'No models available. Connect a provider with /connect in OpenCode, then refresh.'
          : `${models.length} models fetched from this server`}
      </ThemedText> : null}
      <FormSection fill>
        <FlatList style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, Spacing.two) }}
          data={filtered} keyExtractor={(choice) => choice.model ?? 'auto'}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
          renderItem={({ item }) => <SelectionRow label={item.label} description={item.description}
            selected={draft.tuning.model === item.model}
            disabled={item.model !== null && (busy || !!unavailable || !!error || !models.includes(item.model))}
            onPress={() => select(item.model)} />}
          ListEmptyComponent={<ThemedText type="small" themeColor="textMuted">No models match this search.</ThemedText>} />
      </FormSection>
    </FormPage>
  );
}
