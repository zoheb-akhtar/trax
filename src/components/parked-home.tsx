// Distances are formatted in the units chosen in settings, which the React Compiler can't
// see as an input; memoizing here would leave old units on screen after a change.
'use no memo';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { entryLabel } from '@/components/security-entries';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import type { CameraId, Connection } from '@/device/types';
import { useRideHistory } from '@/history/history-provider';
import {
  combinedSafetyScore,
  safetyColor,
  safetyLabel,
  safetyScore,
  weekStart,
} from '@/history/ride-history';
import { formatDistance, formatDuration } from '@/nav/geo';
import { useNav } from '@/nav/nav-provider';
import { useRideUi } from '@/ride-ui/ride-ui-provider';
import type { SecurityKind } from '@/security/security-log';
import { useSecurity } from '@/security/security-provider';

const LINK: Record<Connection, { label: string; color: string }> = {
  connected: { label: 'In range', color: Status.ok },
  simulated: { label: 'Simulated', color: Status.warn },
  connecting: { label: 'Connecting', color: Status.warn },
  offline: { label: 'Out of range', color: Status.danger },
};

const CAMERA_LABEL: Record<CameraId, string> = { front: 'Front', rear: 'Rear' };

const ACTIVITY: Record<SecurityKind, { color: string; icon: SymbolViewProps['name'] }> = {
  armed: { color: '#0E9F6E', icon: { ios: 'lock.fill', android: 'lock', web: 'lock' } },
  disarmed: {
    color: '#9AA0A8',
    icon: { ios: 'lock.open.fill', android: 'lock_open', web: 'lock_open' },
  },
  tamper: {
    color: '#E5484D',
    icon: { ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' },
  },
  motion: {
    color: '#FF8A3D',
    icon: { ios: 'figure.walk', android: 'directions_walk', web: 'directions_walk' },
  },
  siren: {
    color: '#E5484D',
    icon: { ios: 'speaker.wave.2.fill', android: 'volume_up', web: 'volume_up' },
  },
  crash: {
    color: '#FF8A3D',
    icon: { ios: 'figure.fall', android: 'personal_injury', web: 'personal_injury' },
  },
};
/** The camera previews are stills, refreshed this often. */
const PREVIEW_EVERY_MS = 4000;
const DAY_MS = 86400000;

/**
 * The Ride tab while Trax is armed: a live look through its cameras, its status, what has happened lately, and where you're going next.
 */
export function ParkedHome({ onPlan }: { onPlan(): void }) {
  const insets = useSafeAreaInsets();
  const { state, connection, setMode, snapshotUrlFor } = useDevice();
  const { parked, entries } = useSecurity();
  const { rides } = useRideHistory();
  const trip = useNav();
  const { nav, destination, route } = trip;
  const link = LINK[connection];
  const since = parked
    ? new Date(parked.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  const lastRide = rides.find((ride) => ride.endedAt != null);
  const [openedAt] = useState(() => Date.now());
  const thisWeek = weekStart(openedAt);
  const week = rides.filter((ride) => ride.startedAt >= thisWeek);
  const weekDistance = week.reduce((sum, ride) => sum + ride.distance, 0);
  const recent = entries.slice(0, 3);
  // Distance for each of the seven days, oldest first.
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = thisWeek + i * DAY_MS;
    return week
      .filter((ride) => ride.startedAt >= start && ride.startedAt < start + DAY_MS)
      .reduce((sum, ride) => sum + ride.distance, 0);
  });
  const longest = Math.max(...days, 1);
  const weekPasses = week.reduce((sum, ride) => sum + ride.closePasses, 0);
  const weekRate = weekDistance > 300 ? (weekPasses / (weekDistance / 1000)).toFixed(1) : null;
  // The whole week's close passes over its whole distance, as the explanation below says.
  const score = combinedSafetyScore(week);
  const batteryInk = (state.battery ?? 100) < 20 ? '#C2410C' : '#0E8A5F';
  const batteryColors: [string, string] =
    (state.battery ?? 100) < 20 ? ['#FBE4DC', '#FBE4DC'] : ['#E2F3E9', '#E2F3E9'];

  // Camera previews: a fresh still every few seconds while this screen is up.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), PREVIEW_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  const previews = state.cameras
    .map((camera) => ({ camera, url: connection === 'connected' ? snapshotUrlFor(camera) : null }))
    .filter((p) => p.url !== null);
  // The big picture at the top: the rear camera unless the other one is picked.
  const [chosen, setCamera] = useState<CameraId>('rear');
  // A camera asked for through the AI agent ("show the front camera") wins while it lasts.
  const { pinnedCamera, pinCamera } = useRideUi();
  const camera = pinnedCamera ?? chosen;
  const main = previews.find((p) => p.camera === camera) ?? previews[0];

  const goodParking = trip.parking.find((p) => p.good && p.fromDestination < 350);

  const start = () => {
    setMode('ride');
    // With a route ready, the ride begins already following it.
    if (trip.status === 'ready') nav.start(false);
  };

  return (
    // Room at the top for the mic button, which sits over this screen.
    <View style={[styles.screen, { paddingTop: insets.top + 64 }]}>
      {/* The name, level with the mic button at the top right. */}
      <View style={[styles.brandRow, { top: insets.top + Spacing.two }]} pointerEvents="none">
        <Text style={styles.brand} accessibilityRole="header">
          Trax
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {main ? (
          <View style={styles.hero}>
            <Image
              source={{ uri: `${main.url}&t=${tick}` }}
              // A new picture every few seconds: keeping each one would fill the phone.
              cachePolicy="none"
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={300}
            />
            <View style={styles.heroTop}>
              <View style={styles.previewTag}>
                <View style={styles.liveDot} />
                <Text style={styles.previewLabel}>Live</Text>
              </View>
              <View style={[styles.previewTag, styles.armedTag]}>
                <SymbolView
                  name={{ ios: 'lock.shield.fill', android: 'shield_lock', web: 'shield_lock' }}
                  size={13}
                  tintColor="#fff"
                />
                <Text style={styles.previewLabel}>Guarding</Text>
              </View>
            </View>
            {previews.length > 1 && (
              <View style={styles.switcher}>
                {previews.map(({ camera: c }) => (
                  <Pressable
                    key={c}
                    onPress={() => {
                      pinCamera(null);
                      setCamera(c);
                    }}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityState={{ selected: c === main.camera }}
                    style={[styles.switch, c === main.camera && styles.switchOn]}
                  >
                    <Text style={[styles.switchText, c === main.camera && styles.switchTextOn]}>
                      {CAMERA_LABEL[c]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        ) : (
          <View style={[styles.hero, styles.heroEmpty]}>
            <SymbolView
              name={{ ios: 'lock.shield.fill', android: 'shield_lock', web: 'shield_lock' }}
              size={56}
              tintColor={Status.ok}
            />
            <Text style={styles.muted}>
              {connection === 'simulated'
                ? 'The simulated device has no camera picture.'
                : 'Trax is out of range, so there is no picture.'}
            </Text>
          </View>
        )}

        <View style={styles.parkedRow}>
          <SymbolView
            name={{ ios: 'mappin.circle.fill', android: 'location_on', web: 'location_on' }}
            size={16}
            tintColor="#6B7076"
          />
          <Text style={styles.parkedText} numberOfLines={1}>
            {parked?.place ? `Parked at ${parked.place}` : 'Parked'}
            {since ? ` · since ${since}` : ''}
          </Text>
        </View>

        <View style={styles.tiles}>
          <LinearGradient colors={batteryColors} style={styles.tile}>
            <Text style={styles.tileLabel}>BATTERY</Text>
            <Text style={styles.tileBig}>
              {state.battery == null ? '–' : `${Math.round(state.battery)}%`}
            </Text>
            <View style={styles.meter}>
              <View
                style={[
                  styles.meterFill,
                  { width: `${state.battery ?? 0}%`, backgroundColor: batteryInk },
                ]}
              />
            </View>
          </LinearGradient>
          <View style={[styles.tile, styles.inkTile]}>
            <Text style={styles.tileLabel}>TRAX</Text>
            <View style={styles.inline}>
              <View style={[styles.dot, { backgroundColor: link.color }]} />
              <Text style={styles.tileMid}>{link.label}</Text>
            </View>
            <Text style={styles.tileNote}>{since ? `Armed since ${since}` : 'Armed'}</Text>
          </View>
        </View>

        <View style={[styles.tile, styles.section, { backgroundColor: '#E6EDFB' }]}>
          <Text style={styles.tileLabel}>THIS WEEK</Text>
          <View style={styles.weekTop}>
            <Text style={styles.tileBig}>{formatDistance(weekDistance)}</Text>
            <View style={styles.bars}>
              {days.map((distance, i) => (
                <View key={i} style={styles.barTrack}>
                  <View
                    style={[
                      styles.bar,
                      { height: `${Math.max((distance / longest) * 100, distance > 0 ? 8 : 3)}%` },
                    ]}
                  />
                </View>
              ))}
            </View>
          </View>
          <View style={styles.figures}>
            <Figure value={String(week.length)} label={week.length === 1 ? 'Ride' : 'Rides'} />
            <Figure value={String(weekPasses)} label="Close passes" />
            <Figure
              value={score == null ? '–' : `${score}/100`}
              color={score == null ? undefined : safetyColor(score)}
              label={score == null ? 'Safety score' : `Safety score · ${safetyLabel(score)}`}
            />
          </View>
          <Text style={styles.explain}>
            Safety score: 100 means no vehicle passed close. It drops as close passes get more
            frequent; one on a normal ride still scores in the 90s
            {weekRate == null ? '' : ` (${weekRate} per km this week)`}.
          </Text>
        </View>

        <View style={[styles.tile, styles.section, styles.inkTile]}>
          <Text style={styles.tileLabel}>LAST RIDE</Text>
          {lastRide ? (
            <>
              <Text style={styles.tileMid} numberOfLines={1}>
                {lastRide.destination ? `To ${lastRide.destination}` : 'Ride'}
              </Text>
              <Text style={styles.tileNote}>
                {new Date(lastRide.startedAt).toLocaleDateString([], {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                ·{' '}
                {new Date(lastRide.startedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </Text>
              <View style={styles.figures}>
                <Figure value={formatDistance(lastRide.distance)} label="Distance" />
                <Figure
                  value={formatDuration(
                    ((lastRide.endedAt ?? lastRide.lastSeen) - lastRide.startedAt) / 1000,
                  )}
                  label="Time"
                />
                <Figure value={String(lastRide.closePasses)} label="Close passes" />
                <Figure
                  value={`${safetyScore(lastRide)}/100`}
                  label="Safety score"
                  color={safetyColor(safetyScore(lastRide))}
                />
              </View>
            </>
          ) : (
            <Text style={styles.tileNote}>No rides yet. Your next ride shows up here.</Text>
          )}
        </View>

        <ThemedText type="label">Recent activity</ThemedText>
        {recent.length === 0 ? (
          <Text style={styles.muted}>Nothing yet.</Text>
        ) : (
          <View style={styles.list}>
            {recent.map((entry, i) => (
              <View key={entry.id} style={[styles.activity, i > 0 && styles.activityDivider]}>
                <View style={[styles.badge, { backgroundColor: ACTIVITY[entry.kind].color }]}>
                  <SymbolView name={ACTIVITY[entry.kind].icon} size={15} tintColor="#fff" />
                </View>
                <Text style={styles.activityName} numberOfLines={1}>
                  {entryLabel(entry)}
                </Text>
                <Text style={styles.muted}>
                  {new Date(entry.ts).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Where to and Start stay pinned at the bottom. */}
      <View style={[styles.dock, { paddingBottom: insets.bottom + Spacing.two }]}>
        <View style={styles.card}>
          {destination ? (
            <View style={styles.trip}>
              <View style={styles.grow}>
                <Text style={styles.tripName} numberOfLines={1}>
                  {destination.name}
                </Text>
                {trip.status === 'routing' && (
                  <View style={styles.inline}>
                    <ActivityIndicator size="small" color="#6B7076" />
                    <Text style={styles.muted}>Finding a cycling route…</Text>
                  </View>
                )}
                {trip.status === 'error' && <Text style={styles.error}>{trip.error}</Text>}
                {trip.status === 'ready' && route && (
                  <Text style={styles.muted} numberOfLines={1}>
                    {formatDuration(route.duration)} · {formatDistance(route.distance)}
                    {goodParking
                      ? ` · parking ${formatDistance(goodParking.fromDestination)} from the end`
                      : ''}
                  </Text>
                )}
              </View>
              <Pressable
                onPress={() => nav.clear()}
                hitSlop={12}
                accessibilityLabel="Clear destination"
              >
                <SymbolView
                  name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
                  size={22}
                  tintColor="#A4A7AC"
                />
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.whereTo}
              onPress={onPlan}
              accessibilityRole="button"
              accessibilityLabel="Choose a destination"
            >
              <SymbolView
                name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
                size={17}
                tintColor="#6B7076"
              />
              <Text style={styles.whereToText}>Where to?</Text>
            </Pressable>
          )}
        </View>
        <Button
          title={destination ? `Start ride to ${destination.name}` : 'Start ride'}
          size="large"
          onPress={start}
        />
      </View>
    </View>
  );
}

function Figure({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <View style={styles.figure}>
      <Text style={[styles.figureValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.figureLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.four },
  brandRow: { position: 'absolute', left: Spacing.three, height: 52, justifyContent: 'center' },
  brand: { color: '#111111', fontFamily: Type.bold, fontSize: 30, letterSpacing: -0.8 },
  parkedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: -Spacing.one,
  },
  parkedText: { flexShrink: 1, color: '#4A4E55', fontFamily: Type.medium, fontSize: 15 },
  title: {
    color: '#111111',
    fontFamily: Type.regular,
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -1,
  },
  hero: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1B2330',
  },
  heroEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
  },
  heroTop: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  armedTag: { backgroundColor: Status.ok },
  switcher: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    padding: 3,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  switch: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 9 },
  switchOn: { backgroundColor: '#fff' },
  switchText: { color: 'rgba(255,255,255,0.8)', fontFamily: Type.medium, fontSize: 12 },
  switchTextOn: { color: '#000' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tiles: { flexDirection: 'row', gap: Spacing.two },
  tile: { flex: 1, gap: 2, padding: 16, borderRadius: 22, overflow: 'hidden' },
  inkTile: {
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
  section: { flex: 0, gap: 6 },
  weekTop: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  figures: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.12)',
  },
  explain: {
    color: '#5B616A',
    fontFamily: Type.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  figure: { flex: 1, gap: 2 },
  figureValue: { color: '#111111', fontFamily: Type.medium, fontSize: 18 },
  figureLabel: { color: '#5B616A', fontFamily: Type.medium, fontSize: 10, letterSpacing: 0.6 },
  tileLabel: { color: '#5B616A', fontFamily: Type.semibold, fontSize: 10, letterSpacing: 1.4 },
  tileBig: {
    color: '#111111',
    fontFamily: Type.medium,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -1,
  },
  tileMid: { color: '#111111', fontFamily: Type.medium, fontSize: 22, lineHeight: 30 },
  tileNote: { color: '#5B616A', fontFamily: Type.regular, fontSize: 13 },
  meter: {
    height: 6,
    marginTop: 8,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.08)',
    overflow: 'hidden',
  },
  meterFill: { height: 6, borderRadius: 3 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 44 },
  barTrack: { width: 10, height: '100%', justifyContent: 'flex-end' },
  bar: { borderRadius: 3, backgroundColor: '#2F6FE4' },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Status.danger },
  previewLabel: { color: '#fff', fontFamily: Type.medium, fontSize: 11, letterSpacing: 0.8 },
  list: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 46,
  },
  activityDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline },
  activityName: { flex: 1, color: '#111111', fontFamily: Type.regular, fontSize: 15 },
  dock: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Hairline,
    backgroundColor: '#F2F1ED',
  },
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: Spacing.three,
  },
  whereTo: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 },
  whereToText: { color: '#6B7076', fontFamily: Type.regular, fontSize: 16 },
  trip: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 8 },
  grow: { flex: 1, gap: 2 },
  tripName: { color: '#111111', fontFamily: Type.medium, fontSize: 17 },
  muted: { color: '#6B7076', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
  error: { color: '#C62F34', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
});
