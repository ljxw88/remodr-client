import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ControlHeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ChipOption = {
  id: string;
  label: string;
};

type Props = {
  label: string;
  options: ChipOption[];
  selectedId: string;
  onSelect: (id: string) => void;
};

/**
 * A labelled row of choices, wrapped rather than scrolled.
 *
 * Wrapping keeps every choice reachable without a gesture that competes with
 * the sheet it sits in — a horizontal strip inside a vertical scroll is a
 * coin toss over which one moves.
 */
export function ChipPicker({ label, options, selectedId, onSelect }: Props) {
  const theme = useTheme();
  return (
    <View style={styles.group}>
      <ThemedText type="label" themeColor="textMuted">
        {label}
      </ThemedText>
      <View style={styles.chips}>
        {options.map((option) => {
          const selected = option.id === selectedId;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected }}
              onPress={() => onSelect(option.id)}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: selected ? theme.accentSoft : theme.backgroundElement,
                  borderColor: selected ? theme.accent : theme.border,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}>
              <ThemedText
                type="smallBold"
                style={{ color: selected ? theme.accent : theme.text }}>
                {option.label}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const CHIP_HEIGHT = ControlHeight.compact;

const styles = StyleSheet.create({
  group: {
    gap: Spacing.one,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  chip: {
    minHeight: CHIP_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    // Half the height it can never go under, so a one-line chip is a true pill
    // and a wrapped one stays a clean rounded rectangle. `Radius.pill` is 999,
    // which on a wrapped chip curves the ends in through the text.
    borderRadius: CHIP_HEIGHT / 2,
  },
});
