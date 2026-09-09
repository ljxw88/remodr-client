import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated, ScrollView } from 'react-native';

import { MarqueeText } from './marquee-text';
import { ScrollViewportContext } from './scroll-viewport-context';
import type { LayoutRectangle } from 'react-native';

let mockReduced = false;
let mockForeground = true;
let mockY = 100;
const mockScrollTo = jest.fn();
const viewport: { current: LayoutRectangle | null } = { current: null };
jest.mock('@/hooks/use-app-settings', () => ({ useAppSettings: () => ({ marqueeEnabled: true }) }));
jest.mock('@/hooks/use-reduce-motion', () => ({ useReducedMotion: () => mockReduced }));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true, default: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
jest.mock('react-native/Libraries/Components/View/View', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: React.forwardRef(function MockView(props, ref) {
    React.useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(0, mockY, 100, 18),
      setNativeProps: () => undefined,
    }));
    return React.createElement('View', props);
  }) };
});
jest.mock('react-native/Libraries/Components/ScrollView/ScrollView', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: React.forwardRef(function MockScroll(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
    return React.createElement('ScrollView', props);
  }) };
});

describe('continuous marquee titles', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let finish: ((result: { finished: boolean }) => void) | undefined;
  const start = jest.fn((callback) => { finish = callback; });
  const stop = jest.fn(() => finish?.({ finished: false }));
  function render(active = true, text = 'A long title') {
    TestRenderer.act(() => {
      const element = createElement(ScrollViewportContext.Provider, { value: viewport },
        createElement(MarqueeText, { active }, text));
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  function measure() {
    TestRenderer.act(() => {
      renderer!.root.findAll((node) => typeof node.props.onLayout === 'function', { deep: false })[0]
        .props.onLayout({ nativeEvent: { layout: { width: 100 } } });
      renderer!.root.findByType(ScrollView).props.onContentSizeChange(260);
    });
  }
  beforeEach(() => {
    mockReduced = false; mockForeground = true; mockY = 100; finish = undefined;
    viewport.current = null;
    start.mockClear(); stop.mockClear(); mockScrollTo.mockClear();
    jest.useFakeTimers();
    jest.spyOn(global, 'setInterval');
    jest.spyOn(global, 'clearInterval');
    jest.spyOn(Animated, 'sequence').mockReturnValue({ start, stop, reset: jest.fn() });
    jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount()); renderer = undefined;
    for (const result of jest.mocked(setInterval).mock.results) {
      if (result.type === 'return') expect(clearInterval).toHaveBeenCalledWith(result.value);
    }
    jest.clearAllTimers();
    jest.useRealTimers(); jest.restoreAllMocks();
  });

  it('loops while visible, cleans up its monitor, and keeps manual horizontal reading available', () => {
    render(); measure();
    expect(start).toHaveBeenCalledTimes(1);
    expect(Animated.loop).toHaveBeenCalledTimes(1);
    render(); measure();
    expect(start).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType(ScrollView).props.scrollEnabled).toBe(true);
    TestRenderer.act(() => renderer!.root.findByType(ScrollView).props.onScrollBeginDrag());
    expect(clearInterval).toHaveBeenCalledWith(jest.mocked(setInterval).mock.results[0].value);
  });

  it('does not start offscreen and stops when a running title scrolls out of view', () => {
    mockY = 1000; render(); measure();
    expect(start).not.toHaveBeenCalled();
    mockY = 100;
    TestRenderer.act(() => jest.advanceTimersByTime(250));
    expect(start).toHaveBeenCalledTimes(1);
    mockY = 1000;
    TestRenderer.act(() => jest.advanceTimersByTime(250));
    expect(stop).toHaveBeenCalled();
    expect(clearInterval).not.toHaveBeenCalled();
    mockY = 100;
    TestRenderer.act(() => jest.advanceTimersByTime(250));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('never runs while reduced, backgrounded or unfocused', () => {
    mockReduced = true; render(); measure();
    expect(start).not.toHaveBeenCalled();
    mockReduced = false; mockForeground = false; render();
    expect(start).not.toHaveBeenCalled();
    mockForeground = true; render(false);
    expect(start).not.toHaveBeenCalled();
    render(true);
    expect(start).toHaveBeenCalledTimes(1);
    mockReduced = true; render();
    expect(stop).toHaveBeenCalled();
    expect(clearInterval).toHaveBeenCalledWith(jest.mocked(setInterval).mock.results[0].value);
  });

  it('restarts when a retained screen becomes active on return', () => {
    render(); measure();
    expect(start).toHaveBeenCalledTimes(1);

    render(false);
    expect(start).toHaveBeenCalledTimes(1);
    render(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('uses the scroll viewport rather than mistaking clipped rows for visible window content', () => {
    viewport.current = { x: 0, y: 200, width: 390, height: 400 };
    render(); measure();
    expect(start).not.toHaveBeenCalled();
    viewport.current = { x: 0, y: 0, width: 390, height: 400 };
    render(true, 'Now visible');
    expect(start).toHaveBeenCalledTimes(1);
    viewport.current = { x: 0, y: 200, width: 390, height: 400 };
    TestRenderer.act(() => jest.advanceTimersByTime(250));
    expect(stop).toHaveBeenCalled();
  });
});
