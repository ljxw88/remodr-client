import { Stack, useIsFocused } from 'expo-router';
import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';

import { AppBackground } from '@/components/ui/app-background';
import { BlurBackdropProvider } from '@/components/ui/blur-backdrop';
import { Colors } from '@/constants/theme';
import { useScreenEntrance } from '@/features/navigation/screen-entrance';
import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';

type Props = {
  /** `Stack.Screen` entries, for stacks that need to name their routes. */
  children?: ReactNode;
  /**
   * Offers the stack's scrollable region as a backdrop for frosted chrome
   * floating over it.
   *
   * Off unless a screen actually has such chrome. A blur target costs a
   * RenderNode pass and needs coordinated native teardown so disposed targets
   * cannot leave black chrome visible. Stacks without chrome need neither.
   */
  blurBackdrop?: boolean;
  /** Quieter backing for form workflows; ordinary routes retain the app gradient. */
  quiet?: boolean;
};

/**
 * A feature's stack, carrying a canvas of its own.
 *
 * The canvas is the point. A stack header is transparent so the route's
 * gradient reads through it, but the header is not part of the route and the
 * route does not reach behind it — its content begins at the header's lower
 * edge. That leaves a band across the top of every pushed screen that the
 * screen itself never paints.
 *
 * At rest nobody notices, because the root layout paints the same canvas
 * behind the whole navigator and it shows through. During a transition it is
 * the bug: what sits behind this route is not the root canvas but the route
 * being left, so the screen underneath is legible through this one's header —
 * a list of agents sliding about inside a conversation's title bar.
 *
 * Painting it here instead fixes that, because this copy travels with the
 * route. It is the same gradient at the same window offset, so nothing changes
 * at rest; the difference is that the band is now opaque with respect to
 * whatever is below it in the stack.
 *
 * Any route pushed over another needs this. A route with no header does not,
 * having nothing it fails to cover.
 */
export function RouteStack({ children, blurBackdrop = false, quiet = false }: Props) {
  const root = useRef<View | null>(null);
  useLayoutEffect(() => {
    if (Platform.OS !== 'android') return;
    const view = root.current;
    // Restore after effect replay or a change to the backdrop configuration.
    view?.setNativeProps({ style: { opacity: 1 } });
    return () => {
      if (blurBackdrop) {
        // Native screens can draw the departing tree after the blur target is
        // disposed. Cut the whole stack before child cleanup, not each surface.
        view?.setNativeProps({ style: { opacity: 0 } });
      }
    };
  }, [blurBackdrop]);
  const screenOptions = useStackScreenOptions();
  const stack = (
    <Stack screenOptions={screenOptions} screenLayout={screenLayout}>{children}</Stack>
  );

  return (
    <View ref={root} collapsable={false} style={styles.root}>
      {quiet ? null : <AppBackground />}
      {blurBackdrop ? <BlurBackdropProvider>{stack}</BlurBackdropProvider> : stack}
    </View>
  );
}

type ScreenLayoutProps = Parameters<NonNullable<ComponentProps<typeof Stack>['screenLayout']>>[0];
type ScreenNavigation = ScreenLayoutProps['navigation'];

const screenLayout = ({ navigation, children }: ScreenLayoutProps) => (
  <ScreenArrival navigation={navigation}>{children}</ScreenArrival>
);

/**
 * How long to wait for a screen's own appearance before settling regardless.
 *
 * A stack uncovered by an *outer* navigator is not transitioning as far as its
 * own screens are concerned, so the page underneath may never hear that it is
 * back on show. Waiting for ever would strand it at its offset, which is the
 * one outcome worse than a late settle. Measured on device, the appearance
 * lands about 50ms after the commit, so this only expires when the event is
 * genuinely not coming.
 */
const APPEARANCE_TIMEOUT_MS = 120;

/**
 * One page's arrival, animated inside the page itself.
 *
 * The offset has to be in place *before* the page is first drawn, and only a
 * per-page wrapper can do that. Animating the navigator instead — one view
 * around every screen in the stack — leaves nowhere to put the offset that is
 * not also the page being left, so the only safe moment is after the incoming
 * page is already up. That is what this used to do, and it cost a stutter:
 * measured on device, the page was composited about 50ms before its own
 * `transitionEnd` came back to JavaScript, so it arrived, sat still for two or
 * three frames, jumped 16dp sideways and slid back.
 *
 * Here the arming is invisible in both directions. A pushed page has not been
 * composited when it mounts, and a page returned to is still behind the one
 * being dismissed. So the first frame anyone sees is already offset, and what
 * follows is only ever the gap closing.
 *
 * The header stays where it is. It belongs to the navigator rather than to the
 * page, so it changes with the page and does not travel with it — which is
 * also what stops the moving part reaching into a band it does not paint.
 */
function ScreenArrival({
  navigation,
  children,
}: {
  navigation: ScreenNavigation;
  children: ReactNode;
}) {
  const focused = useIsFocused();
  const entrance = useScreenEntrance();
  /** Whether this page has ever been on show, so a return can be told apart. */
  const shown = useRef(false);
  /** Whether it was covered while on show, rather than not yet arrived. */
  const covered = useRef(false);

  useLayoutEffect(() => {
    if (!focused) {
      // A stack mounted in the background has not been left; it has not
      // arrived yet, and when it does that is still a forward arrival.
      covered.current = shown.current;
      entrance.reset();
      return;
    }

    entrance.arm(covered.current ? -1 : 1);
    shown.current = true;
    covered.current = false;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      entrance.settle();
    };

    // Native appearance, which is the first frame the offset can be seen on.
    const stopListening = navigation.addListener('transitionStart', (event) => {
      if (event.data.closing) return;
      settle();
    });
    const fallback = setTimeout(settle, APPEARANCE_TIMEOUT_MS);

    return () => {
      stopListening();
      clearTimeout(fallback);
    };
  }, [entrance, focused, navigation]);

  return <Animated.View style={[styles.screen, entrance.style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
    // The foot of the gradient, so an unpainted frame is the colour it is
    // about to be rather than a hole.
    backgroundColor: Colors.background,
  },
  screen: {
    flex: 1,
  },
});
