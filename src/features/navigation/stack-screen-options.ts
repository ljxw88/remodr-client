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
     * How long it takes is set natively, not here. `animationDuration` is an
     * iOS-only option — react-native-screens' Android `setTransitionDuration`
     * is literally `= Unit` — and each preset is hard-wired to a fixed
     * animation resource: `slide_from_right` is 400ms, this one is 200ms, and
     * the only thing below that is `none` at 20ms, which is a cut. To get a
     * value in between, `plugins/with-stack-transition-duration.js` overrides
     * this preset's four resources at build time. It currently runs at 100ms.
     *
     * So there are two things to change and they live apart: the preset here,
     * and its duration in that plugin. Changing the plugin needs a rebuild.
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
