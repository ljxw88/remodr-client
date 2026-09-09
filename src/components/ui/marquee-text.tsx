import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { ThemedText, type ThemedTextProps } from '@/components/themed-text';
import type { ThemeColor } from '@/constants/theme';
import { useAppSettings } from '@/hooks/use-app-settings';
import { Motion } from '@/constants/motion';
import { useForeground } from '@/hooks/use-foreground';
import { useReducedMotion } from '@/hooks/use-reduce-motion';
import { ScrollViewportContext } from '@/components/ui/scroll-viewport-context';

export type MarqueeTextProps = {
  children?: string;
  type?: ThemedTextProps['type'];
  themeColor?: ThemeColor;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  speed?: number; // pixels per second
  startDelay?: number; // ms to pause at start
  endDelay?: number; // ms to pause at end
  enabled?: boolean; // override global setting
  active?: boolean;
};

export function MarqueeText({
  children = '',
  type = 'default',
  themeColor,
  style,
  containerStyle,
  speed = 32,
  startDelay = 1500,
  endDelay = 1200,
  enabled: propEnabled,
  active = true,
}: MarqueeTextProps) {
  const { marqueeEnabled: globalEnabled } = useAppSettings();
  const enabled = propEnabled ?? globalEnabled;
  const foreground = useForeground();
  const reducedMotion = useReducedMotion();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const viewport = useContext(ScrollViewportContext);
  const container = useRef<View | null>(null);
  const scroller = useRef<ScrollView | null>(null);

  const [containerWidth, setContainerWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [translateX] = useState(() => new Animated.Value(0));
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const monitor = useRef<ReturnType<typeof setInterval> | null>(null);

  const overflow = enabled && contentWidth > containerWidth + 2 && containerWidth > 0;
  const distance = overflow ? contentWidth - containerWidth + 16 : 0;

  const stopAnimation = useCallback(() => {
    const animation = animationRef.current;
    animationRef.current = null;
    animation?.stop();
  }, []);

  const stop = useCallback(() => {
    stopAnimation();
    if (monitor.current != null) clearInterval(monitor.current);
    monitor.current = null;
  }, [stopAnimation]);

  useEffect(() => {
    scroller.current?.scrollTo({ x: 0, animated: false });
  }, [children]);

  useEffect(() => {
    stop();
    translateX.setValue(0);

    if (!overflow || !active || !foreground || reducedMotion) return;
    let cancelled = false;

    const duration = (distance / speed) * 1000;
    const useNative = Platform.OS !== 'web';

    const createAnimation = () => Animated.loop(Animated.sequence([
        Animated.delay(startDelay),
        Animated.timing(translateX, {
          toValue: -distance,
          duration,
          easing: Easing.linear,
          useNativeDriver: useNative,
          isInteraction: false,
        }),
        Animated.delay(endDelay),
        Animated.timing(translateX, {
          toValue: 0,
          duration: Motion.duration.disclosure,
          easing: Motion.easing.standard,
          useNativeDriver: useNative,
          isInteraction: false,
        }),
      ]));

    const checkVisibility = () => {
      container.current?.measureInWindow((x, y, width, height) => {
        if (cancelled) return;
        const bounds = viewport?.current;
        const left = Math.max(0, bounds?.x ?? 0);
        const top = Math.max(0, bounds?.y ?? 0);
        const right = Math.min(windowWidth, bounds ? bounds.x + bounds.width : windowWidth);
        const bottom = Math.min(windowHeight, bounds ? bounds.y + bounds.height : windowHeight);
        const visible = width > 0 && height > 0 && x < right && x + width > left
          && y < bottom && y + height > top;
        if (!visible) {
          stopAnimation();
          translateX.setValue(0);
        } else if (!animationRef.current) {
          const animation = createAnimation();
          animationRef.current = animation;
          animation.start(() => {
            if (!cancelled && animationRef.current === animation) {
              animationRef.current = null;
            }
          });
        }
      });
    };
    checkVisibility();
    // Overflowing rows that enter the viewport later can start; visible rows
    // stop promptly when scrolled away.
    monitor.current = setInterval(checkVisibility, 250);

    return () => {
      cancelled = true;
      stop();
    };
  }, [active, children, distance, endDelay, foreground, overflow, reducedMotion, speed, startDelay, stop, stopAnimation, translateX, viewport, windowHeight, windowWidth]);

  const handleContainerLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0 && Math.abs(width - containerWidth) > 1) {
      setContainerWidth(width);
    }
  };

  const handleContentSizeChange = (width: number) => {
    if (width > 0 && Math.abs(width - contentWidth) > 1) {
      setContentWidth(width);
    }
  };

  return (
    <View
      ref={container}
      collapsable={false}
      onLayout={handleContainerLayout}
      style={[styles.container, containerStyle]}>
      <ScrollView
        ref={scroller}
        horizontal
        scrollEnabled
        onScrollBeginDrag={() => {
          if (!animationRef.current) return;
          stop();
          translateX.stopAnimation((offset) => {
            if (!scroller.current) return;
            translateX.setValue(0);
            scroller.current.scrollTo({ x: Math.max(0, -offset), animated: false });
          });
        }}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        onContentSizeChange={handleContentSizeChange}>
        <Animated.View
          style={[
            styles.animatedContent,
            overflow ? { transform: [{ translateX }] } : undefined,
          ]}>
          <ThemedText
            type={type}
            themeColor={themeColor}
            style={[styles.singleLineText, style]}>
            {children}
          </ThemedText>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  scrollView: {
    flexGrow: 0,
  },
  scrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  animatedContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  singleLineText: {
    flexShrink: 0,
  },
});
