import { Stack } from 'expo-router';

import { RouteStack } from '@/features/navigation/route-stack';

export default function HostsLayout() {
  return (
    <RouteStack>
      <Stack.Screen name="new" options={{ title: 'Add server' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Server' }} />
      <Stack.Screen name="[id]/edit" options={{ title: 'Edit server' }} />
    </RouteStack>
  );
}
