import { Fragment, type ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const MAX_MARKDOWN_LENGTH = 100_000;

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; text: string; marker: string }
  | { kind: 'paragraph'; text: string };

export function SafeMarkdown({ children }: { children: string }) {
  const theme = useTheme();
  const blocks = parseBlocks(children.slice(0, MAX_MARKDOWN_LENGTH));

  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <View
              key={index}
              style={[styles.codeBlock, { backgroundColor: theme.fog, borderColor: theme.border }]}>
              <Text style={[styles.code, { color: theme.text }]} selectable>
                {block.text}
              </Text>
            </View>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <View key={index} style={styles.bullet}>
              <ThemedText>{block.marker}</ThemedText>
              <ThemedText style={styles.bulletText}>{renderInline(block.text)}</ThemedText>
            </View>
          );
        }
        return (
          <ThemedText
            key={index}
            type={block.kind === 'heading' ? 'section' : 'default'}
            selectable>
            {renderInline(block.text)}
          </ThemedText>
        );
      })}
    </View>
  );
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let code: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/^#{1,3}\s+/, '') });
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      blocks.push({ kind: 'bullet', marker: '•', text: unordered[1] });
      continue;
    }
    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (ordered) {
      blocks.push({ kind: 'bullet', marker: `${ordered[1]}.`, text: ordered[2] });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: line });
  }
  if (code) {
    blocks.push({ kind: 'code', text: code.join('\n') });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf('`', cursor);
    const linkStart = text.indexOf('[', cursor);
    const next = [codeStart, linkStart]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (next == null) {
      nodes.push(<Fragment key={key++}>{text.slice(cursor)}</Fragment>);
      break;
    }
    if (next > cursor) {
      nodes.push(<Fragment key={key++}>{text.slice(cursor, next)}</Fragment>);
    }
    if (next === codeStart) {
      const end = text.indexOf('`', codeStart + 1);
      if (end < 0) {
        nodes.push(<Fragment key={key++}>{text.slice(codeStart)}</Fragment>);
        break;
      }
      nodes.push(
        <Text key={key++} style={styles.inlineCode}>
          {text.slice(codeStart + 1, end)}
        </Text>,
      );
      cursor = end + 1;
      continue;
    }
    const labelEnd = text.indexOf('](', linkStart + 1);
    const urlEnd = labelEnd >= 0 ? text.indexOf(')', labelEnd + 2) : -1;
    if (labelEnd < 0 || urlEnd < 0) {
      nodes.push(<Fragment key={key++}>{text[linkStart]}</Fragment>);
      cursor = linkStart + 1;
      continue;
    }
    const label = text.slice(linkStart + 1, labelEnd);
    const url = text.slice(labelEnd + 2, urlEnd);
    if (!/^https?:\/\//i.test(url)) {
      nodes.push(<Fragment key={key++}>{text.slice(linkStart, urlEnd + 1)}</Fragment>);
    } else {
      nodes.push(
        <Text
          key={key++}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(url)}
          style={styles.link}>
          {label}
        </Text>,
      );
    }
    cursor = urlEnd + 1;
  }
  return nodes;
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  codeBlock: {
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  code: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  inlineCode: {
    fontFamily: Fonts.mono,
    fontSize: 14,
  },
  link: {
    textDecorationLine: 'underline',
  },
  bullet: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  bulletText: {
    flex: 1,
  },
});
