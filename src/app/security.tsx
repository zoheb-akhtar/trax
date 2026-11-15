import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';

import { ArmControl } from '@/components/arm-control';
import { CameraFeed } from '@/components/camera-feed';
import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { SecurityEntryDetail, SecurityEntryList } from '@/components/security-entries';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import type { CameraId } from '@/device/types';
import { distance, formatDistance } from '@/nav/geo';
import { useNav } from '@/nav/nav-provider';
import { useSecurity } from '@/security/security-provider';

const RECENT = 5;
const CAMERA_LABEL: Record<CameraId, string> = { front: 'Front', rear: 'Rear' };

export default function SecurityScreen() {
  const { state, connection, setMode, streamUrlFor, chirp } = useDevice();
  const { entries, parked, soundAlarm, deleteEntry } = useSecurity();
  const { position } = useNav();
  const [viewing, setViewing] = useState(false);
  const [camera, setCamera] = useState<CameraId>('rear');
  const [openId, setOpenId] = useState<string | null>(null);

  const armed = state.mode === 'security';
  const shownCamera = state.cameras.includes(camera) ? camera : state.cameras[0];
  const streamUrl = streamUrlFor(shownCamera);
  const open = entries.find((entry) => entry.id === openId) ?? null;
  const parkedSince = parked
    ? new Date(parked.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <Screen>
      <ScreenHeader title="Security" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <ArmControl armed={armed} onToggle={() => setMode(armed ? 'ride' : 'security')} />
          <ThemedText style={styles.status}>{armed ? 'Armed' : 'Not armed'}</ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.hint}>
            {armed
              ? 'Velo sounds its alarm if the bike is moved.'
              : 'Tap the shield when you park.'}
          </ThemedText>
        </View>

        {armed && parked && (
          <Card style={styles.tight}>
            <ThemedText type="label">Parked</ThemedText>
            <ThemedText style={styles.cardTitle} numberOfLines={1}>
              {parked.place ?? 'Location saved'}
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              Since {parkedSince}
              {position ? ` · ${formatDistance(distance(position, parked))} from you` : ''}
            </ThemedText>
          </Card>
        )}

        <Card>
          <ThemedText type="label">Camera</ThemedText>
          {viewing && (
            <>
              <View style={styles.viewer}>
                <CameraFeed streamUrl={streamUrl} connection={connection} detections={[]} />
              </View>
              {state.cameras.length > 1 && (
                <View style={styles.cameras}>
                  {state.cameras.map((c) => (
                    <View key={c} style={styles.grow}>
                      <Button
                        title={CAMERA_LABEL[c]}
                        size="small"
                        variant={c === shownCamera ? 'primary' : 'secondary'}
                        onPress={() => setCamera(c)}
                      />
                    </View>
                  ))}
                </View>
              )}
              {!streamUrl && (
                <ThemedText type="small" themeColor="textSecondary">
                  The simulated device has no camera picture.
                </ThemedText>
              )}
            </>
          )}
          <Button
            title={viewing ? 'Hide camera' : 'View camera'}
            variant="secondary"
            onPress={() => setViewing(!viewing)}
          />
          <Button title="Find my bike" variant="secondary" onPress={chirp} />
          <Button title="Sound alarm" variant="danger" onPress={soundAlarm} />
        </Card>

        <ThemedText type="label">Recent activity</ThemedText>
        {entries.length === 0 ? (
          <ThemedText themeColor="textSecondary">Nothing yet.</ThemedText>
        ) : (
          <>
            <SecurityEntryList
              entries={entries.slice(0, RECENT)}
              onOpen={(entry) => setOpenId(entry.id)}
            />
            {entries.length > RECENT && (
              <ThemedText type="small" themeColor="textSecondary">
                Older activity is in History.
              </ThemedText>
            )}
          </>
        )}

        <ThemedText type="small" themeColor="textSecondary">
          Alerts and pictures reach this phone only while it is connected to Velo.
        </ThemedText>
      </ScrollView>

      <Modal
        visible={open !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpenId(null)}>
        {open && (
          <SecurityEntryDetail
            entry={open}
            onClose={() => setOpenId(null)}
            onDelete={() => {
              setOpenId(null);
              deleteEntry(open.id);
            }}
          />
        )}
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.three, paddingBottom: Spacing.six + Spacing.four },
  hero: { alignItems: 'center' },
  status: { fontFamily: Type.light, fontSize: 40, lineHeight: 46, letterSpacing: -0.8 },
  hint: { textAlign: 'center', marginTop: Spacing.one },
  tight: { gap: 4 },
  cardTitle: { fontFamily: Type.medium, fontSize: 18, lineHeight: 24 },
  viewer: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 16,
    overflow: 'hidden',
  },
  cameras: { flexDirection: 'row', gap: Spacing.two },
  grow: { flex: 1 },
});
