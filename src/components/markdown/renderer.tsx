import { cloneElement, type ReactElement, type ReactNode } from 'react';
import {
  Linking,
  ScrollView,
  Text,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Renderer } from 'react-native-marked';

import { CodeBlock } from '@/components/markdown/code-block';
import { Colors, Spacing } from '@/constants/theme';

/** Narrowest comfortable column before a table starts scrolling instead. */
const MIN_TABLE_COLUMN = 112;

/**
 * Each message render receives a fresh renderer, so counter-based keys stay
 * stable for an unchanged markdown prefix while streaming.
 */
export class ChatMarkdownRenderer extends Renderer {
  private key = 0;

  constructor(private readonly contentWidth: number) {
    super();
  }

  getKey(): string {
    this.key += 1;
    return `md-${this.key}`;
  }

  code(
    text: string,
    language?: string,
    _containerStyle?: ViewStyle,
    _textStyle?: TextStyle,
  ): ReactNode {
    return <CodeBlock key={this.getKey()} code={text} language={language} />;
  }

  link(
    children: string | ReactNode[],
    href: string,
    styles?: TextStyle,
    title?: string,
  ): ReactNode {
    if (!/^https?:\/\//i.test(href)) {
      return (
        <Text
          key={this.getKey()}
          selectable
          style={[styles, { color: undefined, textDecorationLine: 'none' }]}>
          {children}
        </Text>
      );
    }
    return (
      <Text
        key={this.getKey()}
        selectable
        accessibilityRole="link"
        accessibilityHint="Opens in a new window"
        accessibilityLabel={title || 'Link'}
        onPress={() => {
          void Linking.openURL(href).catch((error) => {
            console.warn('[MARKDOWN] Could not open link', error);
          });
        }}
        style={styles}>
        {children}
      </Text>
    );
  }

  image(
    _uri: string,
    alt?: string,
    _style?: ImageStyle,
    title?: string,
  ): ReactNode {
    return (
      <Text
        key={this.getKey()}
        selectable
        accessibilityLabel={alt || title || 'Image'}
        style={{ color: Colors.textMuted, fontStyle: 'italic' }}>
        {`[Image: ${alt || title || 'Image'}]`}
      </Text>
    );
  }

  /**
   * Upstream gives every column 43% of the window regardless of how many there
   * are, so any table wider than two columns is clipped off screen. Columns are
   * sized to fit instead, and genuinely wide tables scroll horizontally.
   */
  table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    tableStyle?: ViewStyle,
    rowStyle?: ViewStyle,
    cellStyle?: ViewStyle,
  ): ReactNode {
    const node = super.table(header, rows, tableStyle, rowStyle, cellStyle) as ReactElement<{
      widthArr?: number[];
    }>;
    const columns = header.length;
    if (columns < 1) {
      return cloneElement(node, { key: this.getKey() });
    }
    const available = Math.max(this.contentWidth - Spacing.four, MIN_TABLE_COLUMN);
    const columnWidth = Math.max(Math.floor(available / columns), MIN_TABLE_COLUMN);
    return (
      <ScrollView
        key={this.getKey()}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ minWidth: '100%' }}>
        {cloneElement(node, { widthArr: Array(columns).fill(columnWidth) })}
      </ScrollView>
    );
  }
}
