import type { Stack } from 'expo-router';
import type { ComponentProps } from 'react';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Header and content options every pushed stack shares.
 *
 * Transparent throughout, so the canvas gradient behind the navigator shows
 * through and never restarts per route — see `DESIGN.md`.
 */
type ScreenOptions = ComponentProps<typeof Stack>['screenOptions'];

export function useStackScreenOptions(): ScreenOptions {
  const theme = useTheme();

  return {
    headerStyle: { backgroundColor: 'transparent' },
    headerTintColor: theme.text,
    headerTitleStyle: { fontSize: 15, fontWeight: '600', fontFamily: Fonts.semibold },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: 'transparent' },
  };
}
