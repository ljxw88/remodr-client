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
  /**
   * Set when wrapping an inverted list. Offset zero is then the *bottom* of the
   * content rather than the top, so the two fades swap which measurement drives
   * them.
   */
  inverted?: boolean;
  /**
   * How far the closing fade reaches. Defaults to the token, but a screen with
   * chrome floating over the list should pass that chrome's height: the fade is
   * what stops rows reading through the gaps between floating panels, so a
   * fade shorter than the chrome leaves a band where they show through.
   */
  bottomHeight?: number;
};

export function ScrollEdgeFrame({
  children,
  onScroll,
  top = true,
  bottom = true,
  inverted = false,
  bottomHeight: bottomReach = bottomHeight,
}: Props) {
  const blurTarget = useRef<View | null>(null);
  const [topOpacity] = useState(() => new Animated.Value(0));
  const [bottomOpacity] = useState(() => new Animated.Value(0));
  const handleScroll = useCallback<ScrollHandler>(
    (event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const remaining =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      const fromStart = inverted ? remaining : contentOffset.y;
      const fromEnd = inverted ? contentOffset.y : remaining;
      topOpacity.setValue(Math.min(1, Math.max(0, fromStart / 18)));
      bottomOpacity.setValue(Math.min(1, Math.max(0, fromEnd / 28)));
      onScroll?.(event);
    },
    [bottomOpacity, inverted, onScroll, topOpacity],
  );
  const scrollContent = children(handleScroll);
  /**
   * Android gets the gradient dissolve only. The fade sits *over* the rows it
   * softens, so a nested blur target is the one shape Android cannot draw: it
   * would put the edge's BlurView inside the same subtree the screen's chrome
   * already samples, and overlapping targets recurse until the render thread
   * overflows. The dissolve alone reads almost identically.
   */
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
              intensity={EDGE_BLUR.top}
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
          style={[
            styles.edge,
            styles.bottom,
            { height: bottomReach, opacity: bottomOpacity },
          ]}>
          {supportsCroppedEdgeBlur ? (
            <BlurView
              blurTarget={blurTarget}
              intensity={EDGE_BLUR.bottom}
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

/** Rows soften as well as dim on the way out, where the platform allows it. */
const EDGE_BLUR = { top: 14, bottom: 18 };

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
  topFade: {
    experimental_backgroundImage: TOP_FADE,
  },
  blur: {
    opacity: 0.3,
  },
  bottomFade: {
    experimental_backgroundImage: BOTTOM_FADE,
  },
});
