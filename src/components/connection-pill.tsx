import { StyleSheet, Text, View } from 'react-native';

import { Hairline, Status, Type } from '@/constants/theme';
import type { Connection } from '@/device/types';

const LABEL: Record<Connection, string> = {
  simulated: 'Simulated',
  connecting: 'Connecting',
  connected: 'Connected',
  offline: 'Offline',
};

const COLOR: Record<Connection, string> = {
  simulated: Status.warn,
  connecting: Status.warn,
  connected: Status.ok,
  offline: Status.danger,
};

export function ConnectionPill({ connection }: { connection: Connection }) {
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: COLOR[connection] }]} />
      <Text style={styles.text}>{LABEL[connection]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: {
    color: '#fff',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
