import { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CanvasFill } from '@/components/ui/app-background';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  includeTopSafeArea?: boolean;
};

/**
 * A route's frame: the canvas it is painted on, and the insets it keeps.
 *
 * Opaque, and deliberately so. A transparent route lets whatever is behind it
 * in the navigator read straight through, which during a transition is the
 * route being left — the two hang over each other as a double exposure for as
 * long as the animation runs. Every route carries the same canvas, so it still
 * looks like one surface the routes move across.
 *
 * The canvas sits outside the safe area, since it should reach the very edges
 * of the window; only the content is inset.
 */
export function Screen({ children, style, includeTopSafeArea = false }: Props) {
  const edges = includeTopSafeArea
    ? (['top', 'left', 'right'] as const)
    : (['left', 'right'] as const);

  return (
    <View style={styles.root}>
      <CanvasFill />
      <SafeAreaView edges={edges} style={styles.safe}>
        <View style={[styles.body, style]}>{children}</View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // The foot of the canvas gradient, so the frame before the gradient has
    // measured itself is the colour it is about to be rather than a hole.
    backgroundColor: Colors.background,
  },
  safe: {
    flex: 1,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
