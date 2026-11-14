import { StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?:
    | 'default'
    | 'title'
    | 'small'
    | 'smallBold'
    | 'subtitle'
    | 'label'
    | 'link'
    | 'linkPrimary'
    | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();
  // Labels are secondary by default; everything else uses the main text colour.
  const color = theme[themeColor ?? (type === 'label' ? 'textSecondary' : 'text')];

  return <Text style={[{ color }, styles[type], style]} {...rest} />;
}

const styles = StyleSheet.create({
  small: { fontFamily: Type.regular, fontSize: 13, lineHeight: 19 },
  smallBold: { fontFamily: Type.semibold, fontSize: 13, lineHeight: 19 },
  default: { fontFamily: Type.regular, fontSize: 15, lineHeight: 22 },
  title: { fontFamily: Type.light, fontSize: 44, lineHeight: 50, letterSpacing: -1 },
  subtitle: { fontFamily: Type.medium, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  /** Small uppercase heading above a group of things. */
  label: {
    fontFamily: Type.medium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  link: { fontFamily: Type.regular, lineHeight: 30, fontSize: 14 },
  linkPrimary: { fontFamily: Type.regular, lineHeight: 30, fontSize: 14, color: '#3c87f7' },
  code: { fontFamily: Fonts?.mono, fontSize: 12 },
});
