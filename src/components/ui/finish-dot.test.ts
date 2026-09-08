import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { Colors } from '@/constants/theme';
import { FinishDot } from './finish-dot';

describe('FinishDot', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  function render(props: Partial<Parameters<typeof FinishDot>[0]> = {}) {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(FinishDot, { label: 'Unread finished work', ...props }));
    });
    return renderer!.root;
  }

  it('renders a bare presence dot with no visible number when count is omitted', () => {
    const root = render();
    expect(root.findByProps({ accessibilityLabel: 'Unread finished work' })).toBeDefined();
    expect(root.findAllByType(Text)).toHaveLength(0);
    const dot = root.findByProps({ accessibilityLabel: 'Unread finished work' });
    expect(dot.props.accessible).toBe(true);
    expect(dot.props.pointerEvents).toBe('none');
    expect(dot.props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ backgroundColor: Colors.accentSecondary }),
    ]));
  });

  it('does not show an indicator for zero unread finishes', () => {
    render({ count: 0 });
    expect(renderer.toJSON()).toBeNull();
  });

  it('stays a bare dot for a count of exactly one, since there is nothing to aggregate yet', () => {
    const root = render({ count: 1 });
    expect(root.findAllByType(Text)).toHaveLength(0);
  });

  it('shows the count once there is more than one unread finish to aggregate', () => {
    const root = render({ count: 3, label: '3 unread finished agents' });
    expect(root.findByType(Text).props.children).toBe(3);
    expect(StyleSheet.flatten(root.findByType(Text).props.style).color)
      .toBe(Colors.onAccentSecondary);
    expect(root.findByProps({ accessibilityLabel: '3 unread finished agents' })).toBeDefined();
  });

  it('caps the printed count so the badge never has to grow past two digits', () => {
    const root = render({ count: 42 });
    expect(root.findByType(Text).props.children).toBe('9+');
  });

  it('carries caller styling onto the outer dot', () => {
    const root = render({ style: { top: -2, right: -2 } });
    const outer = root.findByProps({ accessibilityLabel: 'Unread finished work' }) as unknown as { props: { style: unknown[] } };
    expect(outer.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ top: -2, right: -2 })]),
    );
  });
});
