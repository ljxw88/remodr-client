import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import { catalogueUnavailableReason, modelLabel } from '@/domain/agent-catalogue';
import { chooseModel, modelChoices } from '@/features/agents/agent-edit-flow';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { OpenCodeModelPicker } from '@/features/agents/opencode-model-picker';

export default function ModelsPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const [query, setQuery] = useState('');
  const leaving = useRef(false);
  const insets = useSafeAreaInsets();
  if (!flowId || !draft || (draft.kind !== 'new-agent' && draft.kind !== 'agent-settings')) {
    return <MissingFlow title="Models Unavailable" />;
  }
  if (draft.provider === 'opencode') {
    return <OpenCodeModelPicker flowId={flowId} draft={draft} />;
  }

  const choices = modelChoices(
    draft.provider,
    draft.tuning.model,
    query,
    draft.kind === 'agent-settings' ? draft.initialTuning.model : undefined,
  );

  function select(model: string | null) {
    if (leaving.current || !flowId) return;
    const current = flowDrafts.get(flowId);
    if (!current || (current.kind !== 'new-agent' && current.kind !== 'agent-settings')) return;
    leaving.current = true;
    flowDrafts.update(flowId, (value) =>
      value.kind === 'new-agent' || value.kind === 'agent-settings'
        ? { ...value, tuning: chooseModel(value.provider, model, value.tuning) }
        : value,
    );
    router.back();
  }

  return (
    <FormPage title="Choose Model" scroll={false}>
      <TextField
        label="Search models"
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name"
        returnKeyType="search"
      />
      <ThemedText testID="current-model" type="caption" themeColor="textMuted">
        Current: {modelLabel(draft.provider, draft.tuning.model)}
      </ThemedText>
      {catalogueUnavailableReason(draft.provider) ? (
        <ThemedText type="small" themeColor="textMuted">
          {catalogueUnavailableReason(draft.provider)} Auto uses the remote CLI defaults.
        </ThemedText>
      ) : null}
      <FormSection fill>
        <FlatList
          style={styles.list}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, Spacing.two) }}
          data={choices}
          keyExtractor={(choice) => choice.model == null ? 'auto' : `model:${choice.model}`}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <SelectionRow
              label={item.label}
              description={item.description}
              selected={draft.tuning.model === item.model}
              onPress={() => select(item.model)}
            />
          )}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textMuted" style={styles.empty}>
              No models match this search.
            </ThemedText>
          }
        />
      </FormSection>
    </FormPage>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  empty: { padding: Spacing.two },
});
