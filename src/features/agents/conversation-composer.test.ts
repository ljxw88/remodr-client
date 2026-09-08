import { createElement, type ComponentProps } from 'react';
import TestRenderer from 'react-test-renderer';
import { StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { GlassSurface } from '@/components/ui/glass-surface';
import { ConversationComposer, ConversationComposerSkeleton } from './conversation-composer';
import { SkeletonBlock, SkeletonGroup } from '@/components/ui/skeleton';

jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({
  GlassSurface: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type Props = ComponentProps<typeof ConversationComposer>;

describe('ConversationComposer', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let props: Props;

  function render(overrides: Partial<Props> = {}) {
    props = { ...props, ...overrides };
    TestRenderer.act(() => {
      if (renderer) renderer.update(createElement(ConversationComposer, props));
      else renderer = TestRenderer.create(createElement(ConversationComposer, props));
    });
  }

  function button(label: string) {
    return renderer!.root.findAll((node) =>
      node.props.accessibilityLabel === label && typeof node.props.onPress === 'function',
    { deep: false })[0];
  }

  beforeEach(() => {
    props = {
      value: 'Draft', onChangeText: jest.fn(), onSend: jest.fn(),
      sending: false, answerPending: false, error: null, hasOpenRequest: false,
      onHeightChange: jest.fn(), modelName: 'GPT-5', tunable: true,
      onOpenModelSettings: jest.fn(), showLatest: false, onFollowLatest: jest.fn(),
    };
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
  });

  it.each([
    { value: '', sending: false, answerPending: false, disabled: true },
    { value: ' \n ', sending: false, answerPending: false, disabled: true },
    { value: 'Draft', sending: true, answerPending: false, disabled: true },
    { value: 'Draft', sending: false, answerPending: true, disabled: true },
    { value: 'Draft', sending: false, answerPending: false, disabled: false },
  ])('preserves send availability for %j', ({ disabled, ...state }) => {
    render(state);
    expect(button('Send').props.disabled).toBe(disabled);
    expect(button('Send').props.accessibilityState).toEqual({ disabled });
    expect(button('Send').props.onPress).toBe(props.onSend);
  });

  it('uses the real composer card shape for unknown metadata without offering fake controls', () => {
    render();
    const cardStyle = renderer!.root.findByType(GlassSurface).props.style;
    TestRenderer.act(() => renderer!.update(createElement(ConversationComposerSkeleton)));
    expect(renderer!.root.findByType(GlassSurface).props.style).toBe(cardStyle);
    expect(renderer!.root.findByType(SkeletonGroup).props.label).toBe('Loading message controls');
    expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
    expect(renderer!.root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(0);
    expect(renderer!.root.findAllByType(SkeletonBlock).filter((block) =>
      block.props.width === 36 && block.props.height === 36 && block.props.radius === 18)).toHaveLength(1);
  });

  it.each([
    ['', '@'], ['Draft', 'Draft @'], ['Draft ', 'Draft @'],
  ])('appends context to %j without changing spacing', (value, expected) => {
    render({ value });
    TestRenderer.act(() => button('Add context').props.onPress());
    expect(props.onChangeText).toHaveBeenCalledWith(expected);
  });

  it('shows Latest only while detached and forwards follow/model actions', () => {
    render();
    expect(button('Scroll to latest message')).toBeUndefined();
    render({ showLatest: true });
    const latest = button('Scroll to latest message');
    expect(latest.props.accessibilityHint).toBe('Resume following new messages');
    TestRenderer.act(() => {
      latest.props.onPress();
      button('Model Settings: GPT-5').props.onPress();
    });
    expect(props.onFollowLatest).toHaveBeenCalledTimes(1);
    expect(props.onOpenModelSettings).toHaveBeenCalledTimes(1);
    render({ tunable: false, modelName: 'Provider default' });
    const model = button('Model Settings: Provider default');
    expect(model.props.disabled).toBe(true);
    expect(model.props.accessibilityState).toEqual({ disabled: true });
  });

  it('keeps the injected question immediately before the card and measures the whole composer', () => {
    render({
      hasOpenRequest: true,
      requestBar: createElement(View, { testID: 'question-slot' }),
      keyboardOffset: 240,
    });
    const container = renderer!.root.findAllByType(View).find((node) => node.props.onLayout)!;
    const children = container.props.children;
    expect(children[0].props.testID).toBe('question-slot');
    expect(children[1].type).toBe(View);
    expect(children[1].props.children.type).toBe(GlassSurface);
    expect(StyleSheet.flatten(container.props.style)).toMatchObject({ position: 'absolute', bottom: 240 });
    TestRenderer.act(() => container.props.onLayout({ nativeEvent: { layout: { height: 312 } } }));
    expect(props.onHeightChange).toHaveBeenCalledWith(312);
  });

  it('retains multiline draft input, height bounds, question labels, and independent error display', () => {
    render();
    const input = () => renderer!.root.findByType(TextInput);
    expect(input().props).toMatchObject({
      value: 'Draft', onChangeText: props.onChangeText, multiline: true, blurOnSubmit: false,
      textAlignVertical: 'top', maxLength: 20_000,
      accessibilityLabel: 'Build anything', placeholder: 'Build anything…',
    });
    expect(StyleSheet.flatten(input().props.style)).toMatchObject({ minHeight: 38, maxHeight: 120 });
    render({ hasOpenRequest: true });
    expect(input().props.accessibilityLabel).toBe('Write an answer');
    expect(input().props.placeholder).toBe('Write another answer…');
    render({ answerPending: true, error: 'Could not save draft' });
    expect(input().props.placeholder).toBe('Answer queued…');
    expect(input().props.editable).not.toBe(false);
    expect(renderer!.root.findAllByType(ThemedText).find((node) =>
      node.props.accessibilityLiveRegion === 'polite')?.props.children).toBe('Could not save draft');
  });
});
