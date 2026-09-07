import { createElement, StrictMode, useLayoutEffect, useState, type ReactNode } from 'react';
import TestRenderer from 'react-test-renderer';
import { Platform, Text } from 'react-native';

import { RouteStack } from './route-stack';

const mockEntrance = {
  arm: jest.fn(), settle: jest.fn(), play: jest.fn(), reset: jest.fn(), style: {},
};
const mockSetNativeProps = jest.fn();
const mockChildCleanup = jest.fn();
let mockFocused = true;
type AppearanceListener = (event: { data: { closing: boolean } }) => void;
let mockListener: AppearanceListener | undefined;
const mockNavigation = {
  addListener: (_event: string, listener: AppearanceListener) => {
    mockListener = listener;
    return () => { if (mockListener === listener) mockListener = undefined; };
  },
  isFocused: () => mockFocused,
};

jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  // One screen, wrapped exactly as the navigator wraps each of its own.
  Stack: ({ screenLayout, children }: {
    screenLayout: (props: {
      navigation: typeof mockNavigation;
      children: ReactNode;
    }) => ReactNode;
    children: ReactNode;
  }) => screenLayout({ navigation: mockNavigation, children }),
}));
jest.mock('@/components/ui/app-background', () => ({ AppBackground: () => null }));
jest.mock('@/components/ui/blur-backdrop', () => ({
  BlurBackdropProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('react-native/Libraries/Components/View/View', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockView(props: { children?: ReactNode }, ref) {
      React.useImperativeHandle(ref, () => ({ setNativeProps: mockSetNativeProps }));
      return React.createElement('View', props, props.children);
    }),
  };
});
jest.mock('./screen-entrance', () => ({ useScreenEntrance: () => mockEntrance }));
jest.mock('./stack-screen-options', () => ({ useStackScreenOptions: () => ({ animation: 'none' }) }));

describe('stack page arrivals', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let mounts: number;
  const nativeRoot = { setNativeProps: mockSetNativeProps };
  const originalOS = Platform.OS;

  function Draft() {
    const [value] = useState(() => { mounts++; return 'Unsaved name'; });
    useLayoutEffect(() => () => mockChildCleanup(), []);
    return createElement(Text, null, value);
  }
  function render(blurBackdrop = false) {
    const page = createElement(RouteStack, { quiet: true, blurBackdrop }, createElement(Draft));
    TestRenderer.act(() => {
      if (renderer) renderer.update(page);
      else renderer = TestRenderer.create(page);
    });
  }
  function appear(closing = false) {
    TestRenderer.act(() => mockListener?.({ data: { closing } }));
  }
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockFocused = true;
    Platform.OS = 'android';
    mockListener = undefined;
    mounts = 0;
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    Platform.OS = originalOS;
    jest.useRealTimers();
  });

  it('offsets a pushed page before it is drawn, and closes the gap when it appears', () => {
    render();
    // Armed inside the mount, so the first frame anyone sees is already offset.
    expect(mockEntrance.arm.mock.calls).toEqual([[1]]);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });

  it('settles once, and never for a page on its way out', () => {
    render();
    appear(true);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear();
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });

  it('does not replay for ordinary re-renders, and keeps mounted form state', () => {
    render();
    appear();
    render();
    render();
    expect(mockEntrance.arm.mock.calls).toEqual([[1]]);
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
    expect(renderer?.root.findByType(Text).props.children).toBe('Unsaved name');
  });

  it('stops while covered and comes back the other way round', () => {
    render();
    appear();
    jest.clearAllMocks();
    mockFocused = false;
    render();
    expect(mockEntrance.reset).toHaveBeenCalledTimes(1);
    expect(mockEntrance.arm).not.toHaveBeenCalled();
    mockFocused = true;
    render();
    expect(mockEntrance.arm.mock.calls).toEqual([[-1]]);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });

  it('treats a page first shown after mounting in the background as a forward arrival', () => {
    mockFocused = false;
    render();
    expect(mockEntrance.arm).not.toHaveBeenCalled();
    mockFocused = true;
    render();
    expect(mockEntrance.arm.mock.calls).toEqual([[1]]);
  });

  it('settles anyway when a page is uncovered without an appearance of its own', () => {
    render();
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    TestRenderer.act(() => { jest.advanceTimersByTime(120); });
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
    // And the late arrival does not settle a second time.
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });

  it('drops a pending settle when the page is covered before it arrives', () => {
    render();
    mockFocused = false;
    render();
    TestRenderer.act(() => { jest.advanceTimersByTime(500); });
    expect(mockEntrance.settle).not.toHaveBeenCalled();
  });

  it('cuts Android blur-backed stacks before child teardown rather than leaving orphaned chrome', () => {
    render(true);
    expect(nativeRoot.setNativeProps).toHaveBeenLastCalledWith({ style: { opacity: 1 } });
    nativeRoot.setNativeProps.mockClear();
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(nativeRoot.setNativeProps.mock.calls).toEqual([[{ style: { opacity: 0 } }]]);
    expect(nativeRoot.setNativeProps.mock.invocationCallOrder[0])
      .toBeLessThan(mockChildCleanup.mock.invocationCallOrder[0]);
  });

  it('keeps covered stacks visible and preserves their mounted state', () => {
    render(true);
    nativeRoot.setNativeProps.mockClear();
    mockFocused = false;
    render(true);
    mockFocused = true;
    render(true);
    expect(nativeRoot.setNativeProps).not.toHaveBeenCalled();
    expect(mounts).toBe(1);
  });

  it('restores visibility when backdrop configuration changes', () => {
    render(true);
    nativeRoot.setNativeProps.mockClear();
    render(false);
    expect(nativeRoot.setNativeProps.mock.calls).toEqual([
      [{ style: { opacity: 0 } }], [{ style: { opacity: 1 } }],
    ]);
  });

  it('restores the native root after Strict Mode replays layout effects', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(StrictMode, null,
        createElement(RouteStack, { blurBackdrop: true }, createElement(Draft))));
    });
    expect(nativeRoot.setNativeProps.mock.calls).toEqual([
      [{ style: { opacity: 1 } }],
      [{ style: { opacity: 0 } }],
      [{ style: { opacity: 1 } }],
    ]);
  });

  it.each(['ios', 'web'] as const)('does not change native opacity on %s', (platform) => {
    Platform.OS = platform;
    render(true);
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(nativeRoot.setNativeProps).not.toHaveBeenCalled();
  });

  it('does not hide stacks without a blur backdrop on teardown', () => {
    render(false);
    nativeRoot.setNativeProps.mockClear();
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(nativeRoot.setNativeProps).not.toHaveBeenCalled();
  });
});
