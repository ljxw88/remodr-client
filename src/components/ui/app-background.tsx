import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useWindowDimensions } from 'react-native';

import { BackgroundGradient } from '@/constants/theme';

type Props = {
  /**
   * How far below the window top this copy of the canvas is mounted.
   *
   * The gradient is always drawn at full window height and shifted up by this
   * much, so a copy rendered part-way down the screen continues the canvas
   * rather than restarting it. Without it, a gradient mounted below a
   * navigation header jumps back to its brightest colour at the header's lower
   * edge and leaves a visible band.
   */
  topOffset?: number;
};

/**
 * The app canvas. Rendered once behind the whole navigator, and again inside
 * any blur backdrop, since an Android blur can only sample its own subtree.
 * Screens keep transparent backgrounds so it never restarts per route.
 */
export function AppBackground({ topOffset = 0 }: Props) {
  const { height } = useWindowDimensions();

  return (
    <LinearGradient
      colors={[...BackgroundGradient.colors]}
      locations={[...BackgroundGradient.locations]}
      style={
        topOffset > 0
          ? { position: 'absolute', left: 0, right: 0, top: -topOffset, height }
          : StyleSheet.absoluteFill
      }
      pointerEvents="none"
    />
  );
}
