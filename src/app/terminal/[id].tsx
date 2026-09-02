import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { RemoteCoreView as TerminalView } from '../../../modules/remote-core';

const KEYS = [
  { label: 'Esc', value: '\u001b' },
  { label: 'Tab', value: '\t' },
  { label: 'Ctrl+C', value: '\u0003' },
  { label: 'Ctrl+D', value: '\u0004' },
  { label: 'Ctrl+Z', value: '\u001a' },
  { label: '↑', value: '\u001b[A' },
  { label: '↓', value: '\u001b[B' },
  { label: '←', value: '\u001b[D' },
  { label: '→', value: '\u001b[C' },
];

export default function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    void (async () => {
      try {
        const next = await remoteClient.openPty(session.sessionId, 80, 24);
        if (active) {
          setPtyId(next);
        } else {
          await remoteClient.closePty(next);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Could not open terminal');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    return () => {
      if (ptyId) {
        void remoteClient.closePty(ptyId);
      }
    };
  }, [ptyId]);

  if (!session) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Terminal' }} />
        <ThemedText>Connect to this host first.</ThemedText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Terminal' }} />
      {error ? <ThemedText>{error}</ThemedText> : null}
      <View style={styles.term}>
        {ptyId ? <TerminalView ptyId={ptyId} cols={80} rows={24} style={styles.view} /> : null}
      </View>
      <View style={styles.keys}>
        {KEYS.map((key) => (
          <Pressable
            key={key.label}
            accessibilityRole="button"
            accessibilityLabel={key.label}
            onPress={() => {
              if (ptyId) {
                void remoteClient.writePty(ptyId, key.value);
              }
            }}
            style={[styles.key, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
            <ThemedText type="caption">{key.label}</ThemedText>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  term: {
    flex: 1,
    minHeight: 240,
    overflow: 'hidden',
  },
  view: {
    flex: 1,
  },
  keys: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
  },
  key: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
