import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { isDiffLanguage, parseDiff } from '@/components/markdown/diff';
import {
  blockStyles,
  CODE_LINE_HEIGHT,
  DiffColors,
  SyntaxColors,
} from '@/components/markdown/markdown-theme';
import { highlight, languageLabel } from '@/components/markdown/syntax';

const COPY_FEEDBACK_MS = 1600;

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy() {
    try {
      await Clipboard.setStringAsync(value);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Code copied' : 'Copy code'}
      onPress={() => void copy()}
      hitSlop={8}
      style={({ pressed }) => [
        blockStyles.copyAction,
        { backgroundColor: pressed ? Colors.backgroundSelected : 'transparent' },
      ]}>
      <AppIcon
        name={
          copied
            ? { ios: 'checkmark', android: 'check', web: 'check' }
            : { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }
        }
        size={14}
        tintColor={copied ? Colors.success : Colors.textMuted}
        fallback={copied ? '✓' : '⧉'}
      />
      <ThemedText type="caption" themeColor={copied ? 'success' : 'textMuted'}>
        {copied ? 'Copied' : 'Copy'}
      </ThemedText>
    </Pressable>
  );
}

function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const lines = highlight(code, language);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={blockStyles.codeScroll}>
      <View>
        {lines.map((tokens, lineIndex) => (
          <Text key={lineIndex} selectable style={blockStyles.codeLine}>
            {tokens.length === 0 ? (
              ' '
            ) : (
              tokens.map((token, tokenIndex) => (
                <Text key={tokenIndex} style={{ color: SyntaxColors[token.role] }}>
                  {token.text}
                </Text>
              ))
            )}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function DiffCode({ code }: { code: string }) {
  const lines = parseDiff(code);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: '100%', paddingVertical: 8 }}>
        {lines.map((line, index) => {
          const palette = DiffColors[line.kind];
          return (
            <View
              key={index}
              style={[blockStyles.diffLine, { backgroundColor: palette.background }]}>
              <Text
                selectable
                style={[
                  blockStyles.codeLine,
                  { color: palette.text, minHeight: CODE_LINE_HEIGHT },
                ]}>
                {line.text === '' ? ' ' : line.text}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const diff = isDiffLanguage(language);
  return (
    <View style={blockStyles.codeSurface}>
      <View style={blockStyles.codeHeader}>
        <ThemedText type="caption" themeColor="textMuted">
          {languageLabel(language)}
        </ThemedText>
        <CopyButton value={code} />
      </View>
      {diff ? <DiffCode code={code} /> : <HighlightedCode code={code} language={language} />}
    </View>
  );
});
