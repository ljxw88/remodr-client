import { Stack } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

export default function HostsLayout() {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: 'transparent' },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: 600, fontFamily: 'Inter_600SemiBold' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}>
      <Stack.Screen name="new" options={{ title: 'Add server' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Server' }} />
      <Stack.Screen name="[id]/edit" options={{ title: 'Edit server' }} />
    </Stack>
  );
}
