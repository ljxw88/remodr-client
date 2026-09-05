import { Stack, useIsFocused } from 'expo-router';
import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

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
   * RenderNode pass, and it blanks its contents for the frame a dismissal
   * takes — harmless while pushes are cuts, but not worth carrying on a stack
   * with nothing to blur.
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
  const screenOptions = useStackScreenOptions();
  const stack = <Stack screenOptions={screenOptions} layout={stackLayout}>{children}</Stack>;

  return (
    <View style={styles.root}>
      {quiet ? null : <AppBackground />}
      {blurBackdrop ? <BlurBackdropProvider>{stack}</BlurBackdropProvider> : stack}
    </View>
  );
}

type StackLayoutProps = Parameters<NonNullable<ComponentProps<typeof Stack>['layout']>>[0];

const stackLayout = ({ state, descriptors, children }: StackLayoutProps) => (
  <StackArrival state={state} descriptors={descriptors}>{children}</StackArrival>
);

function StackArrival({ state, descriptors, children }: Pick<StackLayoutProps, 'state' | 'descriptors' | 'children'>) {
  const focused = useIsFocused();
  const entrance = useScreenEntrance();
  const routeKey = state.routes[state.index].key;
  const navigation = descriptors[routeKey].navigation;
  const previous = useRef<{ key: string; index: number } | null>(null);
  const covered = useRef(false);

  useLayoutEffect(() => {
    if (!focused) {
      covered.current = true;
      entrance.reset();
      return;
    }

    const last = previous.current;
    const returning = last && (
      state.index < last.index || (routeKey === last.key && covered.current)
    );
    previous.current = { key: routeKey, index: state.index };
    covered.current = false;
    entrance.reset();
    let appeared = false;

    // JS focus changes before Android swaps fragments, even with animation:none.
    // Native appearance is the first safe point to move only the incoming page.
    return navigation.addListener('transitionEnd', (event) => {
      if (event.data.closing || appeared || !navigation.isFocused()) return;
      appeared = true;
      entrance.play(returning ? -1 : 1);
    });
  }, [entrance, focused, navigation, routeKey, state.index]);

  // Animate the committed navigator, including its header, over its own canvas.
  // A stable layout preserves mounted forms and never animates the outgoing page.
  return <Animated.View style={[styles.stack, entrance.style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
    // The foot of the gradient, so an unpainted frame is the colour it is
    // about to be rather than a hole.
    backgroundColor: Colors.background,
  },
  stack: {
    flex: 1,
  },
});
