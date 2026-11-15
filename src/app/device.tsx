import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import { checkAgentServer } from '@/agent/client';
import { testPush, useLaptopPushes } from '@/components/push-watcher';
import { notifyNow, pushProjectId } from '@/lib/notify';
import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { useRideHistory } from '@/history/history-provider';
import { useParking } from '@/parking/parking-provider';
import { useSecurity } from '@/security/security-provider';
import { normalizeHost } from '@/device/http-source';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/settings/settings-provider';

export default function DeviceScreen() {
  const theme = useTheme();
  const {
    settings,
    updateSettings,
    state,
    connection,
    simulateTamper,
    simulateCrash,
    simulateCar,
    simulatePothole,
    testRoutes,
    hasSpeaker,
  } = useDevice();
  const prefs = useSettings();
  const pushOn = useLaptopPushes();
  const [checkingAgent, setCheckingAgent] = useState(false);
  const testAgent = async () => {
    setCheckingAgent(true);
    const { title, detail } = await checkAgentServer(prefs.agentUrl, prefs.agentToken);
    setCheckingAgent(false);
    Alert.alert(title, detail);
  };
  const testNotification = async () => {
    if (pushOn) {
      const problem = await testPush(prefs.agentUrl, prefs.agentToken);
      if (!problem) return;
      Alert.alert('Push not sent', problem);
    }
    const shown = await notifyNow('Trax', 'This is a test notification. Alerts will look like this.');
    if (!shown) Alert.alert('Notifications are off', 'Allow notifications for Trax in Settings.');
  };
  const { rides, clearRides, loadSampleWeek } = useRideHistory();
  const { entries, clearEntries } = useSecurity();
  const { stays, clearParking, loadSampleParking } = useParking();
  const clearHistory = () =>
    Alert.alert(
      'Clear all history?',
      `This deletes ${rides.length} rides, ${stays.length} parking stays and ${entries.length} security events from this phone, with their pictures. It can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearRides();
            clearParking();
            clearEntries();
          },
        },
      ],
    );
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
          <ThemedText type="label">Trax address</ThemedText>
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
            The phone and Trax must be on the same Wi-Fi, such as this phone&apos;s hotspot.
          </ThemedText>
          <Button
            title={usingDevice && host === settings.host ? 'Reconnect' : 'Connect to Trax'}
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
            <ThemedText style={styles.grow}>Ask Trax button</ThemedText>
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
            placeholder="Server password, e.g. trax-1234"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.input, { color: theme.text }]}
          />
          <ThemedText type="small" themeColor="textSecondary">
            The agent runs through a small server on your laptop (device/agent_proxy.py), which
            prints its password when it starts. The AI key stays there, never in this app.
          </ThemedText>
          <Button
            title={checkingAgent ? 'Checking…' : 'Test agent server'}
            variant="secondary"
            disabled={checkingAgent}
            onPress={testAgent}
          />
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
          <View style={styles.choice}>
            <ThemedText style={styles.grow}>Speak from</ThemedText>
            {(['bike', 'phone', 'both'] as const).map((where) => (
              <Button
                key={where}
                title={where === 'bike' ? 'Bike' : where === 'phone' ? 'Phone' : 'Both'}
                size="small"
                variant={prefs.speakFrom === where ? 'primary' : 'secondary'}
                onPress={() => prefs.update({ speakFrom: where })}
              />
            ))}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {hasSpeaker
              ? 'Trax’s speaker is connected.'
              : 'Trax has no speaker connected, so the phone speaks for now.'}{' '}
            “Bike” falls back to the phone whenever the bike can’t be reached.
          </ThemedText>
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
            If Trax detects a crash, a message with your location is prepared for this person. Kept
            on this phone only.
          </ThemedText>
        </Card>

        <Card>
          <ThemedText type="label">Notifications</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {pushOn
              ? 'The laptop is watching Trax and sends a notification when the bike is moved, even with this app closed.'
              : settings.source !== 'device'
                ? 'Trax shows a notification when the bike is moved while this app is open. With a real Trax connected, the laptop can also notify you with the app closed.'
                : pushProjectId()
                  ? 'Trax shows a notification when the bike is moved while this app is open. Allow notifications and connect the agent server so the laptop can notify you with the app closed.'
                  : 'Trax shows a notification when the bike is moved while this app is open. Notifications with the app closed need this project set up for push (eas init).'}
          </ThemedText>
          <Button title="Send a test notification" variant="secondary" onPress={testNotification} />
        </Card>


        {simulateTamper && (
          <Card>
            <ThemedText type="label">Demo</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {testRoutes
                ? 'For the test server on the laptop. A real Trax ignores these: move the bike instead.'
                : 'Arms the simulated Trax and pretends someone moved the bike.'}
            </ThemedText>
            <Button
              title="Simulate bike being moved"
              variant="secondary"
              onPress={simulateTamper}
            />
            {simulateCar && (
              <Button
                title="Simulate a car close behind"
                variant="secondary"
                onPress={async () => {
                  if (!(await simulateCar())) {
                    Alert.alert('Not available', 'This Trax has no test routes. Only the laptop test server does.');
                  }
                }}
              />
            )}
            {simulatePothole && (
              <Button
                title="Simulate a pothole"
                variant="secondary"
                onPress={() => {
                  if (state.mode !== 'ride') {
                    Alert.alert('Start a ride first', 'Potholes are recorded while riding.');
                    return;
                  }
                  simulatePothole();
                }}
              />
            )}
            {simulateCrash && (
              <Button title="Simulate a crash" variant="secondary" onPress={simulateCrash} />
            )}
          </Card>
        )}
        <Card>
          <ThemedText type="label">History</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {rides.length} {rides.length === 1 ? 'ride' : 'rides'}, {stays.length} parking{' '}
            {stays.length === 1 ? 'stay' : 'stays'} and {entries.length} security{' '}
            {entries.length === 1 ? 'event' : 'events'} saved on this phone.
          </ThemedText>
          <Button
            title="Load a sample week"
            variant="secondary"
            onPress={() => {
              loadSampleWeek();
              loadSampleParking();
            }}
          />
          <Button title="Clear all history" variant="secondary" onPress={clearHistory} />
        </Card>
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
