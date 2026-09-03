import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { ThemedText, type ThemedTextProps } from '@/components/themed-text';
import type { ThemeColor } from '@/constants/theme';
import { useAppSettings } from '@/hooks/use-app-settings';

export type MarqueeTextProps = {
  children: string;
  type?: ThemedTextProps['type'];
  themeColor?: ThemeColor;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  speed?: number; // pixels per second
  startDelay?: number; // ms to pause at start
  endDelay?: number; // ms to pause at end
  enabled?: boolean; // override global setting
};

export function MarqueeText({
  children,
  type = 'default',
  themeColor,
  style,
  containerStyle,
  speed = 32,
  startDelay = 1500,
  endDelay = 1200,
  enabled: propEnabled,
}: MarqueeTextProps) {
  const { marqueeEnabled: globalEnabled } = useAppSettings();
  const enabled = propEnabled ?? globalEnabled;

  const [containerWidth, setContainerWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [translateX] = useState(() => new Animated.Value(0));
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  const overflow = enabled && contentWidth > containerWidth + 2 && containerWidth > 0;
  const distance = overflow ? contentWidth - containerWidth + 16 : 0;

  useEffect(() => {
    if (animationRef.current) {
      animationRef.current.stop();
      animationRef.current = null;
    }
    translateX.setValue(0);

    if (!overflow || distance <= 0) {
      return;
    }

    const duration = (distance / speed) * 1000;
    const useNative = Platform.OS !== 'web';

    const loopAnimation = Animated.loop(
      Animated.sequence([
        Animated.delay(startDelay),
        Animated.timing(translateX, {
          toValue: -distance,
          duration,
          easing: Easing.linear,
          useNativeDriver: useNative,
        }),
        Animated.delay(endDelay),
        Animated.timing(translateX, {
          toValue: 0,
          duration: Math.min(800, duration * 0.5),
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: useNative,
        }),
        Animated.delay(800),
      ]),
    );

    animationRef.current = loopAnimation;
    loopAnimation.start();

    return () => {
      loopAnimation.stop();
    };
  }, [children, distance, enabled, endDelay, overflow, speed, startDelay, translateX]);

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
      onLayout={handleContainerLayout}
      style={[styles.container, containerStyle]}>
      <ScrollView
        horizontal
        scrollEnabled={false}
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
