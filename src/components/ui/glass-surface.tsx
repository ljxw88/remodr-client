import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = ViewProps & {
  strength?: 'regular' | 'strong';
};

export function GlassSurface({
  children,
  style,
  strength = 'regular',
  ...props
}: Props) {
  const theme = useTheme();

  const canUseLiquidGlass =
    Platform.OS === 'ios' &&
    isLiquidGlassAvailable() &&
    isGlassEffectAPIAvailable();

  if (canUseLiquidGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={strength === 'strong' ? theme.glassStrong : theme.glass}
        style={[styles.surface, { borderColor: theme.glassBorder }, style]}>
        {children}
      </GlassView>
    );
  }

  return (
    <View
      {...props}
      style={[
        styles.surface,
        styles.fallback,
        {
          backgroundColor: strength === 'strong' ? theme.glassStrong : theme.glass,
          borderColor: theme.glassBorder,
          shadowColor: theme.glassShadow,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    borderWidth: 1,
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  fallback: {
    elevation: 3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
});
