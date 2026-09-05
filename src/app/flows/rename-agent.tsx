import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, MissingFlow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { agentEditError, renameError } from '@/features/agents/agent-edit-flow';
import { useHerdr } from '@/features/agents/use-herdr';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function RenameAgentPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const { devices } = useHerdr();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (!flowId || !draft || draft.kind !== 'rename-agent') {
    return <MissingFlow title="Rename Unavailable" />;
  }
  const availabilityError = agentEditError(devices, draft);
  const validationError = renameError(draft.name, draft.initialName);

  async function save() {
    if (busyRef.current) return;
    const current = flowDrafts.get(flowId);
    if (!current || current.kind !== 'rename-agent') return;
    const invalid = renameError(current.name, current.initialName);
    const unavailable = agentEditError(herdrRepository.getSnapshot().devices, current);
    if (invalid || unavailable) { setError(invalid ?? unavailable); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await herdrRepository.renameAgent(current.agentId, current.name.trim());
      if (mounted.current) router.back();
    } catch (cause) {
      if (!mounted.current) return;
      busyRef.current = false;
      setBusy(false);
      setError(toUserMessage(cause));
    }
  }

  return (
    <FormPage
      title="Rename Agent"
      busy={busy}
      footer={
        <>
          <FormError message={error ?? availabilityError} />
          <AppButton
            label={busy ? 'Saving…' : 'Save name'}
            disabled={busy || !!validationError || !!availabilityError}
            onPress={() => void save()}
          />
        </>
      }>
      <TextField
        label="Name"
        value={draft.name}
        placeholder="What is this agent for?"
        autoCapitalize="sentences"
        autoFocus
        selectTextOnFocus
        editable={!busy}
        returnKeyType="done"
        maxLength={60}
        error={draft.name !== draft.initialName ? validationError ?? undefined : undefined}
        onSubmitEditing={() => void save()}
        onChangeText={(name) => {
          if (busyRef.current) return;
          setError(null);
          flowDrafts.update(flowId, (current) =>
            current.kind === 'rename-agent' ? { ...current, name } : current,
          );
        }}
      />
    </FormPage>
  );
}
