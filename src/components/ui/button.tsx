import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { haptic } from '@/lib/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESS = { duration: 120 };

type Props = {
  title: string;
  onPress(): void;
  /** primary: white, the one main action. secondary: quiet grey. */
  variant?: 'primary' | 'danger' | 'secondary' | 'onDanger';
  size?: 'small' | 'regular' | 'large';
  disabled?: boolean;
};

export function Button({ title, onPress, variant = 'primary', size = 'regular', disabled }: Props) {
  const theme = useTheme();
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const background = {
    primary: '#ffffff',
    danger: Status.danger,
    secondary: theme.backgroundSelected,
    onDanger: '#ffffff',
  }[variant];
  const color = {
    primary: '#000000',
    danger: '#ffffff',
    secondary: '#ffffff',
    onDanger: Status.danger,
  }[variant];

  return (
    <AnimatedPressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={size === 'small' ? 6 : 0}
      // Respond on touch-down, commit on release.
      onPressIn={() => {
        scale.set(withTiming(0.97, PRESS));
      }}
      onPressOut={() => {
        scale.set(withTiming(1, PRESS));
      }}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={[
        styles.button,
        size === 'large' && styles.large,
        size === 'small' && styles.small,
        variant === 'secondary' && styles.outlined,
        { backgroundColor: background, opacity: disabled ? 0.35 : 1 },
        pressStyle,
      ]}>
      <Text
        numberOfLines={1}
        style={[
          styles.title,
          size === 'large' && styles.largeTitle,
          size === 'small' && styles.smallTitle,
          { color },
        ]}>
        {title}
      </Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  large: { minHeight: 60, borderRadius: 16 },
  small: { minHeight: 40, paddingHorizontal: 16, borderRadius: 12 },
  outlined: { borderWidth: StyleSheet.hairlineWidth, borderColor: Hairline },
  title: { fontFamily: Type.medium, fontSize: 15, letterSpacing: 0.2 },
  largeTitle: { fontFamily: Type.semibold, fontSize: 16 },
  smallTitle: { fontSize: 13 },
});
