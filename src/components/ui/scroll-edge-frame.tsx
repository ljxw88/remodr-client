import { BlurTargetView, BlurView } from 'expo-blur';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Spacing } from '@/constants/theme';

type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

type Props = {
  children: (onScroll: ScrollHandler) => ReactNode;
  onScroll?: ScrollHandler;
  top?: boolean;
  bottom?: boolean;
};

export function ScrollEdgeFrame({
  children,
  onScroll,
  top = true,
  bottom = true,
}: Props) {
  const blurTarget = useRef<View | null>(null);
  const [topOpacity] = useState(() => new Animated.Value(0));
  const [bottomOpacity] = useState(() => new Animated.Value(0));
  const handleScroll = useCallback<ScrollHandler>(
    (event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const remaining =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      topOpacity.setValue(Math.min(1, Math.max(0, contentOffset.y / 18)));
      bottomOpacity.setValue(Math.min(1, Math.max(0, remaining / 28)));
      onScroll?.(event);
    },
    [bottomOpacity, onScroll, topOpacity],
  );
  const scrollContent = children(handleScroll);
  const supportsCroppedEdgeBlur = Platform.OS !== 'android';

  return (
    <View style={styles.frame}>
      {supportsCroppedEdgeBlur ? (
        <BlurTargetView ref={blurTarget} style={styles.content}>
          {scrollContent}
        </BlurTargetView>
      ) : (
        <View style={styles.content}>{scrollContent}</View>
      )}
      {top ? (
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[styles.edge, styles.top, { opacity: topOpacity }]}>
          {supportsCroppedEdgeBlur ? (
            <BlurView
              blurTarget={blurTarget}
              intensity={14}
              tint="dark"
              style={[StyleSheet.absoluteFill, styles.blur]}
            />
          ) : null}
          <View style={[StyleSheet.absoluteFill, styles.topFade]} />
        </Animated.View>
      ) : null}
      {bottom ? (
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[styles.edge, styles.bottom, { opacity: bottomOpacity }]}>
          {supportsCroppedEdgeBlur ? (
            <BlurView
              blurTarget={blurTarget}
              intensity={18}
              tint="dark"
              style={[StyleSheet.absoluteFill, styles.blur]}
            />
          ) : null}
          <View style={[StyleSheet.absoluteFill, styles.bottomFade]} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    overflow: 'visible',
  },
  content: {
    flex: 1,
  },
  edge: {
    position: 'absolute',
    left: -Spacing.three,
    right: -Spacing.three,
    zIndex: 10,
    overflow: 'hidden',
  },
  top: {
    top: 0,
    height: 18,
  },
  bottom: {
    bottom: 0,
    height: 32,
  },
  blur: {
    opacity: 0.3,
  },
  topFade: {
    experimental_backgroundImage:
      'linear-gradient(180deg, rgba(8,9,11,0.30) 0%, rgba(8,9,11,0.08) 52%, rgba(8,9,11,0) 100%)',
  },
  bottomFade: {
    experimental_backgroundImage:
      'linear-gradient(180deg, rgba(8,9,11,0) 0%, rgba(8,9,11,0.10) 48%, rgba(8,9,11,0.38) 100%)',
  },
});
