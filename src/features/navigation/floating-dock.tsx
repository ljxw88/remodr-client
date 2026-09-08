import { TabTrigger } from 'expo-router/ui';
import { useNavigation, usePathname } from 'expo-router';
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
} from 'react';
import {
  Animated,
  StyleSheet,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Motion } from '@/constants/motion';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useScreenEntrance } from '@/features/navigation/screen-entrance';
import type { StackNavigation } from '@/features/navigation/stack-screen-options';
import { useReduceMotion, useReducedMotion } from '@/hooks/use-reduce-motion';
import { useTheme } from '@/hooks/use-theme';
import { useForeground } from '@/hooks/use-foreground';

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
  const shouldReduceMotion = useReduceMotion();
  const reducedMotion = useReducedMotion();
  const foreground = useForeground();
  const visible = foreground && TabRoutes.includes(pathname);
  const visibleRef = useRef(visible);
  const collapsed = useRef(false);
  const lastOffset = useRef(0);
  const direction = useRef<1 | -1 | 0>(0);
  const directionStart = useRef(0);

  // Persistent geometry only — one easing, one duration, for either direction.
  // Nothing overshoots past the collapsed or expanded size it is heading for.
  const setCollapsed = useCallback(
    (next: boolean) => {
      if (collapsed.current === next) {
        return;
      }
      collapsed.current = next;
      progress.stopAnimation();
      if (shouldReduceMotion() || !visibleRef.current) {
        progress.setValue(next ? 1 : 0);
        return;
      }
      Animated.timing(progress, {
        toValue: next ? 1 : 0,
        duration: Motion.duration.disclosure,
        easing: Motion.easing.standard,
        useNativeDriver: false,
        isInteraction: false,
      }).start();
    },
    [progress, shouldReduceMotion],
  );

  // If reduced motion switches on mid-flight, the dock must not keep sliding:
  // stop wherever it is and snap straight to the resting size it belongs to.
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!reducedMotion && visible) return;
    progress.stopAnimation();
    progress.setValue(collapsed.current ? 1 : 0);
  }, [progress, reducedMotion, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

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

/**
 * Where each tab lives, in the order they sit in the dock.
 *
 * Doubles as the test for whether the tabs are the top of the stack at all: a
 * route pushed over them keeps them mounted but out of sight, and `usePathname`
 * is global, so while covered it reports the route on top rather than the tab
 * still underneath it.
 */
const TabRoutes = ['/', '/servers', '/settings'];

export function AnimatedTabContent({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const navigation = useNavigation<StackNavigation>();
  const covered = !TabRoutes.includes(pathname);
  const tabIndex = covered ? -1 : TabRoutes.indexOf(pathname);
  const previousIndex = useRef(tabIndex);
  const wasCovered = useRef(covered);
  const mounted = useRef(false);
  const pendingReturn = useRef(false);
  const entrance = useScreenEntrance();

  // Only the settle waits here. The offset itself went on the moment the dock
  // was uncovered, while the page being dismissed was still covering it.
  useLayoutEffect(() => navigation.addListener('transitionEnd', (event) => {
    if (event.data.closing || !pendingReturn.current || !navigation.isFocused()) return;
    pendingReturn.current = false;
    entrance.settle();
  }), [entrance, navigation]);

  useLayoutEffect(() => {
    // The content stays mounted across a tab change, so the first pass is the
    // app opening rather than a change of place and has nothing to settle.
    if (!mounted.current) {
      mounted.current = true;
      previousIndex.current = tabIndex;
      wasCovered.current = covered;
      return;
    }

    // Nothing to settle while something is drawn over us, and nothing worth
    // remembering either — the tab underneath has not changed, so the index we
    // are already holding is still the one to come back to.
    if (covered) {
      wasCovered.current = true;
      pendingReturn.current = false;
      entrance.reset();
      return;
    }

    // The pathname changes before the root fragment reappears, so the offset
    // can simply be put in place: nothing can see it until the closing page is
    // gone. Only closing the gap has to wait for that native arrival, or it is
    // spent underneath a page that is still on top.
    if (wasCovered.current || pendingReturn.current) {
      wasCovered.current = false;
      previousIndex.current = tabIndex;
      pendingReturn.current = true;
      entrance.arm(-1);
      return;
    }

    const direction = tabIndex >= previousIndex.current ? 1 : -1;
    previousIndex.current = tabIndex;
    entrance.play(direction);
  }, [covered, entrance, tabIndex]);

  return (
    <Animated.View style={[styles.content, entrance.style]}>
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

export function FloatingDock() {
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
      testID="floating-dock"
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
      <GlassSurface tone="chrome" strength="strong" style={styles.dock}>
        <DockTab
          name="agents"
          label="Agents"
          active={pathname === '/'}
          icon={{ ios: 'terminal', android: 'smart_toy', web: 'smart_toy' }}
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
      </GlassSurface>
    </Animated.View>
  );
}

type DockTabProps = {
  name: 'agents' | 'servers' | 'settings';
  label: string;
  active: boolean;
  icon: AppIconName;
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
  const reducedMotionChanged = useReducedMotion();
  const foreground = useForeground();
  const pathname = usePathname();
  const visible = foreground && TabRoutes.includes(pathname);
  const previousActive = useRef(active);

  // Selection is a fade of the indicator alone — nothing here scales, so there
  // is nothing for a nested icon transform to fight for the same emphasis.
  useEffect(() => {
    const changed = previousActive.current !== active;
    previousActive.current = active;
    if (reduceMotion() || reducedMotionChanged || !visible || !changed) {
      focusProgress.stopAnimation();
      focusProgress.setValue(active ? 1 : 0);
      return;
    }
    const animation = Animated.timing(focusProgress, {
      toValue: active ? 1 : 0,
      duration: Motion.duration.fade,
      easing: active ? Motion.easing.entrance : Motion.easing.exit,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [active, focusProgress, reduceMotion, reducedMotionChanged, visible]);

  // A preference flip mid-fade must not leave the indicator part-way visible.
  useEffect(() => {
    if (!reducedMotionChanged && visible) return;
    focusProgress.stopAnimation();
    focusProgress.setValue(active ? 1 : 0);
  }, [active, focusProgress, reducedMotionChanged, visible]);

  useEffect(() => () => focusProgress.stopAnimation(), [focusProgress]);

  // Icon scale is reserved for the dock actually collapsing (driven by
  // `progress`); tab selection no longer scales it, so there is one transform
  // level here rather than a nested pair fighting for the same emphasis.
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
          opacity: pressed ? 0.68 : 1,
        },
      ]}>
      <Animated.View
        testID={`dock-focus-${name}`}
        pointerEvents="none"
        style={[
          styles.focusIndicator,
          {
            backgroundColor: theme.accentSoft,
            borderColor: theme.glassBorder,
            opacity: focusProgress,
          },
        ]}
      />
      <Animated.View testID={`dock-icon-${name}`} style={{ transform: [{ scale: iconScale }] }}>
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
  content: {
    flex: 1,
  },
  dock: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.half,
    padding: 5,
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
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  label: {
    fontFamily: Fonts.medium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: -0.11,
    fontWeight: 500,
  },
});
