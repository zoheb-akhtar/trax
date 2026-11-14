import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { normalizeHost } from '@/device/http-source';
import { useTheme } from '@/hooks/use-theme';

export default function DeviceScreen() {
  const theme = useTheme();
  const { settings, updateSettings, state, connection, simulateTamper } = useDevice();
  const [host, setHost] = useState(settings.host);
  const usingDevice = settings.source === 'device';

  return (
    <Screen>
      <ScreenHeader title="Device" />

      <Card>
        <ThemedText type="label">Velo address</ThemedText>
        <TextInput
          value={host}
          onChangeText={setHost}
          placeholder="192.168.1.50:8000"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
        />
        <ThemedText type="small" themeColor="textSecondary">
          The phone and Velo must be on the same Wi-Fi, such as this phone&apos;s hotspot.
        </ThemedText>
        <Button
          title={usingDevice && host === settings.host ? 'Reconnect' : 'Connect to Velo'}
          disabled={!host.trim()}
          onPress={() => updateSettings({ source: 'device', host: host.trim() })}
        />
        {usingDevice && (
          <Button
            title="Use simulated device"
            variant="secondary"
            onPress={() => updateSettings({ ...settings, source: 'simulated' })}
          />
        )}
      </Card>

      <Card>
        <Row label="Source" value={usingDevice ? normalizeHost(settings.host) : 'Simulated'} />
        <Row label="Connection" value={connection[0].toUpperCase() + connection.slice(1)} />
        <Row label="Mode" value={state.mode === 'security' ? 'Security' : 'Ride'} />
        <Row
          label="Battery"
          value={state.battery == null ? 'Not reported' : `${Math.round(state.battery)}%`}
        />
      </Card>

      {simulateTamper && (
        <Card>
          <ThemedText type="label">Demo</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Arms the simulated Velo and pretends someone moved the bike.
          </ThemedText>
          <Button title="Simulate bike being moved" variant="secondary" onPress={simulateTamper} />
        </Card>
      )}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <ThemedText themeColor="textSecondary">{label}</ThemedText>
      <ThemedText style={styles.rowValue} numberOfLines={1}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    fontFamily: Type.regular,
    fontSize: 16,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.three },
  rowValue: { flexShrink: 1 },
});
