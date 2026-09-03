import { Pressable, StyleSheet, Text } from 'react-native';

import { glassRim } from '@/components/ui/glass-surface';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Variant = 'primary' | 'secondary';

type Props = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  accessibilityHint?: string;
};

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  accessibilityHint,
}: Props) {
  const theme = useTheme();
  const backgroundColor = variant === 'primary' ? theme.accent : theme.glassStrong;
  const color = variant === 'secondary' ? theme.text : theme.onAccent;
  const borderColor = variant === 'secondary' ? theme.glassBorder : backgroundColor;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        glassRim(borderColor, variant === 'secondary'),
        {
          backgroundColor,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
      ]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  label: {
    fontFamily: Fonts.semibold,
    fontSize: 14,
    letterSpacing: -0.14,
    fontWeight: 600,
  },
});
