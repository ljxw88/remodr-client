import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  /**
   * Unread finish count this dot represents. Leave unset for a bare presence
   * dot (an agent row: there is exactly one thing to read, so there is
   * nothing a number would add). Pass a count for an aggregate — a workspace,
   * a device, or the filter header — where more than one can be true at once.
   */
  count?: number;
  /** Announced by itself; phrase it for what the dot sits beside. */
  label: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * The blue "something finished, unread" indicator.
 *
 * Deliberately not the status dot: status (working/blocked/done/idle) reads
 * the agent's current state, this reads whether *you* have looked at a finish
 * yet. The two can disagree — a row can be idle again and still owe you a
 * read of the run that just finished — so they stay visually distinct and
 * never share a slot.
 */
export function FinishDot({ count, label, style }: Props) {
  const theme = useTheme();
  if (count != null && count <= 0) return null;
  const badge = count != null && count > 1;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      pointerEvents="none"
      style={[badge ? styles.badge : styles.dot, { backgroundColor: theme.accent }, style]}>
      {badge ? (
        <ThemedText style={[styles.badgeText, { color: theme.onAccent }]} numberOfLines={1}>
          {count > 9 ? '9+' : count}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  badge: {
    flexShrink: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: 700,
  },
});
