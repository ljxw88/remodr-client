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
  const value = useMemo(() => {
    const clamped = children.slice(0, MAX_MARKDOWN_LENGTH);
    try {
      return remend(clamped, REMEND_OPTIONS);
    } catch {
      return clamped;
    }
  }, [children]);

  const elements = useMarkdown(value, {
    renderer: new ChatMarkdownRenderer(width),
    styles: markdownStyles,
    colorScheme: 'dark',
  });

  if (!value.trim()) {
    return null;
  }

  return <View style={blockStyles.container}>{elements}</View>;
}
