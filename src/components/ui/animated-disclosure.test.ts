import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Animated, Text, View } from 'react-native';

import { AnimatedDisclosure } from './animated-disclosure';
import { Motion } from '@/constants/motion';

let mockReduced = false;
let mockForeground = true;
jest.mock('@/hooks/use-reduce-motion', () => ({ useReducedMotion: () => mockReduced }));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => mockForeground }));

describe('measured productive disclosure', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let completions: ((result: { finished: boolean }) => void)[];
  function render(open: boolean) {
    TestRenderer.act(() => {
      const element = createElement(AnimatedDisclosure, { open, testID: 'disclosure' },
        createElement(Text, null, 'Options'));
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  function clip() {
    return renderer!.root.findAll((node) =>
      node.props.testID === 'disclosure' && node.props.pointerEvents != null, { deep: false })[0];
  }
  beforeEach(() => {
    mockReduced = false; mockForeground = true; completions = [];
    jest.spyOn(Animated, 'timing').mockImplementation(() => ({
      start: (callback) => { if (callback) completions.push(callback); }, stop: jest.fn(), reset: jest.fn(),
    }));
  });
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; jest.restoreAllMocks(); });

  it('preserves initial open layout without an entrance and has no closed-state layout gap', () => {
    render(true);
    expect(Animated.timing).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType(Text)).toHaveLength(1);
    mockReduced = true;
    render(false);
    expect(renderer!.root.findAllByType(View)).toHaveLength(0);
  });

  it('clips measured content and disables hidden controls before closing motion finishes', () => {
    render(false); render(true);
    expect(Animated.timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({
      duration: Motion.duration.disclosure, easing: Motion.easing.standard, useNativeDriver: false,
    }));
    const content = renderer!.root.findAll((node) => typeof node.props.onLayout === 'function')[0];
    TestRenderer.act(() => content.props.onLayout({ nativeEvent: { layout: { height: 120 } } }));
    render(false);
    expect(clip().props.pointerEvents).toBe('none');
    expect(clip().props.accessibilityElementsHidden).toBe(true);
    expect(renderer!.root.findAllByType(Text)).toHaveLength(1);
    const oldClose = completions.at(-1)!;
    render(true);
    TestRenderer.act(() => oldClose({ finished: true }));
    expect(renderer!.root.findAllByType(Text)).toHaveLength(1);
    render(false);
    TestRenderer.act(() => completions.at(-1)!({ finished: true }));
    expect(renderer!.root.findAllByType(Text)).toHaveLength(0);
  });
});
