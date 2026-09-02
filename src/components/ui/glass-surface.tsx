import { GlassView } from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = ViewProps & {
  interactive?: boolean;
  strength?: 'regular' | 'strong';
};

export function GlassSurface({
  children,
  style,
  interactive = false,
  strength = 'regular',
  ...props
}: Props) {
  const theme = useTheme();

  if (Platform.OS === 'ios') {
    return (
      <GlassView
        {...props}
        isInteractive={interactive}
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
        styles.android,
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
  android: {
    elevation: 3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
});
