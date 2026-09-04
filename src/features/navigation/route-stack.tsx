import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppBackground } from '@/components/ui/app-background';
import { Colors } from '@/constants/theme';
import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';

type Props = {
  /** `Stack.Screen` entries, for stacks that need to name their routes. */
  children?: ReactNode;
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
export function RouteStack({ children }: Props) {
  const screenOptions = useStackScreenOptions();

  return (
    <View style={styles.root}>
      <AppBackground />
      <Stack screenOptions={screenOptions}>{children}</Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // The foot of the gradient, so an unpainted frame is the colour it is
    // about to be rather than a hole.
    backgroundColor: Colors.background,
  },
});
