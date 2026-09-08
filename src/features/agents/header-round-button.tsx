import { Pressable, StyleSheet, View } from 'react-native';

import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { glassRim } from '@/components/ui/glass-surface';
import { LiquidGlassRim } from '@/components/ui/liquid-glass-rim';
import { ControlHeight } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Drawn at the height of the New agent button it shares a line with. */
const SIZE = ControlHeight.header;

type Props = {
  onPress: () => void;
  accessibilityLabel: string;
  icon: AppIconName;
  /** Glyph to draw where the platform has no symbol for `icon`. */
  fallback: string;
  /**
   * Marks the button as a disclosure control and says which way it points, for
   * screen readers. Left off when the button is not one.
   */
  expanded?: boolean;
  disabled?: boolean;
};

/**
 * The round button at the far end of the home header.
 *
 * It wears the New agent button's material — the frosted body and the slowly
 * turning iridescent rim, through `LiquidGlassRim` — because it shares a line
 * with it and would otherwise read as an unrelated widget beside it. Same
 * height, for the same reason.
 *
 * That rim is why there is no status colour here. An iridescent edge and a
 * semantic one cannot both have the border, and connection status has the
 * floating indicator and the dot on each device chip already.
 */
export function HeaderRoundButton({
  onPress,
  accessibilityLabel,
  icon,
  fallback,
  expanded,
  disabled = false,
}: Props) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        /*
          The plate and its rim stay under the drawn one, which is also what a
          selected chip does. Taking them away to let the drawn rim be the whole
          edge looks right in principle and does not survive contact: with no
          fill and no border the button stops painting on Android altogether,
          its icon included.
        */
        glassRim(),
        {
          backgroundColor: theme.glass,
          // Dims and shrinks, at the depth the button beside it dims to.
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed && !disabled ? 0.96 : 1 }],
        },
      ]}>
      <LiquidGlassRim />
      {/*
        A layer of its own, so it can be lifted above the rim. Being declared
        after the canvas is not enough on Android — the canvas composited its
        frosted body over the icon and left it looking washed rather than
        drawn. The selected chip keeps its label in a wrapper for its own
        reasons and gets the same protection by accident.
      */}
      <View style={styles.content}>
        <AppIcon name={icon} size={20} tintColor={theme.text} fallback={fallback} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  content: {
    // Above the drawn rim, and the reason this is a view at all.
    zIndex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
