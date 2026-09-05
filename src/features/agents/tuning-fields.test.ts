import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { SelectionRow } from '@/components/ui/form-page';
import { TuningFields } from './tuning-fields';

jest.mock('@/components/ui/form-page', () => ({
  FormSection: ({ children }: { children: import('react').ReactNode }) => children,
  SelectionRow: () => null,
}));

describe('compact tuning fields', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  it('discloses reasoning/context on demand and preserves unsupported current choices', () => {
    const onChange = jest.fn();
    const onChooseModel = jest.fn();
    const value = { model: 'private-model', effort: 'max' as const, context: 'long_context' as const };
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(TuningFields, { provider: 'copilot', value, onChange, onChooseModel }));
    });
    expect(renderer.root.findAllByType(SelectionRow).map((row) => [row.props.label, row.props.value])).toEqual([
      ['Model', 'private-model'], ['Reasoning effort', 'Max'], ['Context window', 'Long'],
    ]);
    expect(onChange).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.root.findAllByType(SelectionRow)[1].props.onPress());
    const max = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === 'Max')!;
    expect(max.props.selected).toBe(true);
    const defaultEffort = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === 'Default')!;
    TestRenderer.act(() => defaultEffort.props.onPress());
    expect(onChange).toHaveBeenCalledWith({ ...value, effort: null });
    expect(renderer.root.findAllByType(SelectionRow)).toHaveLength(3);
    TestRenderer.act(() => renderer.root.findAllByType(SelectionRow)[0].props.onPress());
    expect(onChooseModel).toHaveBeenCalledTimes(1);
  });

  it('uses model-specific context sizes and can hide the model row for new-agent advanced settings', () => {
    const onChange = jest.fn();
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(TuningFields, {
        provider: 'copilot', value: { model: 'gpt-5.6-sol', effort: null, context: 'long_context' },
        onChange, onChooseModel: jest.fn(), showModel: false,
      }));
    });
    expect(renderer.root.findAllByType(SelectionRow).map((row) => row.props.label))
      .toEqual(['Reasoning effort', 'Context window']);
    const context = renderer.root.findAllByType(SelectionRow)[1];
    expect(context.props.value).toBe('1.1M');
    TestRenderer.act(() => context.props.onPress());
    const standard = renderer.root.findAllByType(SelectionRow).find((row) => row.props.label === '400K')!;
    TestRenderer.act(() => standard.props.onPress());
    expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', effort: null, context: 'default' });
  });
});
