import { Pressable, StyleSheet, Text } from 'react-native';

import { glassRim } from '@/components/ui/glass-surface';
import { ControlHeight, Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Variant = 'primary' | 'secondary' | 'danger';

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
  const { backgroundColor, color, borderColor } = TONES[variant](theme);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={2}
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

type Theme = ReturnType<typeof useTheme>;

/**
 * What each variant is made of. `danger` is an outline rather than a fill: the
 * destructive action is never the one being encouraged, so it carries the
 * warning in its colour without also carrying the weight of a filled button.
 */
const TONES: Record<
  Variant,
  (theme: Theme) => { backgroundColor: string; color: string; borderColor: string }
> = {
  primary: (theme) => ({
    backgroundColor: theme.accent,
    color: theme.onAccent,
    borderColor: theme.accent,
  }),
  secondary: (theme) => ({
    backgroundColor: theme.glassStrong,
    color: theme.text,
    borderColor: theme.glassBorder,
  }),
  danger: (theme) => ({
    backgroundColor: 'transparent',
    color: theme.danger,
    borderColor: theme.danger,
  }),
};

const styles = StyleSheet.create({
  button: {
    minHeight: ControlHeight.regular,
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
