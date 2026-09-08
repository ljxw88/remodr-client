import { StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

/**
 * The app canvas.
 *
 * Drawn per screen rather than once behind the navigator. A screen that does
 * not paint its own canvas is transparent, and two transparent screens in a
 * transition are both legible at once. The flat field needs no measurement or
 * alignment, unlike the former window-spanning gradient.
 */
export function AppBackground() {
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.canvas]}
      pointerEvents="none"
    />
  );
}

/**
 * Drop-in canvas copy for opaque subtrees and blur targets.
 */
export function CanvasFill() {
  return <AppBackground />;
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: Colors.background },
});
