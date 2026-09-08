import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated } from 'react-native';

import { CONTENT_REVEAL_DURATION, useContentReveal } from './use-content-reveal';

let mockReducedMotion = false;
const mockReduced = () => mockReducedMotion;
const mockListeners = new Set<(enabled: boolean) => void>();
jest.mock('@/hooks/use-reduce-motion', () => ({
  useReduceMotion: () => mockReduced,
  subscribeReduceMotion: (listener: (enabled: boolean) => void) => {
    mockListeners.add(listener);
    return () => { mockListeners.delete(listener); };
  },
}));

describe('local skeleton content reveal', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let style: ReturnType<typeof useContentReveal>;
  const start = jest.fn();
  const stop = jest.fn();
  function Harness({ loading, scope }: { loading: boolean; scope: string }) {
    style = useContentReveal(loading, scope);
    return null;
  }
  function render(loading: boolean, scope = 'a') {
    TestRenderer.act(() => {
      const element = createElement(Harness, { loading, scope });
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  beforeEach(() => {
    mockReducedMotion = false;
    start.mockClear();
    stop.mockClear();
    jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop, reset: jest.fn() });
    jest.spyOn(Animated.Value.prototype, 'setValue');
    jest.spyOn(Animated.Value.prototype, 'stopAnimation');
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
    expect(mockListeners.size).toBe(0);
  });

  it('reveals real content with a brief native-driven fade only after a visible loading state', () => {
    render(true);
    expect(Animated.timing).not.toHaveBeenCalled();
    render(false);
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(0.35);
    expect(Animated.timing).toHaveBeenCalledWith(style.opacity, expect.objectContaining({
      toValue: 1, duration: CONTENT_REVEAL_DURATION, useNativeDriver: true, isInteraction: false,
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(style).not.toHaveProperty('transform');
  });

  it('does not animate cached arrivals, rerenders, streaming updates or an already-ready replacement scope', () => {
    render(false);
    render(false);
    render(false, 'cached-b');
    expect(Animated.timing).not.toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(1);
  });

  it('keeps opacity stable across data updates and re-arms only for a genuinely new load', () => {
    render(true);
    render(false);
    const opacity = style.opacity;
    render(false);
    expect(style.opacity).toBe(opacity);
    expect(start).toHaveBeenCalledTimes(1);
    render(true, 'b');
    expect(stop).toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(1);
    render(false, 'b');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('skips motion when requested and stops an active reveal if the setting changes', () => {
    render(true);
    mockReducedMotion = true;
    render(false);
    expect(start).not.toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(1);
    render(true, 'b');
    mockReducedMotion = false;
    render(false, 'b');
    expect(start).toHaveBeenCalledTimes(1);
    TestRenderer.act(() => mockListeners.forEach((listener) => listener(true)));
    expect(Animated.Value.prototype.stopAnimation).toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(1);
  });
});
