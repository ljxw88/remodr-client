import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { HostForm } from './HostForm';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';

jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FormPage: ({ children, footer }: { children: import('react').ReactNode; footer: import('react').ReactNode }) =>
      React.createElement(View, null, children, footer),
    FormSection: ({ children }: { children: import('react').ReactNode }) => children,
    SelectionRow: () => null,
    FormError: ({ message }: { message?: string }) => message ? React.createElement(Text, null, message) : null,
  };
});
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));

const valid = { name: 'Server', hostname: 'server.example.com', username: 'user', port: '22', authType: 'password' as const };

describe('server form', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  it('keeps invalid input editable and shows field errors without submitting', async () => {
    const submit = jest.fn();
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(HostForm, { submitLabel: 'Save server', onSubmit: submit }));
    });
    await TestRenderer.act(async () => renderer.root.findByType(AppButton).props.onPress());
    expect(submit).not.toHaveBeenCalled();
    const name = renderer.root.findAllByType(TextField).find((field) => field.props.label === 'Name')!;
    expect(name.props.error).toBeTruthy();
    expect(name.props.editable).toBe(true);
  });

  it('uses one guarded submit and retains values after an asynchronous save error', async () => {
    let reject!: (error: Error) => void;
    const submit = jest.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(HostForm, {
        initialValues: valid, submitLabel: 'Save server', onSubmit: submit,
      }));
    });
    const action = renderer.root.findByType(AppButton).props.onPress;
    await TestRenderer.act(async () => { action(); action(); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ port: 22, hostname: valid.hostname }));
    expect(renderer.root.findByType(FormPage).props.busy).toBe(true);
    expect(renderer.root.findAllByType(TextField).every((field) => field.props.editable === false)).toBe(true);
    await TestRenderer.act(async () => reject(new Error('Storage unavailable')));
    expect(renderer.root.findByType(FormError).props.message).toBe('Storage unavailable');
    expect(renderer.root.findAllByType(TextField)[0].props.value).toBe('Server');
    expect(renderer.root.findByType(FormPage).props.busy).toBe(false);
  });
});
