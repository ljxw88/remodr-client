import { StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?:
    | 'default'
    | 'title'
    | 'small'
    | 'smallBold'
    | 'link'
    | 'linkPrimary'
    | 'code'
    | 'heading'
    | 'section'
    | 'caption'
    | 'label';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        { color: theme[themeColor ?? 'text'], fontFamily: Fonts.regular },
        type === 'default' && styles.default,
        type === 'title' && styles.title,
        type === 'small' && styles.small,
        type === 'smallBold' && styles.smallBold,
        type === 'link' && styles.link,
        type === 'linkPrimary' && styles.linkPrimary,
        type === 'code' && styles.code,
        type === 'heading' && styles.heading,
        type === 'section' && styles.section,
        type === 'caption' && styles.caption,
        type === 'label' && styles.label,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  small: {
    fontFamily: Fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.14,
    fontWeight: 500,
  },
  smallBold: {
    fontFamily: Fonts.semibold,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.14,
    fontWeight: 600,
  },
  default: {
    fontFamily: Fonts.regular,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.16,
    fontWeight: 400,
  },
  title: {
    fontFamily: Fonts.semibold,
    fontSize: 48,
    lineHeight: 58,
    letterSpacing: -1.2,
    fontWeight: 600,
  },
  link: {
    fontFamily: Fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.14,
    textDecorationLine: 'underline',
  },
  linkPrimary: {
    fontFamily: Fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.14,
    textDecorationLine: 'underline',
  },
  code: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: 500,
  },
  heading: {
    fontFamily: Fonts.semibold,
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: -0.24,
    fontWeight: 600,
  },
  section: {
    fontFamily: Fonts.semibold,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.16,
    fontWeight: 600,
  },
  caption: {
    fontFamily: Fonts.regular,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: -0.12,
    fontWeight: 400,
  },
  label: {
    fontFamily: Fonts.medium,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: -0.12,
    fontWeight: 500,
  },
});
