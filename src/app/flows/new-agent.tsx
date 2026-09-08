import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { ThemedText } from '@/components/themed-text';
import { AnimatedDisclosure } from '@/components/ui/animated-disclosure';
import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { modelLabel, supportsTuning } from '@/domain/agent-catalogue';
import { providerLabel } from '@/domain/herdr';
import { agentCreationError, agentCreationInput } from '@/features/agents/creation-flow';
import { TuningFields } from '@/features/agents/tuning-fields';
import { useHerdr } from '@/features/agents/use-herdr';
import { selectWorkspace } from '@/features/agents/workspace-selection';
import { useHostSession } from '@/features/connection/use-host-session';
import { flowDrafts, useFlowDraft, type NewAgentDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { useTheme } from '@/hooks/use-theme';
import { Spacing } from '@/constants/theme';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function NewAgentPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  if (!flowId || draft?.kind !== 'new-agent') return <MissingFlow title="New Agent" />;
  return <NewAgentForm flowId={flowId} draft={draft} />;
}

function NewAgentForm({ flowId, draft }: { flowId: string; draft: NewAgentDraft }) {
  const focused = useIsFocused();
  const theme = useTheme();
  const { devices } = useHerdr();
  const { hosts } = useHosts();
  const session = useHostSession(draft.deviceId);
  const device = devices[draft.deviceId];
  const [advanced, setAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const navigating = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useFocusEffect(useCallback(() => { navigating.current = false; }, []));

  const validation = agentCreationError(draft, device) ??
    (session?.status !== 'connected' ? 'This device is not connected. Your draft is kept while it reconnects.' : null);
  const space = device?.runtime.workspaces.find((item) =>
    item.id === draft.workspaceId && (!item.deviceId || item.deviceId === draft.deviceId),
  );
  const tunable = supportsTuning(draft.provider);

  function update(change: (current: NewAgentDraft) => NewAgentDraft) {
    if (submitting.current) return;
    setError(null);
    flowDrafts.update(flowId, (current) => current.kind === 'new-agent' ? change(current) : current);
  }

  function choose(pathname: '/flows/devices' | '/flows/spaces' | '/flows/providers' | '/flows/models') {
    if (submitting.current || navigating.current) return;
    navigating.current = true;
    router.push({ pathname, params: { flowId } });
  }

  async function create() {
    if (submitting.current) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-agent') return;
    const invalid = agentCreationError(current, herdrRepository.getSnapshot().devices[current.deviceId]);
    if (invalid) { setError(invalid); return; }
    submitting.current = true;
    setCreating(true);
    setError(null);
    try {
      if (remoteClient.getSession(current.deviceId)?.status !== 'connected') {
        throw new Error('This device is not connected. Reconnect before starting the agent.');
      }
      const result = await herdrRepository.createAgent(agentCreationInput(current), current.deviceId);
      herdrRepository.selectDevice(current.deviceId);
      selectWorkspace(current.deviceId, current.workspaceId);
      const shouldNavigate = mounted.current;
      if (shouldNavigate) {
        if (result.agentId) router.replace({ pathname: '/agents/[id]', params: { id: result.agentId } });
        else router.dismissTo('/');
      }
    } catch (cause) {
      submitting.current = false;
      if (mounted.current) {
        setError(toUserMessage(cause));
        setCreating(false);
      }
    }
  }

  return (
    <FormPage title="New Agent" busy={creating} footer={
      <>
        <FormError message={error ?? validation} />
        <AppButton label={creating ? 'Starting agent…' : 'Start agent'} disabled={creating || !!validation} onPress={() => void create()} />
      </>
    }>
      <TextField label="Name (optional)" value={draft.name} onChangeText={(name) => update((current) => ({ ...current, name }))}
        placeholder="What is this agent for?" autoCapitalize="sentences" editable={!creating} returnKeyType="done" />
      <FormSection>
        <SelectionRow label="Device" value={hosts.find((host) => host.id === draft.deviceId)?.name ?? draft.deviceId}
          disabled={creating} onPress={() => choose('/flows/devices')} />
        <SelectionRow label="Space" value={space?.name ?? 'Choose a space'} description={space?.cwd ?? undefined}
          disabled={creating} onPress={() => choose('/flows/spaces')} />
        <SelectionRow label="Provider" value={providerLabel(draft.provider)}
          disabled={creating} onPress={() => choose('/flows/providers')} />
        <SelectionRow label="Model" value={modelLabel(draft.provider, draft.tuning.model)}
          description={tunable ? undefined : 'Managed by this provider'}
          disabled={creating || !tunable} onPress={() => choose('/flows/models')} />
      </FormSection>
      <View>
      <FormSection>
        <SelectionRow label="Advanced options" value={advanced ? 'Hide' : 'Show'} disabled={creating}
          onPress={() => setAdvanced((value) => !value)} />
      </FormSection>
      <AnimatedDisclosure open={advanced} active={focused} testID="advanced-options-disclosure">
        <View style={{ paddingTop: Spacing.three, gap: Spacing.three }}>
          {draft.provider === 'opencode' ? (
            <ThemedText type="small" themeColor="textSecondary">
              Choose reasoning variants from Model Settings after the agent starts.
            </ThemedText>
          ) : null}
          {tunable ? <View pointerEvents={creating ? 'none' : 'auto'}>
            <TuningFields provider={draft.provider} value={draft.tuning} showModel={false}
              onChooseModel={() => choose('/flows/models')} onChange={(tuning) => update((current) => ({ ...current, tuning }))} />
          </View> : null}
          <FormSection>
            <SelectionRow label="Allow tools automatically" description="Apply the provider's bypass-permissions flag."
              accessory={<Switch accessibilityLabel="Allow tools automatically" value={draft.bypassPermissions} disabled={creating}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor={draft.bypassPermissions ? theme.onAccent : theme.textMuted}
                onValueChange={(bypassPermissions) => update((current) => ({ ...current, bypassPermissions }))} />} />
          </FormSection>
        </View>
      </AnimatedDisclosure>
      </View>
    </FormPage>
  );
}
