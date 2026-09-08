import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated } from 'react-native';

import { Motion } from '@/constants/motion';
import { useStatusFeedback } from './use-status-feedback';

let mockReduced = false;
let mockForeground = true;
jest.mock('@/hooks/use-reduce-motion', () => ({ useReducedMotion: () => mockReduced }));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));

describe('semantic status feedback', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const start = jest.fn();
  function Harness({ state, active }: { state: string | null; active: boolean }) {
    useStatusFeedback(state, active);
    return null;
  }
  function render(state: string | null, active = true) {
    TestRenderer.act(() => {
      const element = createElement(Harness, { state, active });
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  beforeEach(() => {
    mockReduced = false; mockForeground = true; start.mockClear();
    jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop: jest.fn(), reset: jest.fn() });
    jest.spyOn(Animated.Value.prototype, 'setValue');
  });
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; jest.restoreAllMocks(); });

  it('does not animate cached arrivals or repeated updates within the same state', () => {
    render('queued'); render('queued');
    expect(start).not.toHaveBeenCalled();
    render('sending');
    expect(Animated.timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({
      duration: Motion.duration.fade, useNativeDriver: true, isInteraction: false,
    }));
    render('sending'); render('sending');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reveals a newly visible status but leaves failures and reduced motion immediately readable', () => {
    render(null); render('reconnecting');
    expect(start).toHaveBeenCalledTimes(1);
    render('fatal', false);
    expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(1);
    expect(start).toHaveBeenCalledTimes(1);
    mockReduced = true; render('connected');
    expect(start).toHaveBeenCalledTimes(1);
    mockReduced = false; mockForeground = false; render('queued');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
