import { Stack } from 'expo-router';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function AgentsLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: 'transparent' },
        headerTintColor: theme.text,
        headerTitleStyle: { fontSize: 15, fontWeight: 600, fontFamily: Fonts.semibold },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}
