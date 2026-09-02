import { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  includeTopSafeArea?: boolean;
};

export function Screen({ children, style, includeTopSafeArea = false }: Props) {
  const theme = useTheme();
  const edges = includeTopSafeArea
    ? (['top', 'left', 'right'] as const)
    : (['left', 'right'] as const);

  return (
    <SafeAreaView edges={edges} style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.body, style]}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
