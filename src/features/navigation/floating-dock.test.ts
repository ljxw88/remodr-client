import { createElement, useEffect } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated } from 'react-native';

import {
  AnimatedTabContent,
  DockMotionProvider,
  FloatingDock,
  useDockScrollHandler,
} from './floating-dock';
import { Motion } from '@/constants/motion';

let mockPathname = '/';
let mockOnTransition: ((event: { data: { closing: boolean } }) => void) | undefined;
let mockReduceMotion = false;
let mockReducedMotion = false;
let mockForeground = true;
const mockShouldReduceMotion = () => mockReduceMotion;
const mockEntrance = {
  arm: jest.fn(), settle: jest.fn(), play: jest.fn(), reset: jest.fn(), style: {},
};
const mockNavigation = {
  addListener: (_event: string, listener: NonNullable<typeof mockOnTransition>) => {
    mockOnTransition = listener;
    return () => { if (mockOnTransition === listener) mockOnTransition = undefined; };
  },
  isFocused: () => ['/', '/servers', '/settings'].includes(mockPathname),
};

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useNavigation: () => mockNavigation,
}));
jest.mock('expo-router/ui', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  // A passthrough stand-in: real enough to carry `onPress`/`style`/children
  // through so a tab press and its rendered contents can both be inspected.
  return {
    TabTrigger: ({ name, onPress, style, accessibilityLabel, accessibilityState, children }: {
      name: string; onPress?: () => void; style?: unknown; accessibilityLabel?: string;
      accessibilityState?: unknown; children?: unknown;
    }) => react.createElement('View', {
      testID: `dock-tab-${name}`,
      onPress,
      accessibilityLabel,
      accessibilityState,
      style: typeof style === 'function' ? style({ pressed: false }) : style,
    }, children),
  };
});
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return { GlassSurface: ({ children, style }: { children?: unknown; style?: unknown }) =>
    react.createElement('View', { style }, children) };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/hooks/use-reduce-motion', () => ({
  useReduceMotion: () => mockShouldReduceMotion,
  useReducedMotion: () => mockReducedMotion,
}));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true, default: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
jest.mock('./screen-entrance', () => ({ useScreenEntrance: () => mockEntrance }));

describe('dock page motion', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  function navigate(path: string) {
    mockPathname = path;
    TestRenderer.act(() => renderer.update(createElement(AnimatedTabContent)));
  }
  function appear(closing = false) {
    TestRenderer.act(() => mockOnTransition?.({ data: { closing } }));
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = '/';
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AnimatedTabContent)); });
  });
  afterEach(() => TestRenderer.act(() => renderer.unmount()));

  it('animates tab changes in dock order but not initial mounting or unchanged routes', () => {
    expect(mockEntrance.play).not.toHaveBeenCalled();
    navigate('/servers');
    navigate('/servers');
    navigate('/');
    expect(mockEntrance.play.mock.calls).toEqual([[1], [-1]]);
  });

  it('offsets the dock the moment it is uncovered, and closes the gap on the native arrival', () => {
    navigate('/flows/models');
    expect(mockEntrance.reset).toHaveBeenCalled();
    appear();
    navigate('/');
    // Armed straight away: the page being dismissed is still covering it.
    expect(mockEntrance.arm.mock.calls).toEqual([[-1]]);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear(true);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear();
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
    expect(mockEntrance.play).not.toHaveBeenCalled();
  });

  it('cancels a pending return if another page covers the dock', () => {
    navigate('/agents/one');
    navigate('/');
    expect(mockEntrance.arm).toHaveBeenCalledWith(-1);
    navigate('/flows/rename-agent');
    // Covering it again puts the offset back, so nothing is left displaced.
    expect(mockEntrance.reset).toHaveBeenCalled();
    appear();
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    navigate('/settings');
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });
});

describe('dock geometry and focus motion', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let timingSpy: jest.SpyInstance;
  let stopAnimationSpy: jest.SpyInstance;
  let capturedScroll: ((event: { nativeEvent: { contentOffset: { y: number } } }) => void) | undefined;

  // Real `Animated.timing(...).start()` with `useNativeDriver: true` (the
  // focus indicator's fade) tries to connect to a real native view, which
  // does not exist in this test environment. Stubbing it keeps assertions on
  // the config each animation is given rather than on a real native driver.
  function fakeAnimation(): Animated.CompositeAnimation {
    return { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  }

  function ScrollCapture() {
    const handler = useDockScrollHandler();
    useEffect(() => { capturedScroll = handler; }, [handler]);
    return null;
  }

  function scrollTo(offsetY: number) {
    TestRenderer.act(() => capturedScroll?.({ nativeEvent: { contentOffset: { y: offsetY } } }));
  }

  function dock() {
    return renderer.root.findByProps({ testID: 'floating-dock' });
  }

  function rerender() {
    const element = createElement(
      DockMotionProvider,
      null,
      createElement(FloatingDock),
      createElement(ScrollCapture),
    );
    TestRenderer.act(() => renderer.update(element));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = '/';
    mockReduceMotion = false;
    mockReducedMotion = false;
    mockForeground = true;
    capturedScroll = undefined;
    timingSpy = jest.spyOn(Animated, 'timing').mockImplementation(fakeAnimation);
    stopAnimationSpy = jest.spyOn(Animated.Value.prototype, 'stopAnimation');
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(
        DockMotionProvider,
        null,
        createElement(FloatingDock),
        createElement(ScrollCapture),
      ));
    });
  });
  afterEach(() => { TestRenderer.act(() => renderer.unmount()); jest.restoreAllMocks(); });

  it('collapses and expands with one shared easing and duration — no overshoot in either direction', () => {
    scrollTo(100); // past the collapse thresholds in a single downward step
    scrollTo(0); // back to the top, which always expands

    // Geometry (width/height/position) always animates without the native
    // driver; the focus indicator's fade is the only native-driven timing,
    // so filtering it out isolates the dock's own persistent-geometry moves.
    const geometryCalls = timingSpy.mock.calls
      .map(([, config]) => config)
      .filter((config) => config.useNativeDriver === false);
    expect(geometryCalls.length).toBeGreaterThanOrEqual(2);
    for (const config of geometryCalls) {
      expect(config.duration).toBe(Motion.duration.disclosure);
      expect(config.easing).toBe(Motion.easing.standard);
    }
    // No asymmetric durations and no bounce/back easing left over.
    const durations = new Set(geometryCalls.map((config) => config.duration));
    expect(durations.size).toBe(1);
  });

  it('cancels the in-flight collapse and snaps straight to the resting size when reduced motion turns on', () => {
    scrollTo(100);
    expect(timingSpy).toHaveBeenCalled();
    stopAnimationSpy.mockClear();

    mockReducedMotion = true;
    rerender();

    expect(stopAnimationSpy).toHaveBeenCalled();
    const widthStyle = dock().props.style.find((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'width' in entry) as { width: { __getValue(): number } };
    // Collapsed geometry, applied instantly rather than mid-animation.
    expect(widthStyle.width.__getValue()).toBeLessThan(292 + 1);
  });

  it('stops any running geometry animation on unmount instead of leaving it dangling', () => {
    scrollTo(100);
    stopAnimationSpy.mockClear();
    TestRenderer.act(() => renderer.unmount());
    expect(stopAnimationSpy).toHaveBeenCalled();
  });

  it('fades the focus indicator alone on selection, with no transform on the indicator', () => {
    mockPathname = '/servers';
    rerender();

    const enterCall = timingSpy.mock.calls.find(([, config]) => config.toValue === 1);
    const exitCall = timingSpy.mock.calls.find(([, config]) => config.toValue === 0 && config.duration === Motion.duration.fade);
    expect(enterCall?.[1]).toMatchObject({ duration: Motion.duration.fade, easing: Motion.easing.entrance });
    expect(exitCall?.[1]).toMatchObject({ duration: Motion.duration.fade, easing: Motion.easing.exit });

    const indicator = renderer.root.findByProps({ testID: 'dock-focus-servers' });
    const flatStyle = ([] as unknown[]).concat(indicator.props.style);
    for (const entry of flatStyle) {
      expect(entry && typeof entry === 'object' ? 'transform' in entry : false).toBe(false);
    }
  });

  it('keeps the icon at a single transform level — selection no longer nests a second scale', () => {
    const iconWrapper = renderer.root.findByProps({ testID: 'dock-icon-agents' });
    // Exactly the icon itself below the scaling wrapper — no intermediate
    // Animated.View left over for a second, focus-driven scale.
    expect(iconWrapper.children).toHaveLength(1);
    expect(iconWrapper.children[0]).not.toBe(Animated.View);
    if (typeof iconWrapper.children[0] !== 'string') {
      expect(iconWrapper.children[0].type).not.toBe(Animated.View);
    }
  });

  it('does not animate the indicator when reduced motion is already on, snapping directly instead', () => {
    mockReduceMotion = true;
    mockReducedMotion = true;
    mockPathname = '/servers';
    // Only calls made by *this* transition matter — clear the sync-on-mount
    // calls made while the tree was first created with motion still enabled.
    timingSpy.mockClear();
    rerender();
    expect(timingSpy).not.toHaveBeenCalled();
  });

  it('stops hidden motion and does not replay focus feedback on foreground return', () => {
    scrollTo(100);
    timingSpy.mockClear();
    stopAnimationSpy.mockClear();
    mockForeground = false;
    rerender();
    expect(stopAnimationSpy).toHaveBeenCalled();
    expect(timingSpy).not.toHaveBeenCalled();
    mockForeground = true;
    rerender();
    expect(timingSpy).not.toHaveBeenCalled();
  });
});
