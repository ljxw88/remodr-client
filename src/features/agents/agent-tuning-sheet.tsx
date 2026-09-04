import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { SheetModal, SheetPanel } from '@/components/ui/sheet';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { RemoteAgent } from '@/domain/herdr';
import type { Tuning } from '@/domain/agent-catalogue';
import { AgentTuningPicker } from '@/features/agents/agent-tuning-picker';
import { useDockContentInset } from '@/features/navigation/floating-dock';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  agent: RemoteAgent;
  onClose: () => void;
};

/**
 * Retune a running agent.
 *
 * A model can be swapped without interrupting anything. Reasoning effort and
 * context window are only read when the CLI starts, so changing either one
 * restarts it — on the same session, so the conversation carries over, but the
 * agent stops whatever it was doing. That is worth saying before it happens.
 */
export function AgentTuningSheet({ agent, onClose }: Props) {
  /**
   * What the agent was running when this opened, held still while it is.
   *
   * The runtime keeps polling underneath, so read fresh this would shift
   * mid-edit — and a shift that happened to match the pending choice would
   * quietly turn Apply off and make the whole edit a no-op.
   */
  const [current] = useState<Tuning>(() => ({
    model: agent.tuning?.model ?? null,
    effort: agent.tuning?.effort ?? null,
    context: agent.tuning?.context ?? null,
  }));
  const [tuning, setTuning] = useState<Tuning>(current);
  const [busy, setBusy] = useState(false);
  const dockContentInset = useDockContentInset();
  const [error, setError] = useState<string | null>(null);

  const restarts =
    tuning.effort !== current.effort || tuning.context !== current.context;
  const changed = restarts || tuning.model !== current.model;

  async function apply(done: () => void) {
    if (!changed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await herdrRepository.retuneAgent({ agentId: agent.id, ...tuning });
      done();
    } catch (cause) {
      setError(toUserMessage(cause));
      setBusy(false);
    }
  }

  return (
    <SheetModal closeLabel="Close model options" onClose={onClose} busy={busy}>
      {(close) => (
        <SheetPanel onClose={close} busy={busy}>
          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: dockContentInset }]}
            showsVerticalScrollIndicator={false}>
            <AgentTuningPicker
              provider={agent.provider}
              value={tuning}
              onChange={setTuning}
            />

            {restarts ? (
              <ThemedText type="caption" themeColor="textMuted">
                Reasoning and context are only read when the agent starts, so
                this restarts it. The conversation is kept.
              </ThemedText>
            ) : null}

            <AppButton
              label={restarts ? 'Apply and restart' : 'Apply'}
              onPress={() => void apply(close)}
              disabled={!changed || busy}
            />

            {error ? (
              <ThemedText type="caption" themeColor="danger">
                {error}
              </ThemedText>
            ) : null}
          </ScrollView>
        </SheetPanel>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.two,
    padding: Spacing.two,
  },
});
