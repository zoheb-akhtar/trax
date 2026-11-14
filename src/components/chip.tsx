import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Type } from '@/constants/theme';

/** Small translucent label that floats over the camera picture. */
export function Chip({ dotColor, children }: { dotColor?: string; children: ReactNode }) {
  return (
    <BlurView intensity={40} tint="dark" style={styles.chip}>
      {dotColor && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
      <Text style={styles.text}>{children}</Text>
    </BlurView>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: {
    color: '#fff',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontVariant: ['tabular-nums'],
  },
});
