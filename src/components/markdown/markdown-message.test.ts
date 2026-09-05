import { createElement } from 'react';
import TestRenderer, { type ReactTestRendererJSON } from 'react-test-renderer';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { ChatMarkdownRenderer } from '@/components/markdown/renderer';

type Json = ReactTestRendererJSON | ReactTestRendererJSON[] | null;

function render(markdown: string): Json {
  let instance: TestRenderer.ReactTestRenderer | null = null;
  TestRenderer.act(() => {
    instance = TestRenderer.create(createElement(MarkdownMessage, null, markdown));
  });
  return instance!.toJSON();
}

function textOf(node: unknown): string {
  if (node == null) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  return textOf((node as ReactTestRendererJSON).children);
}

function findNodes(
  node: Json,
  predicate: (candidate: ReactTestRendererJSON) => boolean,
): ReactTestRendererJSON[] {
  if (node == null || typeof node === 'string') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => findNodes(child, predicate));
  }
  const matches = predicate(node) ? [node] : [];
  return [
    ...matches,
    ...findNodes(
      (node.children ?? []).filter(
        (child): child is ReactTestRendererJSON => typeof child !== 'string',
      ),
      predicate,
    ),
  ];
}

describe('MarkdownMessage', () => {
  it('shows long historical replies immediately rather than typing a prefix', () => {
    const reply = `${'Previously completed output. '.repeat(300)}END_OF_SAVED_REPLY`;
    expect(textOf(render(reply))).toBe(reply);
  });

  it('shows hydrated history and new snapshots in full on the render that receives them', () => {
    let instance!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      instance = TestRenderer.create(createElement(MarkdownMessage, null, ''));
    });
    for (const text of ['Saved history', 'Saved history and a new paragraph', 'A rewritten final reply']) {
      TestRenderer.act(() => instance.update(createElement(MarkdownMessage, null, text)));
      expect(textOf(instance.toJSON())).toBe(text);
    }
    TestRenderer.act(() => instance.unmount());
  });

  it('does not reparse unchanged message text when its parent updates', () => {
    const parse = jest.spyOn(ChatMarkdownRenderer.prototype, 'paragraph');
    let instance!: TestRenderer.ReactTestRenderer;
    try {
      TestRenderer.act(() => {
        instance = TestRenderer.create(createElement(MarkdownMessage, null, 'Unchanged message'));
      });
      const calls = parse.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      TestRenderer.act(() => instance.update(createElement(MarkdownMessage, null, 'Unchanged message')));
      expect(parse).toHaveBeenCalledTimes(calls);
    } finally {
      TestRenderer.act(() => instance.unmount());
      parse.mockRestore();
    }
  });

  it('renders inline emphasis without leaking markers', () => {
    const text = textOf(render('Run **now** and _later_ and ~~never~~.'));

    expect(text).toContain('now');
    expect(text).toContain('later');
    expect(text).not.toContain('**');
    expect(text).not.toContain('~~');
  });

  it('renders table cells', () => {
    const text = textOf(
      render(['| Tool | State |', '| --- | --- |', '| edit | done |'].join('\n')),
    );

    expect(text).toContain('Tool');
    expect(text).toContain('edit');
    expect(text).toContain('done');
  });

  it('renders a code fence with its language label and copy affordance', () => {
    const text = textOf(render(['```ts', 'const a = 1;', '```'].join('\n')));

    expect(text).toContain('TypeScript');
    expect(text).toContain('Copy');
    expect(text).toContain('const');
  });

  it('renders an unterminated fence mid-stream instead of dropping it', () => {
    const text = textOf(render(['Here you go:', '', '```python', 'x = 1'].join('\n')));

    expect(text).toContain('Python');
    expect(text).toContain('x = 1');
  });

  it('repairs partial emphasis while streaming', () => {
    const text = textOf(render('This is **bold'));

    expect(text).toContain('bold');
    expect(text).not.toContain('**');
  });

  it('renders diff fences line by line', () => {
    const text = textOf(render(['```diff', '-const a = 1;', '+const a = 2;', '```'].join('\n')));

    expect(text).toContain('Diff');
    expect(text).toContain('-const a = 1;');
    expect(text).toContain('+const a = 2;');
  });

  it('renders headings, lists and blockquotes', () => {
    const text = textOf(
      render(['# Title', '', '- first', '- second', '', '> quoted'].join('\n')),
    );

    expect(text).toContain('Title');
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('quoted');
  });

  it('renders nothing for blank content', () => {
    expect(render('   ')).toBeNull();
  });

  it('only makes HTTP and HTTPS links interactive', () => {
    const safe = render('[Documentation](https://example.com/docs)');
    const unsafe = render('[Call support](tel:+15555550123)');

    expect(findNodes(safe, (node) => node.props.accessibilityRole === 'link')).toHaveLength(1);
    expect(findNodes(unsafe, (node) => node.props.accessibilityRole === 'link')).toHaveLength(0);
    expect(textOf(unsafe)).toContain('Call support');
  });

  it('renders image alt text without mounting the upstream network image', () => {
    const tree = render('![Architecture diagram](https://example.com/diagram.png)');

    expect(textOf(tree)).toContain('[Image: Architecture diagram]');
    expect(
      findNodes(tree, (node) => node.props.testID === 'react-native-marked-md-image'),
    ).toHaveLength(0);
  });

  it('assigns keys to every block, including tables', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        [
          '# Title',
          '',
          'A paragraph.',
          '',
          '| a | b |',
          '| --- | --- |',
          '| 1 | 2 |',
          '',
          '```ts',
          'const x = 1;',
          '```',
          '',
          '> quote',
          '',
          '---',
        ].join('\n'),
      );
      const keyWarnings = error.mock.calls.filter((call) => String(call[0]).includes('unique "key"'));

      expect(keyWarnings).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps node keys stable across streaming updates', () => {
    const first = render('# Title\n\nSome text');
    const second = render('# Title\n\nSome text and more');

    expect(textOf(first)).toContain('Title');
    expect(textOf(second)).toContain('and more');
  });
});
