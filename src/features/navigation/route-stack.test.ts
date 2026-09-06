import { createElement, useState, type ReactNode } from 'react';
import TestRenderer from 'react-test-renderer';
import { Text } from 'react-native';

import { RouteStack } from './route-stack';

const mockEntrance = {
  arm: jest.fn(), settle: jest.fn(), play: jest.fn(), reset: jest.fn(), style: {},
};
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
jest.mock('./screen-entrance', () => ({ useScreenEntrance: () => mockEntrance }));
jest.mock('./stack-screen-options', () => ({ useStackScreenOptions: () => ({ animation: 'none' }) }));

describe('stack page arrivals', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let mounts: number;

  function Draft() {
    const [value] = useState(() => { mounts++; return 'Unsaved name'; });
    return createElement(Text, null, value);
  }
  function render() {
    const page = createElement(RouteStack, { quiet: true }, createElement(Draft));
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
    mockListener = undefined;
    mounts = 0;
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
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
});
