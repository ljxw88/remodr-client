import { Stack } from 'expo-router';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';

/**
 * What a server tool shows before its SSH session exists. Every tool screen
 * needs the same thing, and the title has to be set here too because the
 * screen returns before rendering its own.
 */
export function NeedsSession({ title }: { title: string }) {
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <ThemedText>Connect to this host first.</ThemedText>
    </Screen>
  );
}
