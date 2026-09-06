import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { ThemedText } from '@/components/themed-text';
import { useShaderClock } from '@/hooks/use-shader-clock';
import { LiquidGlassButton } from './liquid-glass-button';

jest.mock('@shopify/react-native-skia', () => ({}));
jest.mock('react-native-reanimated', () => ({
  useDerivedValue: (compute: () => unknown) => ({ value: compute() }),
}));
jest.mock('@/components/ui/chromatic-metal', () => ({ ChromaticMetal: () => null }));
jest.mock('@/components/ui/liquid-glass', () => ({ LiquidGlass: () => null }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/hooks/use-shader-clock', () => ({ useShaderClock: jest.fn(() => ({ value: 0 })) }));

describe('single glass creation button', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  it('renders one labelled action with the original typography', () => {
    const onPress = jest.fn();
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(LiquidGlassButton, { onPress }));
    });
    const actions = renderer.root.findAll((node) => node.props.accessibilityRole === 'button'
      && typeof node.props.onPress === 'function', { deep: false });
    expect(actions).toHaveLength(1);
    expect(actions[0].props.accessibilityLabel).toBe('New Agent');
    expect(renderer.root.findByType(ThemedText).props.type).toBe('smallBold');
    TestRenderer.act(() => actions[0].props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('preserves custom labels and pauses the shader when disabled', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(LiquidGlassButton, {
        label: 'Agent', disabled: true, onPress: jest.fn(),
      }));
    });
    const action = renderer.root.findAllByProps({ accessibilityRole: 'button' })[0];
    expect(action.props.accessibilityLabel).toBe('Agent');
    expect(action.props.disabled).toBe(true);
    expect(useShaderClock).toHaveBeenLastCalledWith(false);
  });
});
