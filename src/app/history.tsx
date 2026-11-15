import { Image } from 'expo-image';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Share,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RouteMap } from '@/components/route-map';
import { Screen } from '@/components/screen';
import { ScreenHeader } from '@/components/screen-header';
import { SecurityEntryDetail, SecurityEntryList } from '@/components/security-entries';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import type { CameraId } from '@/device/types';
import { pictureUri } from '@/history/files';
import { useRideHistory } from '@/history/history-provider';
import { safetyLabel, safetyScore, type Ride, type RideMoment } from '@/history/ride-history';
import { formatDistance } from '@/nav/geo';
import { useSecurity } from '@/security/security-provider';

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

const WEEK_MS = 7 * 86400000;

function weekTitle(week: number) {
  if (week === 0) return 'This week';
  return week === 1 ? 'Last week' : `${week} weeks ago`;
}

/**
 * Splits items into weeks (0 = the last seven days) and returns the first `weeks` of them,
 * plus whether anything older is left to show.
 */
function byWeek<T>(items: T[], weekOf: (item: T) => number, weeks: number) {
  const shown = Array.from({ length: weeks }, (_, week) => ({
    week,
    items: items.filter((item) => weekOf(item) === week),
  }));
  const older = items.map(weekOf).filter((week) => week >= weeks);
  // Empty weeks in the past are left out; this week always shows, even when empty.
  return {
    shown: shown.filter((group) => group.week === 0 || group.items.length > 0),
    more: older.length > 0,
    // "Show earlier" goes straight to the next week that has something in it.
    next: older.length > 0 ? Math.min(...older) + 1 : weeks,
  };
}

export default function HistoryScreen() {
  const { loaded, rides, deleteRide } = useRideHistory();
  const security = useSecurity();
  const [tab, setTab] = useState<'rides' | 'security'>('rides');
  const [openId, setOpenId] = useState<string | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  // How many weeks back each list goes. Both start at this week; "Show earlier" adds one.
  const [rideWeeks, setRideWeeks] = useState(1);
  const [securityWeeks, setSecurityWeeks] = useState(1);
  const [openedAt] = useState(() => Date.now());
  const weeksAgo = (ts: number) => Math.max(Math.floor((openedAt - ts) / WEEK_MS), 0);
  const ridesThisWeek = rides.filter((r) => weeksAgo(r.startedAt) === 0).length;
  const entriesThisWeek = security.entries.filter((e) => weeksAgo(e.ts) === 0).length;
  const rideGroups = byWeek(rides, (r) => weeksAgo(r.startedAt), rideWeeks);
  const entryGroups = byWeek(security.entries, (e) => weeksAgo(e.ts), securityWeeks);
  const open = rides.find((ride) => ride.id === openId) ?? null;
  const openEntry = security.entries.find((entry) => entry.id === openEntryId) ?? null;

  return (
    <Screen>
      <ScreenHeader title="History" />
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['rides', 'security'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            style={[styles.tab, tab === t && styles.tabSelected]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextSelected]}>
              {t === 'rides' ? `Rides · ${ridesThisWeek}` : `Security · ${entriesThisWeek}`}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'security' ? (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {security.loaded && security.entries.length === 0 ? (
            <ThemedText themeColor="textSecondary">
              Nothing yet. Arming, disarming and every alarm are recorded here, with pictures when
              Velo&apos;s camera is connected.
            </ThemedText>
          ) : (
            <>
              {entryGroups.shown.map((group) => (
                <Fragment key={group.week}>
                  <ThemedText type="label">{weekTitle(group.week)}</ThemedText>
                  {group.items.length === 0 ? (
                    <ThemedText themeColor="textSecondary">Nothing this week.</ThemedText>
                  ) : (
                    <SecurityEntryList
                      entries={group.items}
                      onOpen={(entry) => setOpenEntryId(entry.id)}
                    />
                  )}
                </Fragment>
              ))}
              {entryGroups.more && (
                <Button
                  title="Show earlier"
                  variant="secondary"
                  onPress={() => setSecurityWeeks(entryGroups.next)}
                />
              )}
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {loaded && rides.length === 0 && (
            <ThemedText themeColor="textSecondary">
              No rides yet. Velo starts recording when you set off and saves the ride when you tap
              End ride.
            </ThemedText>
          )}
          {rides.length > 0 && <WeekSummary rides={rides} />}
          {rideGroups.shown.map((group) => (
            <Fragment key={group.week}>
              {group.week > 0 && <ThemedText type="label">{weekTitle(group.week)}</ThemedText>}
              {group.items.length === 0 && (
                <ThemedText themeColor="textSecondary">No rides this week.</ThemedText>
              )}
              {group.items.map((ride) => (
                <Pressable
                  key={ride.id}
                  onPress={() => setOpenId(ride.id)}
                  accessibilityRole="button"
                >
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
                      {' · '}
                      {safetyLabel(safetyScore(ride))}
                    </ThemedText>
                  </Card>
                </Pressable>
              ))}
            </Fragment>
          ))}
          {rideGroups.more && (
            <Button
              title="Show earlier"
              variant="secondary"
              onPress={() => setRideWeeks(rideGroups.next)}
            />
          )}
        </ScrollView>
      )}

      <Modal
        visible={openEntry !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpenEntryId(null)}
      >
        {openEntry && (
          <SecurityEntryDetail
            entry={openEntry}
            onClose={() => setOpenEntryId(null)}
            onDelete={() => {
              setOpenEntryId(null);
              security.deleteEntry(openEntry.id);
            }}
          />
        )}
      </Modal>

      <Modal
        visible={open !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpenId(null)}
      >
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

const DAY_MS = 86400000;

/** Totals for the last seven days, with a bar per day. */
function WeekSummary({ rides }: { rides: Ride[] }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = today.getTime() - (6 - i) * DAY_MS;
    const onDay = rides.filter((r) => r.startedAt >= start && r.startedAt < start + DAY_MS);
    return {
      label: new Date(start).toLocaleDateString([], { weekday: 'narrow' }),
      distance: onDay.reduce((sum, r) => sum + r.distance, 0),
      rides: onDay.length,
      passes: onDay.reduce((sum, r) => sum + r.closePasses, 0),
      seconds: onDay.reduce((sum, r) => sum + ((r.endedAt ?? r.lastSeen) - r.startedAt) / 1000, 0),
    };
  });
  const total = (key: 'distance' | 'rides' | 'passes' | 'seconds') =>
    days.reduce((sum, d) => sum + d[key], 0);
  const longest = Math.max(...days.map((d) => d.distance), 1);
  const minutes = Math.round(total('seconds') / 60);

  return (
    <Card style={styles.week}>
      <ThemedText type="label">Last 7 days</ThemedText>
      <Text style={styles.weekTotal}>{formatDistance(total('distance'))}</Text>
      <View style={styles.bars}>
        {days.map((d, i) => (
          <View key={i} style={styles.barColumn}>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.bar,
                  { height: `${Math.max((d.distance / longest) * 100, d.distance > 0 ? 6 : 0)}%` },
                ]}
              />
            </View>
            <Text style={styles.barLabel}>{d.label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.weekRow}>
        <WeekStat label="Rides" value={String(total('rides'))} />
        <WeekStat
          label="Time"
          value={minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`}
        />
        <WeekStat label="Close passes" value={String(total('passes'))} />
      </View>
    </Card>
  );
}

function WeekStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.grow}>
      <Text style={styles.weekStat}>{value}</Text>
      <ThemedText type="label" numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
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
  const score = safetyScore(ride);
  const track = ride.track ?? [];
  const pins = closePasses.flatMap((m) => (m.at ? [m.at] : []));
  const share = () =>
    Share.share({
      message: `Velo ride: ${formatDistance(ride.distance)} in ${duration(ride)}, ${
        ride.closePasses
      } close ${ride.closePasses === 1 ? 'pass' : 'passes'}, safety score ${score}/100.`,
    }).catch(() => {});
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
    setIndex(
      Math.max(
        sameCamera.findIndex((m) => m.id === moment.id),
        0,
      ),
    );
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

        <View style={styles.scoreRow}>
          <Text style={styles.score}>{score}</Text>
          <View style={styles.grow}>
            <ThemedText style={styles.scoreLabel}>{safetyLabel(score)} ride</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Safety score, from {ride.closePasses} close{' '}
              {ride.closePasses === 1 ? 'pass' : 'passes'} over {formatDistance(ride.distance)}
            </ThemedText>
          </View>
        </View>

        {track.length > 1 && (
          <>
            <ThemedText type="label">Route</ThemedText>
            <RouteMap track={track} pins={pins} />
            {pins.length > 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                Red dots are close passes.
              </ThemedText>
            )}
          </>
        )}

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
                  accessibilityLabel={`Picture at ${time(item.ts, true)}`}
                >
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
                style={[styles.pass, i > 0 && styles.passDivider]}
              >
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

        <Button title="Share ride" onPress={share} />
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
  tabs: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
  },
  tab: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 11 },
  tabSelected: { backgroundColor: '#111111' },
  tabText: { color: '#6B7076', fontFamily: Type.medium, fontSize: 13 },
  tabTextSelected: { color: '#FFF' },
  list: { gap: Spacing.two, paddingBottom: Spacing.six + Spacing.four },
  week: { gap: Spacing.two },
  weekTotal: {
    color: '#111111',
    fontFamily: Type.light,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 96 },
  barColumn: { flex: 1, alignItems: 'center', gap: 6 },
  barTrack: { flex: 1, alignSelf: 'stretch', justifyContent: 'flex-end' },
  bar: { borderRadius: 4, backgroundColor: Status.danger, minWidth: 6 },
  barLabel: { color: '#6B7076', fontFamily: Type.medium, fontSize: 10 },
  weekRow: {
    flexDirection: 'row',
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Hairline,
  },
  weekStat: { color: '#111111', fontFamily: Type.medium, fontSize: 17 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  score: {
    color: '#111111',
    fontFamily: Type.light,
    fontSize: 56,
    lineHeight: 60,
    letterSpacing: -2,
  },
  scoreLabel: { fontFamily: Type.medium, fontSize: 18, lineHeight: 24 },
  ride: { gap: 4 },
  rideHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rideTitle: { fontFamily: Type.medium, fontSize: 18, lineHeight: 24 },
  recording: { color: Status.danger, fontFamily: Type.semibold, fontSize: 10, letterSpacing: 1.2 },
  grow: { flex: 1 },
  sheet: { flex: 1, backgroundColor: '#F2F1ED', paddingHorizontal: Spacing.three },
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
    backgroundColor: '#FFFFFF',
  },
  statValue: { color: '#111111', fontFamily: Type.regular, fontSize: 18 },
  viewer: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
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
    color: '#6B7076',
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
    backgroundColor: '#FFFFFF',
  },
  thumbDanger: { borderColor: Status.danger },
  thumbSelected: { borderColor: '#111111' },
  passes: { gap: 0, paddingVertical: 0 },
  pass: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
  },
  passDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline },
});
