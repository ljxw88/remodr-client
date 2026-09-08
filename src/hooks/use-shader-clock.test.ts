import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import type { FrameInfo } from 'react-native-reanimated';

import { useShaderClock } from './use-shader-clock';

let mockFocused = true;
let mockForeground = true;
let mockReduced = false;
let mockOnFrame: (info: FrameInfo) => void;
const mockClock = { value: 0 };
const mockFrame = { setActive: jest.fn() };
jest.mock('react-native-reanimated', () => ({
  useSharedValue: () => mockClock,
  useFrameCallback: (callback: (info: FrameInfo) => void) => { mockOnFrame = callback; return mockFrame; },
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const focused = mockFocused;
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));
jest.mock('@/hooks/use-reduce-motion', () => ({ useReducedMotion: () => mockReduced }));

describe('decorative shader lifecycle', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  function Harness({ enabled }: { enabled: boolean }) { useShaderClock(enabled); return null; }
  function render(enabled = true) {
    TestRenderer.act(() => {
      const element = createElement(Harness, { enabled });
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  beforeEach(() => {
    mockFocused = true; mockForeground = true; mockReduced = false; mockClock.value = 0;
    mockFrame.setActive.mockClear();
  });
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; });

  it('runs only while focused, foregrounded, enabled and motion is permitted', () => {
    render();
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(true);
    mockReduced = true; render();
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
    mockReduced = false; mockForeground = false; render();
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
    mockForeground = true; mockFocused = false; render();
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
    mockFocused = true; render(false);
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
  });

  it('never starts on a screen first mounted out of focus and stops on unmount', () => {
    mockFocused = false;
    render();
    expect(mockFrame.setActive).not.toHaveBeenCalledWith(true);
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
  });

  it('does not fast-forward the material after a long suspended frame', () => {
    render();
    mockOnFrame({ timestamp: 1000, timeSinceFirstFrame: 1000, timeSincePreviousFrame: 1000 });
    expect(mockClock.value).toBe(64);
  });
});
