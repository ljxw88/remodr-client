import { createElement, type Ref } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated, Modal } from 'react-native';

import { ActionMenu, ENTRY_OFFSET, menuPosition } from './action-menu';
import { Motion } from '@/constants/motion';

let mockFocused = true;
let mockReduceMotion = false;
let mockReducedMotion = false;
let mockForeground = true;
const mockShouldReduceMotion = () => mockReduceMotion;

jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({ glassRim: () => ({}) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native/Libraries/Components/View/View', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: react.forwardRef(function MockView(props: object, ref: Ref<unknown>) {
      react.useImperativeHandle(ref, () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
          callback(0, 0, 40, 40),
        setNativeProps: () => undefined,
      }));
      return react.createElement('View', props);
    }),
  };
});
jest.mock('@/hooks/use-reduce-motion', () => ({
  useReduceMotion: () => mockShouldReduceMotion,
  useReducedMotion: () => mockReducedMotion,
}));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));

describe('anchored menu positioning', () => {
  const viewport = { width: 390, height: 844, top: 44, bottom: 34 };
  it('aligns to the tapped control while remaining in the safe viewport', () => {
    expect(menuPosition({ x: 334, y: 52, width: 40, height: 40 }, { width: 260, height: 160 }, viewport))
      .toEqual({ left: 114, top: 100 });
  });
  it('clamps long menus away from the bottom system area', () => {
    const position = menuPosition({ x: 320, y: 730, width: 40, height: 40 }, { width: 260, height: 300 }, viewport);
    expect(position.top).toBe(494);
    expect(position.left).toBeGreaterThanOrEqual(16);
  });
  it('keeps left-edge triggers on screen', () => {
    expect(menuPosition({ x: 10, y: 44, width: 40, height: 40 }, { width: 260, height: 160 }, viewport).left).toBe(16);
  });
});

describe('action menu motion', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let timingSpy: jest.SpyInstance;
  const onFirst = jest.fn();
  const items = [
    { id: 'first', label: 'First', onPress: onFirst },
    { id: 'second', label: 'Second', onPress: jest.fn() },
  ];

  // `Animated.timing(...).start()` would otherwise try to connect the
  // animated node to a real native view, which the mocked host component
  // below cannot satisfy. Stubbing it keeps the assertions focused on what
  // this component controls — the config each animation is given, and when
  // it is told to start — without needing a real native animation driver.
  function fakeAnimation(): Animated.CompositeAnimation {
    return { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  }

  function open(showNative = true) {
    const trigger = renderer.root.findByProps({ testID: 'action-menu-trigger' });
    TestRenderer.act(() => trigger.props.onPress());
    if (showNative) TestRenderer.act(() => renderer.root.findByType(Modal).props.onShow());
  }

  function surface() {
    return renderer.root.findByProps({ testID: 'action-menu-surface' });
  }

  function overlay() {
    return renderer.root.findByProps({ testID: 'action-menu-overlay' });
  }

  function isMounted() {
    return renderer.root.findAllByProps({ testID: 'action-menu-surface' }).length > 0;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockReduceMotion = false;
    mockReducedMotion = false;
    mockForeground = true;
    timingSpy = jest.spyOn(Animated, 'timing').mockImplementation(fakeAnimation);
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(ActionMenu, { label: 'Actions', items }));
    });
  });
  afterEach(() => { TestRenderer.act(() => renderer.unmount()); jest.restoreAllMocks(); });

  it('starts entry only after the native modal is actually shown', () => {
    open(false);
    expect(timingSpy).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.root.findByType(Modal).props.onShow());
    expect(timingSpy).toHaveBeenCalledTimes(2);
    TestRenderer.act(() => renderer.root.findByType(Modal).props.onShow());
    expect(timingSpy).toHaveBeenCalledTimes(2);
  });

  it('prepares the small entry offset again after a completed explicit close', () => {
    open();
    TestRenderer.act(() => renderer.root.findByProps({ testID: 'action-menu-backdrop' }).props.onPress());
    const exit = timingSpy.mock.calls.findIndex(([, config]) => config.duration === Motion.duration.feedback);
    const finish = timingSpy.mock.results[exit].value.start.mock.calls[0][0];
    TestRenderer.act(() => finish({ finished: true }));
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    open(false);
    expect(setValue).toHaveBeenLastCalledWith(ENTRY_OFFSET);
  });

  it('keeps the entry within the small anchored budget: a fade plus at most 4dp of movement', () => {
    expect(ENTRY_OFFSET).toBeLessThanOrEqual(4);
    open();
    const calls = timingSpy.mock.calls.map(([, config]) => config);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toValue: 1, duration: Motion.duration.reveal, easing: Motion.easing.entrance }),
        expect.objectContaining({ toValue: 0, duration: Motion.duration.reveal, easing: Motion.easing.entrance }),
      ]),
    );
    expect(Motion.duration.reveal).toBeGreaterThanOrEqual(110);
    expect(Motion.duration.reveal).toBeLessThanOrEqual(150);
  });

  it('plays a short exit only for an explicit dismissal, and disables hit-testing the instant it starts', () => {
    open();
    timingSpy.mockClear();
    const backdrop = renderer.root.findByProps({ testID: 'action-menu-backdrop' });
    TestRenderer.act(() => backdrop.props.onPress());

    // Disabled immediately, before the fade has any chance to finish.
    expect(overlay().props.pointerEvents).toBe('none');
    expect(surface().props.accessibilityElementsHidden).toBe(true);
    expect(surface().props.importantForAccessibility).toBe('no-hide-descendants');
    // Still mounted mid-fade so the surface can actually be seen leaving.
    expect(isMounted()).toBe(true);

    expect(timingSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 0, duration: Motion.duration.feedback, easing: Motion.easing.exit }),
    );
    expect(Motion.duration.feedback).toBeGreaterThanOrEqual(70);
    expect(Motion.duration.feedback).toBeLessThanOrEqual(110);
  });

  it('finishes the close once the exit animation naturally completes', () => {
    open();
    const backdrop = renderer.root.findByProps({ testID: 'action-menu-backdrop' });
    TestRenderer.act(() => {
      backdrop.props.onPress();
    });
    // Grab the exit animation's completion callback via the mocked call args.
    const exitCallIndex = timingSpy.mock.calls.findIndex(
      ([, config]) => config.toValue === 0 && config.duration === Motion.duration.feedback,
    );
    expect(exitCallIndex).toBeGreaterThanOrEqual(0);
    const exitAnimation = timingSpy.mock.results[exitCallIndex].value;
    const startCalls = (exitAnimation.start as jest.Mock).mock.calls;
    const finish = startCalls[startCalls.length - 1][0];
    TestRenderer.act(() => finish?.({ finished: true }));
    expect(isMounted()).toBe(false);
  });

  it('does not let a stale exit completion dismiss a menu that has since reopened', () => {
    open();
    const backdrop = renderer.root.findByProps({ testID: 'action-menu-backdrop' });
    TestRenderer.act(() => backdrop.props.onPress());
    const exitCallIndex = timingSpy.mock.calls.findIndex(
      ([, config]) => config.toValue === 0 && config.duration === Motion.duration.feedback,
    );
    const exitAnimation = timingSpy.mock.results[exitCallIndex].value;
    const startCalls = (exitAnimation.start as jest.Mock).mock.calls;
    const staleCompletion = startCalls[startCalls.length - 1][0];

    // Rapid reopen before the stale exit's completion callback ever runs.
    open();
    expect(isMounted()).toBe(true);
    TestRenderer.act(() => staleCompletion?.({ finished: true }));
    expect(isMounted()).toBe(true);
    expect(overlay().props.pointerEvents).toBe('auto');
  });

  it('dismisses immediately on selecting an item, never waiting on animation, and ignores a rapid second tap', () => {
    open();
    timingSpy.mockClear();
    const [firstItem] = renderer.root.findAllByProps({ accessibilityRole: 'menuitem' });
    TestRenderer.act(() => {
      firstItem.props.onPress();
      firstItem.props.onPress();
    });
    expect(onFirst).toHaveBeenCalledTimes(1);
    // Torn down synchronously, in the very same act(): no exit animation was
    // started to finish an incoming page's transition on.
    expect(isMounted()).toBe(false);
    expect(timingSpy).not.toHaveBeenCalled();
  });

  it('tears the menu down without animating when the system asks for reduced motion', () => {
    mockReduceMotion = true;
    mockReducedMotion = true;
    open();
    expect(timingSpy).not.toHaveBeenCalled();
    expect(isMounted()).toBe(true);
    const backdrop = renderer.root.findByProps({ testID: 'action-menu-backdrop' });
    TestRenderer.act(() => backdrop.props.onPress());
    expect(timingSpy).not.toHaveBeenCalled();
    expect(isMounted()).toBe(false);
  });

  it('snaps a mid-open entry straight to fully shown if reduced motion turns on while it is animating', () => {
    open();
    expect(timingSpy).toHaveBeenCalled();
    mockReducedMotion = true;
    TestRenderer.act(() => {
      renderer.update(createElement(ActionMenu, { label: 'Actions', items }));
    });
    expect(isMounted()).toBe(true);
    expect(overlay().props.pointerEvents).toBe('auto');
  });

  it('finishes a mid-close exit immediately, rather than stranding it, if reduced motion turns on while closing', () => {
    open();
    const backdrop = renderer.root.findByProps({ testID: 'action-menu-backdrop' });
    TestRenderer.act(() => backdrop.props.onPress());
    expect(isMounted()).toBe(true);
    mockReducedMotion = true;
    TestRenderer.act(() => {
      renderer.update(createElement(ActionMenu, { label: 'Actions', items }));
    });
    expect(isMounted()).toBe(false);
  });

  it('tears the menu down without animation when the screen loses focus', () => {
    open();
    expect(isMounted()).toBe(true);
    mockFocused = false;
    TestRenderer.act(() => {
      renderer.update(createElement(ActionMenu, { label: 'Actions', items }));
    });
    expect(isMounted()).toBe(false);
  });

  it('drops the modal and late native events on background, even while the route remains focused', () => {
    open(false);
    const onShow = renderer.root.findByType(Modal).props.onShow;
    mockForeground = false;
    TestRenderer.act(() => renderer.update(createElement(ActionMenu, { label: 'Actions', items })));
    expect(isMounted()).toBe(false);
    TestRenderer.act(() => onShow());
    expect(timingSpy).not.toHaveBeenCalled();
    mockForeground = true;
    TestRenderer.act(() => renderer.update(createElement(ActionMenu, { label: 'Actions', items })));
    expect(isMounted()).toBe(false);
  });

  it('rejects item callbacks from a dismissed or previous opening', () => {
    open();
    const stalePress = renderer.root.findAllByProps({ accessibilityRole: 'menuitem' })[0].props.onPress;
    TestRenderer.act(() => renderer.root.findByProps({ testID: 'action-menu-backdrop' }).props.onPress());
    TestRenderer.act(() => stalePress());
    expect(onFirst).not.toHaveBeenCalled();
    open();
    TestRenderer.act(() => stalePress());
    expect(onFirst).not.toHaveBeenCalled();
  });
});
