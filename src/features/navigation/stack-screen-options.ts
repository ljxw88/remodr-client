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
export type StackNavigation = Parameters<
  NonNullable<ComponentProps<typeof Stack>['layout']>
>[0]['descriptors'][string]['navigation'];

export function useStackScreenOptions(): ScreenOptions {
  const theme = useTheme();

  return {
    headerStyle: { backgroundColor: 'transparent' },
    headerTintColor: theme.text,
    headerTitleStyle: { fontSize: 15, fontWeight: '600', fontFamily: Fonts.semibold },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: 'transparent' },
    /**
     * A push replaces what it covers outright, with no transition.
     *
     * This is what the dock already does. Switching tabs swaps the content and
     * settles it; there is never a second screen on the way in or out, so
     * there is nothing to see through and nothing to wait for. A push should
     * not feel like a longer journey than that — it is the same act, opening
     * the thing you tapped.
     *
     * The alternatives all cost something. Android's default and `fade`
     * cross-dissolve, which draws both screens over each other: our routes
     * share a canvas and sit at the same brightness, so that reads as the
     * screen being left refusing to go. `slide_from_right` and
     * `ios_from_right` avoid that by never putting the two in the same place,
     * but they take 400ms and 200ms, and neither can be shortened from here —
     * `animationDuration` is iOS-only, and react-native-screens' Android
     * `setTransitionDuration` is `= Unit`, so each preset's fixed animation
     * resource decides.
     *
     * Note this is not what made a dismissed chat throw its transcript away.
     * Even with no animation, native teardown can outlive the blur target.
     * `RouteStack` cuts its native root before child disposal to prevent that
     * partial frame — see `components/ui/blur-backdrop.tsx`.
     */
    animation: 'none',
  };
}
