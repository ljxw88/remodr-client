import { createElement, type ComponentProps } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, StyleSheet } from 'react-native';

import { FormPage, SelectionRow, SelectionRowSkeleton } from '@/components/ui/form-page';
import { AppButton } from '@/components/ui/app-button';
import { TextField } from '@/components/ui/text-field';
import { RemoteFileExplorer } from './remote-file-explorer';

jest.mock('@/components/ui/form-page', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('@/components/ui/form-page'),
    FormPage: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children, footer),
  };
});
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/app-button', () => ({ AppButton: () => null }));
jest.mock('@/components/ui/text-field', () => ({ TextField: () => null }));
jest.mock('@/hooks/use-content-reveal', () => ({ useContentReveal: () => ({ opacity: 1 }) }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type Props = ComponentProps<typeof RemoteFileExplorer>;
const folder = { name: 'Project', path: './Project', isDirectory: true, size: 0 };
const file = { name: 'notes.txt', path: './notes.txt', isDirectory: false, size: 42 };

describe('one shared remote explorer interface', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let props: Props;
  function render(patch: Partial<Props> = {}) {
    props = { ...props, ...patch };
    TestRenderer.act(() => {
      const element = createElement(RemoteFileExplorer, props);
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  function address() { return renderer!.root.findByType(TextField); }
  function list() { return renderer!.root.findByType(FlatList); }
  beforeEach(() => {
    const request = { sessionId: 'session-a', location: { hostId: 'device-a', path: '~', revision: 0 } };
    props = {
      title: 'Files', hostId: 'device-a', hostLabel: 'Laptop', sessionId: 'session-a',
      directory: {
        path: '~', loading: false, ready: true, request, entries: [folder, file], error: null,
        navigate: jest.fn(), refresh: jest.fn(), capture: jest.fn(() => request),
        isCurrent: jest.fn(() => true), cancel: jest.fn(),
      },
    };
  });
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; });

  it('uses the same address controls and selection-row layout in browsing and folder-picking modes', () => {
    render();
    expect(renderer!.root.findByType(FormPage).props.scroll).toBe(false);
    expect(address().props).toMatchObject({ label: 'Folder path', value: '~/', returnKeyType: 'go' });
    const row = list().props.renderItem({ item: folder });
    expect(row.type).toBe(SelectionRow);
    const addressProps = address().props;
    render({ title: 'Choose Folder', foldersOnly: true, onSelectDirectory: jest.fn() });
    expect(address().props.label).toBe(addressProps.label);
    expect(address().props.placeholder).toBe(addressProps.placeholder);
    expect(list().props.renderItem({ item: folder }).type).toBe(row.type);
    expect(renderer!.root.findByType(AppButton).props.label).toBe('Use this folder');
  });

  it('keeps management actions opt-in and never pretends ordinary files can be opened as folders', () => {
    const actions = jest.fn();
    render({ onFileActions: actions });
    const row = list().props.renderItem({ item: file });
    expect(row.props.description).toBe('42 B');
    expect(row.props.onPress).toBeUndefined();
    TestRenderer.act(() => row.props.onLongPress());
    expect(actions).toHaveBeenCalledWith(file, props.directory.request);
    render({ onFileActions: undefined, foldersOnly: true });
    expect(list().props.renderItem({ item: folder }).props.onLongPress).toBeUndefined();
  });

  it('requires typed paths to be opened before selection or mutation can act on them', () => {
    const actions = jest.fn(() => null);
    render({ renderActions: actions, onSelectDirectory: jest.fn() });
    TestRenderer.act(() => address().props.onChangeText('/other'));
    expect(actions).toHaveBeenLastCalledWith(false);
    expect(renderer!.root.findByType(AppButton).props.disabled).toBe(true);
    expect(list().props.data).toEqual([]);
    TestRenderer.act(() => address().props.onSubmitEditing());
    expect(props.directory.navigate).toHaveBeenCalledWith('/other');
  });

  it('uses the same loading rows and keeps animation out of the page shell', () => {
    render({ directory: { ...props.directory, ready: false, loading: true, entries: [] } });
    expect(list().props.data).toHaveLength(4);
    expect(list().props.renderItem({ item: '0' }).type).toBe(SelectionRowSkeleton);
    expect(StyleSheet.flatten(list().props.style).opacity).toBe(1);
    expect(renderer!.root.findByType(FormPage).props.style).toBeUndefined();
  });

  it('keeps one list instance through loading, errors, retry and an unsubmitted address', () => {
    render({ directory: { ...props.directory, ready: false, loading: true, entries: [] } });
    const instance = list().instance;
    render({ directory: { ...props.directory, loading: false, error: 'Permission denied' } });
    expect(list().instance).toBe(instance);
    expect(list().props.data).toEqual([]);
    render({ directory: { ...props.directory, loading: true, error: null } });
    expect(list().instance).toBe(instance);
    render({ directory: { ...props.directory, ready: true, loading: false, entries: [folder] } });
    expect(list().instance).toBe(instance);
    TestRenderer.act(() => address().props.onChangeText('/unopened'));
    expect(list().instance).toBe(instance);
    expect(list().props.data).toEqual([]);
  });
});
