// Distances are formatted in the units chosen in settings, which the React Compiler can't
// see as an input; memoizing here would leave old units on screen after a change.
'use no memo';

import { useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, View } from 'react-native';

import { ArmControl } from '@/components/arm-control';
import { BikeMap } from '@/components/bike-map';
import { CameraFeed } from '@/components/camera-feed';
import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { SecurityEntryDetail, SecurityEntryList } from '@/components/security-entries';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import type { CameraView } from '@/device/types';
import { distance, formatDistance } from '@/nav/geo';
import { useNav } from '@/nav/nav-provider';
import type { LatLon } from '@/nav/types';
import { useSecurity } from '@/security/security-provider';

const RECENT = 5;
/** Further than this from where it was parked, the bike counts as moved. */
const MOVED_M = 30;
/** Two GPS fixes this close together can't be told apart, so it counts as "here". */
const HERE_M = 25;

function howFar(you: LatLon, place: LatLon) {
  const metres = distance(you, place);
  return metres < HERE_M ? 'right by you' : `${formatDistance(metres)} from you`;
}

const CAMERA_LABEL: Record<CameraView, string> = {
  front: 'Front',
  security: 'Security',
  rear: 'Rear',
};

export default function SecurityScreen() {
  const { state, connection, setMode, streamUrlFor, chirp, views } = useDevice();
  const { entries, parked, lastSeen, soundAlarm, deleteEntry } = useSecurity();
  const { position } = useNav();
  // The security camera watches the parked bike, where the device has one.
  const [picked, setCamera] = useState<CameraView | null>(null);
  const camera = picked ?? (views.includes('security') ? 'security' : 'rear');
  const [openId, setOpenId] = useState<string | null>(null);

  const armed = state.mode === 'security';
  const shownCamera = views.includes(camera) ? camera : views[0];
  const streamUrl = streamUrlFor(shownCamera);
  const open = entries.find((entry) => entry.id === openId) ?? null;
  // Where the bike is, from its own GPS. Out of range, this is where it was last heard from.
  const live = connection === 'connected';
  const movedBy = parked && lastSeen ? distance(parked, lastSeen) : 0;
  const seenAt = lastSeen
    ? new Date(lastSeen.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  // You look for a missing bike on foot, so directions open in the phone's maps app (walking).
  const walkToBike = () => {
    if (!lastSeen) return;
    Linking.openURL(`http://maps.apple.com/?daddr=${lastSeen.lat},${lastSeen.lon}&dirflg=w`).catch(
      () => {},
    );
  };
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
              ? 'Trax sounds its alarm if the bike is moved.'
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
              {position ? ` · ${howFar(position, parked)}` : ''}
            </ThemedText>
          </Card>
        )}

        <Card style={styles.tight}>
          <ThemedText type="label">Find my bike</ThemedText>
          {lastSeen ? (
            <>
              <ThemedText style={styles.cardTitle} numberOfLines={1}>
                {lastSeen.place ?? 'Position known'}
              </ThemedText>
              <ThemedText themeColor="textSecondary">
                {live ? 'Live from Trax’s GPS' : `Last seen at ${seenAt}, now out of range`}
                {position ? ` · ${howFar(position, lastSeen)}` : ''}
              </ThemedText>
              {movedBy > MOVED_M && (
                <ThemedText style={styles.moved}>
                  Moved {formatDistance(movedBy)} from where you parked
                </ThemedText>
              )}
              <View style={styles.bikeMap}>
                <BikeMap
                  bike={lastSeen}
                  you={position}
                  parked={movedBy > MOVED_M ? parked : null}
                />
              </View>
            </>
          ) : (
            <ThemedText themeColor="textSecondary">
              Trax hasn’t reported a GPS position yet. You can still make it beep when it’s in range.
            </ThemedText>
          )}
          <View style={styles.cameras}>
            {lastSeen && (
              <View style={styles.grow}>
                <Button title="Walking directions" onPress={walkToBike} />
              </View>
            )}
            <View style={styles.grow}>
              <Button title="Make it beep" variant="secondary" disabled={!live} onPress={chirp} />
            </View>
          </View>
        </Card>

        <Card>
          <ThemedText type="label">Camera</ThemedText>
          <View style={styles.viewer}>
            <CameraFeed streamUrl={streamUrl} connection={connection} detections={[]} />
          </View>
          {views.length > 1 && (
            <View style={styles.cameras}>
              {views.map((c) => (
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
          Alerts and pictures reach this phone only while it is connected to Trax.
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
  moved: { color: Status.danger, fontFamily: Type.semibold },
  bikeMap: { marginVertical: Spacing.two },
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
