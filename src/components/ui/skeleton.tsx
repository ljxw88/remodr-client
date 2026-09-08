import type { ReactNode } from 'react';
import { useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function SkeletonBlock({
  width = '100%',
  height,
  radius = Spacing.half,
}: {
  width?: ViewStyle['width'];
  height: number;
  radius?: number;
}) {
  const theme = useTheme();
  return <View accessible={false} style={{ width, height, borderRadius: radius, backgroundColor: theme.backgroundSelected }} />;
}

export function SkeletonLine({
  width = '100%',
  lineHeight = 18,
}: {
  width?: ViewStyle['width'];
  lineHeight?: number;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ height: lineHeight * fontScale, justifyContent: 'center' }}>
      <SkeletonBlock width={width} height={lineHeight * fontScale * 0.55} />
    </View>
  );
}

/** Static placeholders avoid both motion and timers delaying real content. */
export function SkeletonGroup({ label, children, style }: {
  label: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityState={{ busy: true }} pointerEvents="none" style={style}>
      {children}
    </View>
  );
}
