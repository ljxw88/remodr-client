import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';

export default function HostsLayout() {
  return (
    <Stack screenOptions={useStackScreenOptions()}>
      <Stack.Screen name="new" options={{ title: 'Add server' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Server' }} />
      <Stack.Screen name="[id]/edit" options={{ title: 'Edit server' }} />
    </Stack>
  );
}
