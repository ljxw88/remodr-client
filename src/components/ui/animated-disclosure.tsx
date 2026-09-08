import { useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useDisclosureMotion } from '@/hooks/use-disclosure-motion';

/** Natural-size children are clipped, never scaled, and stop receiving input as soon as they close. */
export function AnimatedDisclosure({ open, active = true, children, testID }: {
  open: boolean;
  active?: boolean;
  children?: ReactNode;
  testID?: string;
}) {
  const motion = useDisclosureMotion(open, active);
  const [initiallyOpen] = useState(open);
  const [height, setHeight] = useState<number | null>(null);
  const natural = open && (!motion.animate || (initiallyOpen && height == null));
  if (!motion.present) return null;
  return (
    <Animated.View testID={testID} pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={[styles.clip, { height: natural ? undefined : motion.progress.interpolate({
        inputRange: [0, 1], outputRange: [0, height ?? 0], extrapolate: 'clamp',
      }) }]}>
        <View style={natural ? undefined : styles.content}
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          {children}
        </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, right: 0 },
});
