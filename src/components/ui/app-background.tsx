import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';

import { BackgroundGradient } from '@/constants/theme';

/**
 * The app canvas, rendered once behind the whole navigator. Screens keep
 * transparent backgrounds so the gradient does not restart per route.
 */
export function AppBackground() {
  return (
    <LinearGradient
      colors={[...BackgroundGradient.colors]}
      locations={[...BackgroundGradient.locations]}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}
