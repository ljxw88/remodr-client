import { useMemo } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';
import remend from 'remend';

import { blockStyles, markdownStyles } from '@/components/markdown/markdown-theme';
import { ChatMarkdownRenderer } from '@/components/markdown/renderer';

const MAX_MARKDOWN_LENGTH = 100_000;

const REMEND_OPTIONS = {
  // Incomplete links render as plain text instead of a placeholder URL.
  linkMode: 'text-only',
  // No math rendering in this product, and `$` is common in shell output.
  katex: false,
  inlineKatex: false,
} as const;

export function MarkdownMessage({ children }: { children: string }) {
  const { width } = useWindowDimensions();
  /**
   * Memoised because `useMarkdown` keys its parser on the renderer's identity
   * and its output on that parser. A renderer built inline would be a new
   * object every render, so every re-render of the transcript would re-lex and
   * re-parse every message — and the row heights would churn with it.
   */
  const renderer = useMemo(() => new ChatMarkdownRenderer(width), [width]);
  const value = useMemo(() => {
    const clamped = children.slice(0, MAX_MARKDOWN_LENGTH);
    try {
      return remend(clamped, REMEND_OPTIONS);
    } catch {
      return clamped;
    }
  }, [children]);

  const options = useMemo(
    () => ({ renderer, styles: markdownStyles, colorScheme: 'dark' as const }),
    [renderer],
  );
  const elements = useMarkdown(value, options);

  if (!value.trim()) {
    return null;
  }

  return <View style={blockStyles.container}>{elements}</View>;
}
