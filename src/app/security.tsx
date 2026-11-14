import { ScrollView, StyleSheet, View } from 'react-native';

import { ArmControl } from '@/components/arm-control';
import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';

export default function SecurityScreen() {
  const { state, setMode } = useDevice();
  const armed = state.mode === 'security';

  return (
    <Screen>
      <ScreenHeader title="Security" />

      <View style={styles.hero}>
        <ArmControl armed={armed} onToggle={() => setMode(armed ? 'ride' : 'security')} />
        <ThemedText style={styles.status}>{armed ? 'Armed' : 'Not armed'}</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.hint}>
          {armed
            ? 'Velo sounds its alarm if the bike is moved.'
            : 'Tap the shield when you park.'}
        </ThemedText>
      </View>

      <ThemedText type="label">Recent events</ThemedText>
      <ScrollView style={styles.list}>
        {state.events.length === 0 ? (
          <ThemedText themeColor="textSecondary">Nothing yet.</ThemedText>
        ) : (
          <Card style={styles.events}>
            {state.events.map((event, i) => (
              <View key={event.id} style={[styles.event, i > 0 && styles.eventDivider]}>
                <ThemedText>{event.kind === 'tamper' ? 'Bike moved' : 'Motion nearby'}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary" style={styles.time}>
                  {new Date(event.ts).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </ThemedText>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>

      <ThemedText type="small" themeColor="textSecondary">
        Alerts reach this phone only while it is connected to Velo.
      </ThemedText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingBottom: Spacing.three },
  status: { fontFamily: Type.light, fontSize: 40, lineHeight: 46, letterSpacing: -0.8 },
  hint: { textAlign: 'center', marginTop: Spacing.one },
  list: { flex: 1 },
  events: { gap: 0, paddingVertical: 0 },
  event: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
  eventDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline },
  time: { fontVariant: ['tabular-nums'] },
});
