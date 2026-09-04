import { StyleSheet } from 'react-native';
import type { MarkedStyles } from 'react-native-marked';

import { Colors, Fonts, Radius, Spacing } from '@/constants/theme';
import type { SyntaxRole } from '@/components/markdown/syntax';
import type { DiffLineKind } from '@/components/markdown/diff';

export const CODE_FONT_SIZE = 13;
export const CODE_LINE_HEIGHT = 20;

/**
 * Syntax palette tuned for the near-black canvas. Violet stays reserved for
 * keywords so code reads as part of the product rather than a foreign theme.
 */
export const SyntaxColors: Record<SyntaxRole, string> = {
  plain: Colors.text,
  keyword: '#B49CFF',
  string: Colors.success,
  number: Colors.warning,
  comment: Colors.placeholder,
  function: '#7FB4FF',
  type: '#67E8F9',
  operator: Colors.textSecondary,
  tag: Colors.danger,
  attribute: '#FFB27F',
};

export const DiffColors: Record<DiffLineKind, { text: string; background: string }> = {
  added: { text: Colors.success, background: 'rgba(91,228,155,0.10)' },
  removed: { text: Colors.danger, background: 'rgba(255,113,107,0.10)' },
  hunk: { text: Colors.accent, background: 'rgba(108,124,255,0.10)' },
  meta: { text: Colors.textMuted, background: 'transparent' },
  context: { text: Colors.textSecondary, background: 'transparent' },
};

/**
 * How large a message reads, and the one place to change it.
 *
 * A step below the app's body size. A transcript is long-form and mostly read
 * rather than glanced at, so fitting more of a sentence on a line is worth
 * more here than matching the chrome around it. Everything else in a message
 * is sized against this, and the user's own bubble uses it too.
 */
export const MessageText = {
  fontSize: 14,
  lineHeight: 20,
} as const;

const body = {
  fontFamily: Fonts.regular,
  ...MessageText,
  color: Colors.text,
} as const;

const heading = {
  fontFamily: Fonts.semibold,
  fontWeight: '600',
  color: Colors.text,
  marginTop: Spacing.one,
  marginVertical: 0,
  paddingBottom: 0,
  borderBottomWidth: 0,
} as const;

/**
 * Overrides every default the library ships. Values are flattened last by
 * `getStyles`, so anything omitted here keeps a light-mode default.
 */
export const markdownStyles: MarkedStyles = {
  text: body,
  paragraph: { paddingVertical: 0, marginVertical: 0 },
  em: { ...body, fontStyle: 'italic' },
  strong: { ...body, fontFamily: Fonts.semibold, fontWeight: '600' },
  strikethrough: { ...body, color: Colors.textMuted, textDecorationLine: 'line-through' },
  link: { ...body, fontStyle: 'normal', color: Colors.accent, textDecorationLine: 'underline' },
  h1: { ...heading, fontSize: 20, lineHeight: 28 },
  h2: { ...heading, fontSize: 18, lineHeight: 26 },
  h3: { ...heading, fontSize: 16, lineHeight: 22 },
  h4: { ...heading, fontSize: 15, lineHeight: 20 },
  h5: { ...heading, fontSize: 14, lineHeight: 20 },
  h6: { ...heading, fontSize: 13, lineHeight: 18, color: Colors.textSecondary },
  blockquote: {
    borderLeftColor: Colors.accent,
    borderLeftWidth: 3,
    paddingLeft: Spacing.two,
    paddingVertical: Spacing.half,
    opacity: 1,
  },
  codespan: {
    fontFamily: Fonts.mono,
    fontStyle: 'normal',
    fontWeight: '400',
    fontSize: 13,
    color: Colors.text,
    backgroundColor: Colors.backgroundSelected,
  },
  code: { padding: 0, backgroundColor: 'transparent', minWidth: '100%' },
  hr: { borderBottomWidth: 1, borderBottomColor: Colors.border, marginVertical: Spacing.one },
  li: { ...body, flexShrink: 1 },
  list: {},
  table: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.tag },
  tableRow: { borderColor: Colors.border },
  tableCell: { borderColor: Colors.border, padding: Spacing.one },
};

export const blockStyles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  codeSurface: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.control,
    backgroundColor: Colors.fog,
    overflow: 'hidden',
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Spacing.two,
    paddingRight: Spacing.one,
    paddingVertical: Spacing.half,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.backgroundElement,
  },
  copyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    minHeight: 32,
    paddingHorizontal: Spacing.one,
    borderRadius: Radius.pill,
  },
  codeScroll: {
    padding: Spacing.two,
  },
  codeLine: {
    fontFamily: Fonts.mono,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
  },
  diffLine: {
    paddingHorizontal: Spacing.two,
  },
});
