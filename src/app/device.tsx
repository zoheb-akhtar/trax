import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { normalizeHost } from '@/device/http-source';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/settings/settings-provider';

export default function DeviceScreen() {
  const theme = useTheme();
  const { settings, updateSettings, state, connection, simulateTamper, simulateCrash } =
    useDevice();
  const prefs = useSettings();
  const [host, setHost] = useState(settings.host);
  const usingDevice = settings.source === 'device';

  return (
    <Screen>
      <ScreenHeader title="Device" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
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

        <Card>
          <ThemedText type="label">AI agent</ThemedText>
          <View style={styles.choice}>
            <ThemedText style={styles.grow}>Ask Velo button</ThemedText>
            <Switch
              value={prefs.agentEnabled}
              onValueChange={(agentEnabled) => prefs.update({ agentEnabled })}
            />
          </View>
          <TextInput
            value={prefs.agentUrl}
            onChangeText={(agentUrl) => prefs.update({ agentUrl })}
            placeholder="Agent server, e.g. 192.168.1.20:8787"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[styles.input, { color: theme.text }]}
          />
          <TextInput
            value={prefs.agentToken}
            onChangeText={(agentToken) => prefs.update({ agentToken })}
            placeholder="Server token (optional)"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={[styles.input, { color: theme.text }]}
          />
          <ThemedText type="small" themeColor="textSecondary">
            The agent runs through a small server on your laptop (device/agent_proxy.py). The AI
            key stays there, never in this app.
          </ThemedText>
        </Card>

        <Card>
          <ThemedText type="label">Preferences</ThemedText>
          <View style={styles.choice}>
            <ThemedText style={styles.grow}>Units</ThemedText>
            {(['km', 'mi'] as const).map((u) => (
              <Button
                key={u}
                title={u === 'km' ? 'Kilometres' : 'Miles'}
                size="small"
                variant={prefs.units === u ? 'primary' : 'secondary'}
                onPress={() => prefs.update({ units: u })}
              />
            ))}
          </View>
          <View style={styles.choice}>
            <ThemedText style={styles.grow}>Spoken alerts</ThemedText>
            <Switch value={prefs.voice} onValueChange={(voice) => prefs.update({ voice })} />
          </View>
        </Card>

        <Card>
          <ThemedText type="label">Emergency contact</ThemedText>
          <TextInput
            value={prefs.contactName}
            onChangeText={(contactName) => prefs.update({ contactName })}
            placeholder="Name"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
          />
          <TextInput
            value={prefs.contactPhone}
            onChangeText={(contactPhone) => prefs.update({ contactPhone })}
            placeholder="Phone number"
            placeholderTextColor={theme.textSecondary}
            keyboardType="phone-pad"
            style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
          />
          <ThemedText type="small" themeColor="textSecondary">
            If Velo detects a crash, a message with your location is prepared for this person. Kept
            on this phone only.
          </ThemedText>
        </Card>

        {simulateTamper && (
          <Card>
            <ThemedText type="label">Demo</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Arms the simulated Velo and pretends someone moved the bike.
            </ThemedText>
            <Button
              title="Simulate bike being moved"
              variant="secondary"
              onPress={simulateTamper}
            />
            {simulateCrash && (
              <Button title="Simulate a crash" variant="secondary" onPress={simulateCrash} />
            )}
          </Card>
        )}
      </ScrollView>
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
  scroll: { gap: Spacing.three, paddingBottom: 140 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  grow: { flex: 1 },
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
