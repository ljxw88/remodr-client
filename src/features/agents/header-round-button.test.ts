import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { HeaderRoundButton } from './header-round-button';

// The rim draws through Skia, which Jest is not set up to transform, and there
// is nothing to assert about a shader here anyway.
jest.mock('@/components/ui/liquid-glass-rim', () => ({ LiquidGlassRim: () => null }));

describe('HeaderRoundButton', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const onPress = jest.fn();

  function render(props: Partial<Parameters<typeof HeaderRoundButton>[0]> = {}) {
    const element = createElement(HeaderRoundButton, {
      onPress,
      accessibilityLabel: 'Hide devices and spaces',
      icon: { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' },
      fallback: '⌃',
      ...props,
    });
    TestRenderer.act(() => {
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
    // The host view Pressable renders down to, which carries the contract.
    return renderer!.root.findAllByProps({ accessibilityRole: 'button' })[0];
  }

  beforeEach(() => onPress.mockClear());
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('reports which way a disclosure points, and says nothing when it is not one', () => {
    expect(render({ expanded: true }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(render({ expanded: false }).props.accessibilityState).toMatchObject({ expanded: false });
    expect(render().props.accessibilityState.expanded).toBeUndefined();
  });

  it('is a button, labelled by the caller, that calls back when pressed', () => {
    const button = render();
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Hide devices and spaces');
    TestRenderer.act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('stops responding when disabled, and says so', () => {
    const button = render({ disabled: true });
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  });
});
