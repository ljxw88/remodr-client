import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

type Props = {
  message?: string;
  /** Legacy props for backward compatibility */
  title?: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function EmptyState({ message, title }: Props) {
  const label = message ?? title;
  if (!label) return null;

  return (
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textMuted" style={styles.text}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.five,
  },
  text: {
    textAlign: 'center',
  },
});
