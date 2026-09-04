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
     *
     * This is the only lever on how long that takes. `animationDuration` is an
     * iOS-only option: react-native-screens hands Android a fixed XML resource
     * per preset, so the duration is whatever that file says and nothing in JS
     * can move it. The presets that keep one screen covering the other are
     * `slide_from_right` at `config_mediumAnimTime` (400ms), this one at
     * `config_shortAnimTime` (200ms), and `none` at 20ms. We take the middle:
     * half the wait, still long enough to read as a slide rather than a cut.
     *
     * `ios_from_right` also drifts the outgoing screen 30% to the left instead
     * of pushing it a full width off, so the two move together and the arrival
     * has somewhere to come from. Both halves are pure translations, no alpha,
     * so the seam stays opaque.
     *
     * None of this is what makes content disappear on the way out. Every
     * animation, the default included, stops a blur target drawing while its
     * screen is dismissed — see `components/ui/blur-backdrop.tsx`.
     */
    animation: 'ios_from_right',
  };
}
