import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated } from 'react-native';

import { useScreenEntrance } from './screen-entrance';

let mockReduceMotion = false;
const mockShouldReduceMotion = () => mockReduceMotion;
jest.mock('@/hooks/use-reduce-motion', () => ({ useReduceMotion: () => mockShouldReduceMotion }));

describe('shared screen motion', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let motion: ReturnType<typeof useScreenEntrance>;
  const start = jest.fn();
  function Probe() {
    motion = useScreenEntrance();
    return null;
  }
  beforeEach(() => {
    mockReduceMotion = false;
    start.mockClear();
    jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop: jest.fn(), reset: jest.fn() });
    jest.spyOn(Animated.Value.prototype, 'stopAnimation');
    jest.spyOn(Animated.Value.prototype, 'setValue');
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Probe)); });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer.unmount());
    jest.restoreAllMocks();
  });

  it('arms either direction without animating anything', () => {
    TestRenderer.act(() => motion.arm(1));
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(16);
    expect(Animated.timing).not.toHaveBeenCalled();
    TestRenderer.act(() => motion.arm(-1));
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(-16);
    expect(Animated.timing).not.toHaveBeenCalled();
  });

  it('settles with one short native-driven geometry animation, and no fade', () => {
    TestRenderer.act(() => motion.settle());
    expect(Animated.timing).toHaveBeenLastCalledWith(expect.any(Animated.Value), expect.objectContaining({
      toValue: 0, duration: 200, useNativeDriver: true, isInteraction: false,
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(motion.style).not.toHaveProperty('opacity');
  });

  it('arms and settles in one go for the dock, whose content is on screen throughout', () => {
    TestRenderer.act(() => motion.play(-1));
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(-16);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('skips motion and clears any existing offset when reduced motion is enabled', () => {
    mockReduceMotion = true;
    TestRenderer.act(() => motion.arm(1));
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(0);
    TestRenderer.act(() => motion.settle());
    expect(Animated.timing).not.toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(0);
  });

  it('keeps the controller stable across renders and stops on unmount', () => {
    const previous = motion;
    TestRenderer.act(() => renderer.update(createElement(Probe)));
    expect(motion).toBe(previous);
    TestRenderer.act(() => renderer.unmount());
    expect(Animated.Value.prototype.stopAnimation).toHaveBeenCalled();
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(0);
  });
});
