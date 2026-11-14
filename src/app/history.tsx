import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import type { CameraId } from '@/device/types';
import { pictureUri } from '@/history/files';
import { useRideHistory } from '@/history/history-provider';
import type { Ride, RideMoment } from '@/history/ride-history';
import { formatDistance } from '@/nav/geo';

const time = (ts: number, seconds = false) =>
  new Date(ts).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : null),
  });

const day = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function duration(ride: Ride) {
  const seconds = Math.round(((ride.endedAt ?? ride.lastSeen) - ride.startedAt) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function averageKmh(ride: Ride) {
  const hours = ((ride.endedAt ?? ride.lastSeen) - ride.startedAt) / 3600000;
  return hours > 0 ? ride.distance / 1000 / hours : 0;
}

export default function HistoryScreen() {
  const { loaded, rides, deleteRide } = useRideHistory();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rides.find((ride) => ride.id === openId) ?? null;

  return (
    <Screen>
      <ScreenHeader title="History" />
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {loaded && rides.length === 0 && (
          <ThemedText themeColor="textSecondary">
            No rides yet. Velo starts recording when you set off and saves the ride when you tap
            End ride.
          </ThemedText>
        )}
        {rides.map((ride) => (
          <Pressable key={ride.id} onPress={() => setOpenId(ride.id)} accessibilityRole="button">
            <Card style={styles.ride}>
              <View style={styles.rideHeader}>
                <ThemedText type="label">
                  {day(ride.startedAt)} · {time(ride.startedAt)}
                </ThemedText>
                {ride.endedAt == null && <Text style={styles.recording}>● RECORDING</Text>}
              </View>
              <ThemedText style={styles.rideTitle} numberOfLines={1}>
                {ride.destination ? `To ${ride.destination}` : 'Ride'}
              </ThemedText>
              <ThemedText themeColor="textSecondary">
                {duration(ride)} · {formatDistance(ride.distance)} ·{' '}
                {ride.closePasses === 1 ? '1 close pass' : `${ride.closePasses} close passes`}
              </ThemedText>
            </Card>
          </Pressable>
        ))}
      </ScrollView>

      <Modal
        visible={open !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpenId(null)}>
        {open && (
          <RideDetail
            key={open.id}
            ride={open}
            onClose={() => setOpenId(null)}
            onDelete={() => {
              setOpenId(null);
              deleteRide(open.id);
            }}
          />
        )}
      </Modal>
    </Screen>
  );
}

const CAMERA_LABEL: Record<CameraId, string> = { front: 'Front', rear: 'Rear' };
const PLAY_FRAME_MS = 300;
const THUMB_WIDTH = 72;
const THUMB_GAP = 6;
const THUMB_STEP = THUMB_WIDTH + THUMB_GAP;

function RideDetail({
  ride,
  onClose,
  onDelete,
}: {
  ride: Ride;
  onClose(): void;
  onDelete(): void;
}) {
  const pictures = ride.moments.filter((m) => m.file !== null).sort((a, b) => a.ts - b.ts);
  const cameras = (['rear', 'front'] as const).filter((c) => pictures.some((m) => m.camera === c));
  const [camera, setCamera] = useState<CameraId>(cameras[0] ?? 'rear');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const frames = pictures.filter((m) => m.camera === camera);
  const shown: RideMoment | undefined = frames[Math.min(index, frames.length - 1)];
  const closePasses = ride.moments.filter((m) => m.kind === 'close-pass');
  const strip = useRef<FlatList<RideMoment>>(null);
  const shownIndex = Math.min(index, frames.length - 1);

  // Keep the picture being shown in view in the strip of thumbnails.
  useEffect(() => {
    if (shownIndex >= 0) {
      strip.current?.scrollToIndex({ index: shownIndex, viewPosition: 0.5, animated: true });
    }
  }, [shownIndex, camera]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i + 1 < frames.length) return i + 1;
        setPlaying(false);
        return i;
      });
    }, PLAY_FRAME_MS);
    return () => clearInterval(timer);
  }, [playing, frames.length]);

  const show = (moment: RideMoment) => {
    setPlaying(false);
    setCamera(moment.camera);
    const sameCamera = pictures.filter((m) => m.camera === moment.camera);
    setIndex(Math.max(sameCamera.findIndex((m) => m.id === moment.id), 0));
  };

  const confirmDelete = () =>
    Alert.alert('Delete this ride?', 'Its pictures are deleted too. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);

  return (
    <SafeAreaView style={styles.sheet}>
      <View style={styles.sheetHeader}>
        <View style={styles.grow}>
          <ThemedText type="label">
            {day(ride.startedAt)} · {time(ride.startedAt)}
          </ThemedText>
          <ThemedText type="subtitle" numberOfLines={1}>
            {ride.destination ? `To ${ride.destination}` : 'Ride'}
          </ThemedText>
        </View>
        <Button title="Done" size="small" variant="secondary" onPress={onClose} />
      </View>

      <ScrollView contentContainerStyle={styles.detail} showsVerticalScrollIndicator={false}>
        <View style={styles.stats}>
          <Stat label="Time" value={duration(ride)} />
          <Stat label="Dist" value={formatDistance(ride.distance)} />
          <Stat label="Avg" value={`${averageKmh(ride).toFixed(0)} km/h`} />
          <Stat label="Top" value={`${ride.maxSpeedKmh.toFixed(0)} km/h`} />
        </View>

        <ThemedText type="label">Camera history</ThemedText>
        {shown ? (
          <>
            <View style={styles.viewer}>
              <Image
                source={{ uri: pictureUri(shown.file!) }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
              <View style={styles.viewerTop}>
                <Text style={styles.tag}>
                  {CAMERA_LABEL[shown.camera]} · {time(shown.ts, true)}
                </Text>
                {shown.kind === 'close-pass' && (
                  <Text style={[styles.tag, styles.tagDanger]}>Close pass</Text>
                )}
              </View>
            </View>

            <View style={styles.controls}>
              <Button
                title={playing ? 'Pause' : 'Play'}
                size="small"
                onPress={() => {
                  // Playing from the last picture starts again from the first.
                  if (!playing && index >= frames.length - 1) setIndex(0);
                  setPlaying(!playing);
                }}
              />
              <Text style={styles.count}>
                {Math.min(index, frames.length - 1) + 1} / {frames.length}
              </Text>
              {cameras.map((c) => (
                <Button
                  key={c}
                  title={CAMERA_LABEL[c]}
                  size="small"
                  variant={c === camera ? 'primary' : 'secondary'}
                  onPress={() => {
                    setPlaying(false);
                    setCamera(c);
                    setIndex(0);
                  }}
                />
              ))}
            </View>

            <FlatList
              ref={strip}
              horizontal
              data={frames}
              getItemLayout={(_, i) => ({ length: THUMB_STEP, offset: THUMB_STEP * i, index: i })}
              keyExtractor={(m) => m.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
              renderItem={({ item, index: i }) => (
                <Pressable
                  onPress={() => {
                    setPlaying(false);
                    setIndex(i);
                  }}
                  accessibilityLabel={`Picture at ${time(item.ts, true)}`}>
                  <Image
                    source={{ uri: pictureUri(item.file!) }}
                    style={[
                      styles.thumb,
                      item.kind === 'close-pass' && styles.thumbDanger,
                      item.id === shown.id && styles.thumbSelected,
                    ]}
                    contentFit="cover"
                  />
                </Pressable>
              )}
            />
          </>
        ) : (
          <ThemedText themeColor="textSecondary">
            No pictures were saved for this ride. Pictures need a connected Velo with a camera; the
            simulated device has none.
          </ThemedText>
        )}

        <ThemedText type="label">Close passes</ThemedText>
        {closePasses.length === 0 ? (
          <ThemedText themeColor="textSecondary">None on this ride.</ThemedText>
        ) : (
          <Card style={styles.passes}>
            {closePasses.map((moment, i) => (
              <Pressable
                key={moment.id}
                disabled={!moment.file}
                onPress={() => show(moment)}
                style={[styles.pass, i > 0 && styles.passDivider]}>
                <ThemedText>
                  {time(moment.ts, true)} · {moment.camera === 'rear' ? 'from behind' : 'ahead'}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {moment.file ? 'View' : 'No picture'}
                </ThemedText>
              </Pressable>
            ))}
          </Card>
        )}

        <Button title="Delete ride" variant="secondary" onPress={confirmDelete} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <ThemedText type="label" numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.two, paddingBottom: Spacing.six },
  ride: { gap: 4 },
  rideHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rideTitle: { fontFamily: Type.medium, fontSize: 18, lineHeight: 24 },
  recording: { color: Status.danger, fontFamily: Type.semibold, fontSize: 10, letterSpacing: 1.2 },
  grow: { flex: 1 },
  sheet: { flex: 1, backgroundColor: '#07080B', paddingHorizontal: Spacing.three },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  detail: { gap: Spacing.three, paddingBottom: Spacing.six },
  stats: { flexDirection: 'row', gap: Spacing.two },
  stat: {
    flex: 1,
    gap: 4,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#111317',
  },
  statValue: { color: '#fff', fontFamily: Type.regular, fontSize: 18 },
  viewer: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#111317',
  },
  viewerTop: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tag: {
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 0.8,
    fontVariant: ['tabular-nums'],
  },
  tagDanger: { backgroundColor: Status.danger },
  controls: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  count: {
    flex: 1,
    color: '#8B9099',
    fontFamily: Type.regular,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  strip: { gap: THUMB_GAP },
  thumb: {
    width: THUMB_WIDTH,
    height: 54,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: '#111317',
  },
  thumbDanger: { borderColor: Status.danger },
  thumbSelected: { borderColor: '#fff' },
  passes: { gap: 0, paddingVertical: 0 },
  pass: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
  },
  passDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline },
});
