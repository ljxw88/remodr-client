import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { BackHandler, Keyboard, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';

import { FormPage } from './form-page';
import { Spacing } from '@/constants/theme';
import { useKeyboardOverlap } from '@/hooks/use-keyboard-overlap';

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: jest.fn(() => null) },
    useIsFocused: () => true,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
    router: { canGoBack: () => true, back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({ glassRim: () => ({}) }));
jest.mock('@/hooks/use-keyboard-overlap', () => ({
  ...jest.requireActual('@/hooks/use-keyboard-overlap'),
  useKeyboardOverlap: jest.fn(() => ({ ref: jest.fn(), measure: jest.fn(), inset: 300, visible: true })),
}));

describe('keyboard-safe form page', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  it('keeps the footer above measured keyboard overlap without a second automatic inset', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FormPage, {
        title: 'New agent', footer: 'Start agent',
      }, 'Name and settings'));
    });
    const viewport = renderer.root.findAllByProps({ testID: 'form-viewport' })[0];
    const footer = renderer.root.findAllByProps({ testID: 'form-footer' })[0];
    const scroll = renderer.root.findAllByProps({ testID: 'form-scroll' })[0];
    expect(StyleSheet.flatten(viewport.props.style).paddingBottom).toBe(300);
    const footerStyle = StyleSheet.flatten(footer.props.style);
    expect(footerStyle.paddingBottom).toBe(Spacing.two);
    expect(footerStyle.paddingBottom).toBe(footerStyle.padding);
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(false);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('uses bottom safe area rather than dock clearance with the keyboard hidden', () => {
    jest.mocked(useKeyboardOverlap).mockReturnValueOnce({
      ref: jest.fn(), measure: jest.fn(), inset: 0, visible: false,
    });
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FormPage, {
        title: 'New space', footer: 'Create',
      }, 'Folder'));
    });
    expect(StyleSheet.flatten(renderer.root.findAllByProps({ testID: 'form-footer' })[0].props.style).paddingBottom).toBe(24);
  });

  it('protects an in-flight mutation from hardware back and swipe dismissal', () => {
    const remove = jest.fn();
    const listen = jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove });
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FormPage, { title: 'Starting', busy: true }, 'Please wait'));
    });
    expect(listen).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    expect(listen.mock.calls[0][1]()).toBe(true);
    const screen = renderer.root.findByType(Stack.Screen);
    expect(screen.props.options.gestureEnabled).toBe(false);
    TestRenderer.act(() => renderer.update(createElement(FormPage, { title: 'New agent', busy: false }, 'Ready')));
    expect(remove).toHaveBeenCalled();
  });

  it.each([
    { inset: 0, visible: false, expected: 24 },
    { inset: 300, visible: true, expected: 300 },
    { inset: 0, visible: true, expected: 0 },
  ])('protects footerless selectors from bottom occlusion: %j', ({ inset, visible, expected }) => {
    jest.mocked(useKeyboardOverlap).mockReturnValueOnce({
      ref: jest.fn(), measure: jest.fn(), inset, visible,
    });
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FormPage, { title: 'Choose model', scroll: false }, 'Models'));
    });
    expect(StyleSheet.flatten(renderer.root.findAllByProps({ testID: 'form-viewport' })[0].props.style).paddingBottom).toBe(expected);
  });
});
