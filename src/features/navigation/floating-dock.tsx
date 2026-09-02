import { BlurView } from 'expo-blur';
import { TabTrigger } from 'expo-router/ui';
import { usePathname } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/app-icon';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type DockMotion = {
  progress: Animated.Value;
  onScroll: (offsetY: number) => void;
  expand: () => void;
  shouldReduceMotion: () => boolean;
};

const DockMotionContext = createContext<DockMotion | null>(null);
const EXPANDED_DOCK_HEIGHT = 72;
const EXPANDED_DOCK_GAP = 12;

export function DockMotionProvider({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const [progress] = useState(() => new Animated.Value(0));
  const collapsed = useRef(false);
  const lastOffset = useRef(0);
  const direction = useRef<1 | -1 | 0>(0);
  const directionStart = useRef(0);
  const reduceMotion = useRef(false);

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (collapsed.current === next) {
        return;
      }
      collapsed.current = next;
      if (reduceMotion.current) {
        progress.setValue(next ? 1 : 0);
        return;
      }
      Animated.timing(progress, {
        toValue: next ? 1 : 0,
        duration: next ? 180 : 220,
        easing: next ? Easing.out(Easing.cubic) : Easing.out(Easing.back(1.05)),
        useNativeDriver: false,
      }).start();
    },
    [progress],
  );

  const expand = useCallback(() => {
    lastOffset.current = 0;
    direction.current = 0;
    directionStart.current = 0;
    setCollapsed(false);
  }, [setCollapsed]);

  const onScroll = useCallback(
    (offsetY: number) => {
      const delta = offsetY - lastOffset.current;
      const nextDirection = delta > 0 ? 1 : delta < 0 ? -1 : direction.current;
      if (nextDirection !== direction.current) {
        direction.current = nextDirection;
        directionStart.current = lastOffset.current;
      }
      if (offsetY <= 24) {
        setCollapsed(false);
        directionStart.current = 0;
      } else if (
        direction.current > 0 &&
        offsetY > 72 &&
        offsetY - directionStart.current > 18
      ) {
        setCollapsed(true);
      } else if (
        direction.current < 0 &&
        directionStart.current - offsetY > 18
      ) {
        setCollapsed(false);
      }
      lastOffset.current = Math.max(0, offsetY);
    },
    [setCollapsed],
  );
  const shouldReduceMotion = useCallback(() => reduceMotion.current, []);

  useEffect(() => {
    expand();
  }, [expand, pathname]);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      reduceMotion.current = enabled;
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        reduceMotion.current = enabled;
      },
    );
    return () => subscription.remove();
  }, []);

  const value = useMemo(
    () => ({ progress, onScroll, expand, shouldReduceMotion }),
    [expand, onScroll, progress, shouldReduceMotion],
  );
  return (
    <DockMotionContext.Provider value={value}>
      {children}
    </DockMotionContext.Provider>
  );
}

export function AnimatedTabContent({ children }: PropsWithChildren) {
  const motion = useContext(DockMotionContext);
  if (!motion) {
    throw new Error('AnimatedTabContent must be used inside DockMotionProvider');
  }
  const pathname = usePathname();
  const tabIndex = pathname === '/servers' ? 1 : pathname === '/settings' ? 2 : 0;
  const previousIndex = useRef(tabIndex);
  const mounted = useRef(false);
  const [opacity] = useState(() => new Animated.Value(1));
  const [translateX] = useState(() => new Animated.Value(0));

  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      previousIndex.current = tabIndex;
      return;
    }
    if (motion.shouldReduceMotion()) {
      opacity.setValue(1);
      translateX.setValue(0);
      previousIndex.current = tabIndex;
      return;
    }
    const direction = tabIndex >= previousIndex.current ? 1 : -1;
    previousIndex.current = tabIndex;
    opacity.setValue(0.82);
    translateX.setValue(direction * 12);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [motion, opacity, tabIndex, translateX]);

  return (
    <Animated.View
      style={[
        styles.content,
        {
          opacity,
          transform: [{ translateX }],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

export function useDockScrollHandler() {
  const motion = useContext(DockMotionContext);
  if (!motion) {
    throw new Error('useDockScrollHandler must be used inside DockMotionProvider');
  }
  return useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      motion.onScroll(event.nativeEvent.contentOffset.y);
    },
    [motion],
  );
}

export function useDockContentInset() {
  const insets = useSafeAreaInsets();
  return (
    Math.max(insets.bottom, Spacing.one) +
    EXPANDED_DOCK_GAP +
    EXPANDED_DOCK_HEIGHT +
    Spacing.two
  );
}

type FloatingDockProps = {
  blurTarget: RefObject<View | null>;
};

export function FloatingDock({ blurTarget }: FloatingDockProps) {
  const motion = useContext(DockMotionContext);
  if (!motion) {
    throw new Error('FloatingDock must be used inside DockMotionProvider');
  }
  const theme = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const expandedWidth = Math.min(width - Spacing.four, 430);
  const collapsedWidth = Math.min(width - 112, 292);
  const dockWidth = motion.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [expandedWidth, collapsedWidth],
  });
  const dockHeight = motion.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [EXPANDED_DOCK_HEIGHT, 54],
  });
  const dockBottom = motion.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [
      Math.max(insets.bottom, Spacing.one) + EXPANDED_DOCK_GAP,
      Math.max(insets.bottom, Spacing.one) + Spacing.one,
    ],
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.position,
        {
          bottom: dockBottom,
          height: dockHeight,
          width: dockWidth,
          shadowColor: theme.glassShadow,
        },
      ]}>
      <BlurView
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        intensity={84}
        tint="dark"
        style={[
          styles.dock,
          {
            backgroundColor:
              Platform.OS === 'android' ? 'rgba(25,27,32,0.82)' : theme.glass,
            borderColor: theme.glassBorder,
          },
        ]}>
        <DockTab
          name="agents"
          label="Agents"
          active={pathname === '/'}
          icon={{ ios: 'bubble.left.and.bubble.right', android: 'forum', web: 'forum' }}
          progress={motion.progress}
          reduceMotion={motion.shouldReduceMotion}
          onPress={motion.expand}
        />
        <DockTab
          name="servers"
          label="Servers"
          active={pathname === '/servers'}
          icon={{ ios: 'desktopcomputer', android: 'computer', web: 'computer' }}
          progress={motion.progress}
          reduceMotion={motion.shouldReduceMotion}
          onPress={motion.expand}
        />
        <DockTab
          name="settings"
          label="Settings"
          active={pathname === '/settings'}
          icon={{ ios: 'gear', android: 'settings', web: 'settings' }}
          progress={motion.progress}
          reduceMotion={motion.shouldReduceMotion}
          onPress={motion.expand}
        />
      </BlurView>
    </Animated.View>
  );
}

type DockTabProps = {
  name: 'agents' | 'servers' | 'settings';
  label: string;
  active: boolean;
  icon: {
    ios: 'bubble.left.and.bubble.right' | 'desktopcomputer' | 'gear';
    android: 'forum' | 'computer' | 'settings';
    web: 'forum' | 'computer' | 'settings';
  };
  progress: Animated.Value;
  reduceMotion: () => boolean;
  onPress: () => void;
};

function DockTab({
  name,
  label,
  active,
  icon,
  progress,
  reduceMotion,
  onPress,
}: DockTabProps) {
  const theme = useTheme();
  const [focusProgress] = useState(() => new Animated.Value(active ? 1 : 0));
  useEffect(() => {
    if (reduceMotion()) {
      focusProgress.setValue(active ? 1 : 0);
      return;
    }
    Animated.timing(focusProgress, {
      toValue: active ? 1 : 0,
      duration: active ? 190 : 130,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, focusProgress, reduceMotion]);
  const iconScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.82],
  });
  const labelHeight = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 0],
  });
  const labelOpacity = progress.interpolate({
    inputRange: [0, 0.62, 1],
    outputRange: [1, 0, 0],
  });
  const focusScale = focusProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.9, 1],
  });
  return (
    <TabTrigger
      name={name}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        {
          opacity: pressed ? 0.68 : 1,
        },
      ]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.focusIndicator,
          {
            backgroundColor: theme.accentSoft,
            opacity: focusProgress,
            transform: [{ scale: focusScale }],
          },
        ]}
      />
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        <Animated.View style={{ transform: [{ scale: focusScale }] }}>
          <AppIcon
            name={icon}
            size={22}
            tintColor={active ? theme.accent : theme.textMuted}
            fallback="•"
          />
        </Animated.View>
      </Animated.View>
      <Animated.Text
        numberOfLines={1}
        style={[
          styles.label,
          {
            color: active ? theme.accent : theme.textMuted,
            height: labelHeight,
            opacity: labelOpacity,
          },
        ]}>
        {label}
      </Animated.Text>
    </TabTrigger>
  );
}

const styles = StyleSheet.create({
  position: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 100,
    elevation: 18,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 1,
    shadowRadius: 30,
  },
  content: {
    flex: 1,
  },
  dock: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.half,
    padding: 5,
    borderWidth: 1,
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: Radius.control,
    overflow: 'hidden',
  },
  focusIndicator: {
    ...StyleSheet.absoluteFill,
    borderRadius: Radius.control,
  },
  label: {
    fontFamily: Fonts.medium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: -0.11,
    fontWeight: 500,
  },
});
