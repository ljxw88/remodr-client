import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { SheetHeader, SheetModal, SheetPanel } from '@/components/ui/sheet';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { RemoteAgent } from '@/domain/herdr';
import { useDockContentInset } from '@/features/navigation/floating-dock';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  agent: RemoteAgent;
  onClose: () => void;
  /** Called once the agent is gone, so the screen showing it can leave. */
  onClosed: () => void;
};

/**
 * Rename or close a single agent.
 *
 * Renaming is the important half. A new agent arrives called after the CLI
 * that runs it, so a list of them reads as the same name repeated, and the one
 * just started cannot be picked out. The name given here is the agent's title
 * everywhere it appears.
 */
export function AgentActionsSheet({ agent, onClose, onClosed }: Props) {
  const theme = useTheme();
  const dockContentInset = useDockContentInset();
  const [name, setName] = useState(agent.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canRename = trimmed.length > 0 && trimmed !== agent.title && !busy;

  async function rename(done: () => void) {
    if (!canRename) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await herdrRepository.renameAgent(agent.id, trimmed);
      done();
    } catch (cause) {
      setError(toUserMessage(cause));
      setBusy(false);
    }
  }

  function confirmClose(done: () => void) {
    Alert.alert(
      'Close this agent?',
      `${agent.title} will stop, and its conversation will no longer be reachable.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Close agent',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(null);
            herdrRepository
              .closeAgent(agent.id)
              .then(() => {
                done();
                onClosed();
              })
              .catch((cause: unknown) => {
                setError(toUserMessage(cause));
                setBusy(false);
              });
          },
        },
      ],
    );
  }

  return (
    <SheetModal closeLabel="Close agent options" onClose={onClose} busy={busy} avoidKeyboard>
      {(close) => (
        <SheetPanel>
          <ScrollView
            contentContainerStyle={[
              styles.content,
              { paddingBottom: dockContentInset },
            ]}
            showsVerticalScrollIndicator={false}>
            <SheetHeader
              title="Agent"
              subtitle="Rename it so you can find it again, or close it for good."
              onClose={close}
              busy={busy}
            />

            <TextField
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="What is this agent for?"
              autoCapitalize="sentences"
            />

            <AppButton
              label="Save name"
              onPress={() => void rename(close)}
              disabled={!canRename}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close this agent"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => confirmClose(close)}
              style={({ pressed }) => [
                styles.danger,
                {
                  borderColor: theme.danger,
                  opacity: busy ? 0.4 : pressed ? 0.72 : 1,
                },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.danger }}>
                Close agent
              </ThemedText>
            </Pressable>

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
  danger: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: Radius.control,
  },
});
