import { StyleSheet, View, type ViewProps } from 'react-native';

import { Hairline, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A raised dark panel with a thin outline. */
export function Card({ style, ...rest }: ViewProps) {
  const theme = useTheme();
  return <View style={[styles.card, { backgroundColor: theme.backgroundElement }, style]} {...rest} />;
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
});
