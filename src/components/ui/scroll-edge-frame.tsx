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

import { ScrollEdgeFade, Spacing, withAlpha } from '@/constants/theme';

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

const { color, topHeight, topOpacity, bottomHeight, bottomOpacity } = ScrollEdgeFade;

/** Eased so the dissolve builds gradually rather than banding at the edge. */
const TOP_FADE = [
  `linear-gradient(180deg, ${withAlpha(color, topOpacity)} 0%`,
  `${withAlpha(color, topOpacity * 0.34)} 55%`,
  `${withAlpha(color, 0)} 100%)`,
].join(', ');

const BOTTOM_FADE = [
  `linear-gradient(180deg, ${withAlpha(color, 0)} 0%`,
  `${withAlpha(color, bottomOpacity * 0.16)} 38%`,
  `${withAlpha(color, bottomOpacity * 0.52)} 68%`,
  `${withAlpha(color, bottomOpacity)} 100%)`,
].join(', ');

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
    height: topHeight,
  },
  bottom: {
    bottom: 0,
    height: bottomHeight,
  },
  blur: {
    opacity: 0.3,
  },
  topFade: {
    experimental_backgroundImage: TOP_FADE,
  },
  bottomFade: {
    experimental_backgroundImage: BOTTOM_FADE,
  },
});
