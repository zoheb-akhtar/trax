import { StyleSheet, View } from 'react-native';

import { ConnectionPill } from '@/components/connection-pill';
import { ThemedText } from '@/components/themed-text';
import { useDevice } from '@/device/device-provider';

export function ScreenHeader({ title }: { title: string }) {
  const { connection } = useDevice();
  return (
    <View style={styles.row}>
      <ThemedText type="subtitle">{title}</ThemedText>
      <ConnectionPill connection={connection} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
