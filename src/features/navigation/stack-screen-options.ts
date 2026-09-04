import type { Stack } from 'expo-router';
import type { ComponentProps } from 'react';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Header, content and motion options every stack in the app shares.
 *
 * The headers are transparent so the route's own canvas shows through them.
 * The routes themselves are not: see `components/ui/screen.tsx`.
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
    /**
     * A push slides in over what it replaces, rather than dissolving into it.
     *
     * Android's default here is a cross-fade, which needs one of the two
     * routes to be hiding the other to read as a change of place. Ours sit on
     * a shared canvas and are the same brightness, so a dissolve looked like
     * one screen refusing to leave: the outgoing header and buttons stayed
     * legible over the arriving screen for the length of the animation. A
     * slide never puts both in the same place at once.
     */
    animation: 'slide_from_right',
  };
}
