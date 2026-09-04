import { BlurTargetView, BlurView } from 'expo-blur';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ScrollEdgeFade, Spacing, withAlpha } from '@/constants/theme';
import {
  BlurBackdropTarget,
  useBlurBackdrop,
  useInsideBlurTarget,
} from '@/components/ui/blur-backdrop';

type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/**
 * Spread onto the scrollable inside the frame. It reports its position from
 * three directions because a fade that only listened for scrolling stayed
 * invisible until the first one — an opened screen showed none of its edges.
 */
export type ScrollEdgeProps = {
  onScroll: ScrollHandler;
  onContentSizeChange: (width: number, height: number) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  scrollEventThrottle: number;
};

type Props = {
  children: (edge: ScrollEdgeProps) => ReactNode;
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
  /**
   * The geometry the fades need, which arrives without any scrolling: a list
   * reports its content height as its rows measure and its own height on
   * layout. Listening only for scroll events left every edge invisible until
   * the first one, so an opened screen showed none of them.
   */
  const [frameHeight, setFrameHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Only until the reader takes over. After that every scroll carries the
    // whole picture, and this one assumes the resting position.
    if (scrolled || frameHeight <= 0 || contentHeight <= 0) {
      return;
    }
    const remaining = contentHeight - frameHeight;
    topOpacity.setValue(inverted ? Math.min(1, Math.max(0, remaining / 18)) : 0);
    bottomOpacity.setValue(inverted ? 0 : Math.min(1, Math.max(0, remaining / 28)));
  }, [
    bottomOpacity,
    contentHeight,
    frameHeight,
    inverted,
    scrolled,
    topOpacity,
  ]);

  const handleScroll = useCallback<ScrollHandler>(
    (event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const remaining =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      const fromStart = inverted ? remaining : contentOffset.y;
      const fromEnd = inverted ? contentOffset.y : remaining;
      topOpacity.setValue(Math.min(1, Math.max(0, fromStart / 18)));
      bottomOpacity.setValue(Math.min(1, Math.max(0, fromEnd / 28)));
      setScrolled(true);
      onScroll?.(event);
    },
    [bottomOpacity, inverted, onScroll, topOpacity],
  );

  const scrollContent = children({
    onScroll: handleScroll,
    onContentSizeChange: (_width, height) => setContentHeight(height),
    onLayout: (event) => setFrameHeight(event.nativeEvent.layout.height),
    scrollEventThrottle: 16,
  });
  /**
   * Android gets the gradient dissolve only. The fade sits *over* the rows it
   * softens, so a nested blur target is the one shape Android cannot draw: it
   * would put the edge's BlurView inside the same subtree the screen's chrome
   * already samples, and overlapping targets recurse until the render thread
   * overflows. The dissolve alone reads almost identically.
   */
  const supportsCroppedEdgeBlur = Platform.OS !== 'android';

  /**
   * The scrollable region doubles as the backdrop for chrome floating over it,
   * when a screen has asked for one.
   *
   * This is the only place that can offer it. The target has to contain what
   * gets blurred and exclude what does the blurring — a `BlurView` inside its
   * own target takes the render thread down — and on a screen with a composer
   * or a dock, the thing being floated over is exactly this scrollable and
   * nothing else. Opting in from here rather than from the screen keeps the
   * rule with the component that can enforce it.
   *
   * Declined when a target is already overhead, because nesting them is the
   * same crash. The tab screens are that case: their layout wraps the whole
   * tab in one for the dock, and this would put a second inside it.
   */
  const backdrop = useBlurBackdrop();
  const insideTarget = useInsideBlurTarget();
  const providesBackdrop = Boolean(backdrop) && !insideTarget && !supportsCroppedEdgeBlur;

  const content = supportsCroppedEdgeBlur ? (
    <BlurTargetView ref={blurTarget} style={styles.content}>
      {scrollContent}
    </BlurTargetView>
  ) : providesBackdrop ? (
    <BlurBackdropTarget style={styles.content}>{scrollContent}</BlurBackdropTarget>
  ) : (
    <View style={styles.content}>{scrollContent}</View>
  );

  return (
    <View style={styles.frame}>
      {content}
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
  /**
   * No `zIndex`, deliberately.
   *
   * The fades are the last children of the frame, so they already draw over the
   * rows they soften — the ordering they need costs nothing. Asking for it
   * again by number is not free, though: React Native maps `zIndex` onto
   * Android's `translationZ`, and that lifts a view in the *window* rather than
   * among its siblings. A fade raised that way sails over anything floating on
   * the screen that has not also asked to be lifted, which is how the composer
   * and the dock ended up with the closing fade painted across them — dimming
   * toward the bottom edge, so a panel meant to read as one material shaded off
   * into the canvas from the middle down.
   */
  edge: {
    position: 'absolute',
    left: -Spacing.three,
    right: -Spacing.three,
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
