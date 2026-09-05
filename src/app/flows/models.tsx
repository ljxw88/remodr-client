import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { FormPage, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { chooseModel, modelChoices } from '@/features/agents/agent-edit-flow';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';

export default function ModelsPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const [query, setQuery] = useState('');
  const leaving = useRef(false);
  const insets = useSafeAreaInsets();
  if (!flowId || !draft || (draft.kind !== 'new-agent' && draft.kind !== 'agent-settings')) {
    return <MissingFlow title="Models unavailable" />;
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
    <FormPage title="Choose model" scroll={false}>
      <TextField
        label="Search models"
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name"
        returnKeyType="search"
      />
      <FlatList
        style={styles.list}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, Spacing.two) }}
        data={choices}
        keyExtractor={(choice) => choice.model == null ? 'auto' : `model:${choice.model}`}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => (
          <View style={styles.row}>
            <SelectionRow
              label={item.label}
              description={item.description}
              selected={draft.tuning.model === item.model}
              onPress={() => select(item.model)}
            />
          </View>
        )}
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textMuted">No models match this search.</ThemedText>
        }
      />
    </FormPage>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  row: { backgroundColor: Colors.backgroundElement, borderRadius: Radius.control, overflow: 'hidden' },
});
