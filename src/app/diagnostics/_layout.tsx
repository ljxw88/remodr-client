import { Stack } from 'expo-router';

import { RouteStack } from '@/features/navigation/route-stack';

export default function DiagnosticsLayout() {
  return (
    <RouteStack>
      <Stack.Screen name="index" options={{ title: 'Diagnostics' }} />
    </RouteStack>
  );
}
