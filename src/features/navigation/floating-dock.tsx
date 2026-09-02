import { BlurView } from 'expo-blur';
import { TabTrigger } from 'expo-router/ui';
import { usePathname } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
    () => ({ progress, onScroll, expand }),
    [expand, onScroll, progress],
  );
  return (
    <DockMotionContext.Provider value={value}>
      {children}
    </DockMotionContext.Provider>
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
          onPress={motion.expand}
        />
        <DockTab
          name="servers"
          label="Servers"
          active={pathname === '/servers'}
          icon={{ ios: 'desktopcomputer', android: 'computer', web: 'computer' }}
          progress={motion.progress}
          onPress={motion.expand}
        />
        <DockTab
          name="settings"
          label="Settings"
          active={pathname === '/settings'}
          icon={{ ios: 'gear', android: 'settings', web: 'settings' }}
          progress={motion.progress}
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
  onPress: () => void;
};

function DockTab({
  name,
  label,
  active,
  icon,
  progress,
  onPress,
}: DockTabProps) {
  const theme = useTheme();
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
  return (
    <TabTrigger
      name={name}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        {
          backgroundColor: active ? theme.accentSoft : 'transparent',
          opacity: pressed ? 0.68 : 1,
        },
      ]}>
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        <AppIcon
          name={icon}
          size={22}
          tintColor={active ? theme.accent : theme.textMuted}
          fallback="•"
        />
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
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
