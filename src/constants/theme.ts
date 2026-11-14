/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://unistyl.es/), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#111111',
    background: '#F2F1ED',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#E8E7E2',
    textSecondary: '#6B7076',
  },
  dark: {
    text: '#ffffff',
    background: '#050607',
    backgroundElement: '#111317',
    backgroundSelected: '#22252B',
    textSecondary: '#8B9099',
  },
} as const;

/**
 * Inter, one family name per weight. With a custom font, pick the weight
 * through fontFamily and leave fontWeight unset, or the OS fakes a bold.
 */
export const Type = {
  light: 'Inter_300Light',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

/** Thin outline around cards and between rows. */
export const Hairline = 'rgba(0,0,0,0.09)';

/** Status colours, the same in light and dark mode. */
export const Status = {
  accent: '#208AEF',
  ok: '#22A559',
  warn: '#E8930C',
  danger: '#E5484D',
  /** Other cyclists, in the 3D view and on the camera picture */
  cyclist: '#12B886',
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
