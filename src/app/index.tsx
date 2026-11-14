import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraFeed } from '@/components/camera-feed';
import { CameraSwitch } from '@/components/camera-switch';
import { Chip } from '@/components/chip';
import { EdgeGlow } from '@/components/edge-glow';
import { ParkedHome } from '@/components/parked-home';
import { ProximityScene } from '@/components/proximity-scene';
import { ThemedText } from '@/components/themed-text';
import { TripCard, TripSearch } from '@/components/trip-planner';
import { TurnBanner } from '@/components/turn-banner';
import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import {
  isCloseVehicle,
  isNearCyclist,
  mattersWhileRiding,
  mergeCyclists,
  toWorld,
} from '@/device/geometry';
import type { Connection, Detection } from '@/device/types';
import { useAutoCamera } from '@/device/use-auto-camera';
import { useLinger } from '@/hooks/use-linger';
import { haptic } from '@/lib/haptics';
import { formatDistance, formatDuration, pointAlong } from '@/nav/geo';
import { buildGround } from '@/nav/ground';
import { useNav } from '@/nav/nav-provider';

const CONNECTION_CHIP: Record<Connection, { label: string; color: string }> = {
  simulated: { label: 'Simulated', color: Status.warn },
  connecting: { label: 'Connecting', color: Status.warn },
  connected: { label: 'Live', color: Status.ok },
  offline: { label: 'Offline', color: Status.danger },
};

/** Faster than this, the rider is moving and the screen goes quiet. */
const MOVING_KMH = 5;
/** The camera picture stays up this long after a close vehicle has gone. */
const CAMERA_LINGER_MS = 3000;

/** Where the nearest close vehicle is, relative to the rider. */
function nearestThreat(detections: Detection[]) {
  const nearest = detections
    .filter(isCloseVehicle)
    .map(toWorld)
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return null;
  return {
    side: nearest.x < -0.5 ? 'left' : nearest.x > 0.5 ? 'right' : 'both',
    where: nearest.z > 0 ? 'behind' : 'ahead',
  } as const;
}

/**
 * The ride screen has two looks.
 *
 * Ride mode (while moving or following a route) is deliberately quiet: speed,
 * the route, and only nearby vehicles and cyclists. The one thing that
 * interrupts is a close vehicle: edge glow, one buzz, and the camera picture.
 *
 * Full view (when stopped, or switched on by hand) shows everything: all
 * detections, both notices and the large camera picture.
 */
export default function RideScreen() {
  const insets = useSafeAreaInsets();
  const { state, connection, streamUrlFor, setMode } = useDevice();
  const trip = useNav();
  const { nav, navigating, progress, route, roads, buildings, position } = trip;
  const [fullView, setFullView] = useState(false);
  const [planning, setPlanning] = useState(false);

  const riding = state.mode === 'ride';
  const everything = riding ? mergeCyclists(state.detections) : [];
  const moving = (state.speedKmh ?? 0) > MOVING_KMH;
  const quiet = riding && !fullView && (navigating || moving);
  const detections = quiet ? everything.filter(mattersWhileRiding) : everything;

  const { camera, automatic, pin } = useAutoCamera(state.cameras, everything);
  const threat = nearestThreat(everything);
  const vehicleClose = threat !== null;
  const cameraUp = useLinger(vehicleClose, CAMERA_LINGER_MS);
  // A cyclist ahead is in plain sight, so ride mode only mentions one coming up behind.
  const cyclist = threat
    ? null
    : (everything
        .filter(isNearCyclist)
        .map(toWorld)
        .find((c) => !quiet || c.z > 0) ?? null);
  const chip = CONNECTION_CHIP[connection];

  // Once a route is planned, the 3D view's ground is the real map.
  const ground = useMemo(
    () => (route ? buildGround(route, roads, buildings) : null),
    [route, roads, buildings],
  );
  const at = useMemo(() => {
    // A route that is planned but not started yet is previewed from its first metres.
    if (route && !navigating) return pointAlong(route.points, route.cumulative, 0);
    if (!position || !progress) return null;
    // GPS is a few metres out, which would draw the rider beside the route. While they are
    // near it, put them on it; once they are properly off route, show where they really are.
    if (route && !progress.offRoute) {
      const onRoute = pointAlong(route.points, route.cumulative, progress.along);
      return { lat: onRoute.lat, lon: onRoute.lon, heading: progress.heading };
    }
    return { ...position, heading: progress.heading };
  }, [position, progress, route, navigating]);

  useEffect(() => {
    if (vehicleClose) haptic.warning();
  }, [vehicleClose]);

  const feed = (
    <CameraFeed
      streamUrl={streamUrlFor(camera)}
      connection={connection}
      detections={everything.filter((d) => (d.camera ?? 'front') === camera)}
    />
  );

  return (
    <View style={styles.screen}>
      <View style={styles.stage}>
        {riding ? (
          <ProximityScene
            detections={detections}
            speedKmh={state.speedKmh}
            ground={ground}
            at={at}
          />
        ) : (
          <ParkedHome onPlan={() => setPlanning(true)} />
        )}

        {riding && (
          <>
            <View style={[styles.top, { top: insets.top }]} pointerEvents="none">
              <Text style={styles.speedValue}>
                {state.speedKmh == null ? '–' : state.speedKmh.toFixed(0)}
              </Text>
              <Text style={styles.speedUnit}>KM/H</Text>
              {navigating && progress && (
                <View style={styles.turn}>
                  <TurnBanner progress={progress} compact />
                </View>
              )}
            </View>

            {/* Ride mode: the camera only appears for a close vehicle. */}
            {quiet && cameraUp && (
              <Animated.View
                entering={FadeInDown.duration(180)}
                exiting={FadeOutDown.duration(250)}
                style={styles.pip}
                pointerEvents="none"
              >
                {feed}
                <View style={styles.pipLabel}>
                  <Chip>{camera}</Chip>
                </View>
              </Animated.View>
            )}

            <View style={styles.stageFooter} pointerEvents="box-none">
              <View style={styles.footerLeft}>
                <Text style={styles.caption}>Estimated</Text>
                <Button
                  title={quiet ? 'Full view' : 'Ride mode'}
                  size="small"
                  variant="secondary"
                  onPress={() => setFullView(quiet)}
                />
              </View>
              {/* One notice at a time, and in ride mode a vehicle is signalled by the edge glow alone. */}
              {threat && !quiet && (
                <Animated.View
                  entering={FadeIn.duration(120)}
                  exiting={FadeOut.duration(300)}
                  style={styles.notice}
                >
                  <Text style={styles.noticeText}>Vehicle close {threat.where}</Text>
                </Animated.View>
              )}
              {cyclist && (
                <Animated.View
                  entering={FadeIn.duration(120)}
                  exiting={FadeOut.duration(300)}
                  style={[styles.notice, styles.cyclistNotice]}
                >
                  <Text style={[styles.noticeText, styles.cyclistText]}>
                    Cyclist {cyclist.z > 0 ? 'behind' : 'ahead'}
                  </Text>
                </Animated.View>
              )}
              {quiet && connection !== 'connected' && (
                <Chip dotColor={chip.color}>{chip.label}</Chip>
              )}
            </View>
          </>
        )}
      </View>

      {riding && (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + Spacing.two }]}>
          {!quiet && (
            <View style={styles.feed}>
              {feed}
              <View style={styles.feedTop}>
                <Chip dotColor={chip.color}>{chip.label}</Chip>
                {state.cameras.length > 1 && (
                  <CameraSwitch
                    cameras={state.cameras}
                    value={camera}
                    automatic={automatic}
                    onChange={pin}
                  />
                )}
              </View>
              {state.battery != null && (
                <View style={styles.battery}>
                  <Chip>{Math.round(state.battery)}%</Chip>
                </View>
              )}
            </View>
          )}

          {navigating && progress ? (
            <View style={styles.bar}>
              {progress.arrived ? (
                <>
                  <Text style={styles.barValue}>Arrived</Text>
                  <Text style={styles.barDetail} numberOfLines={1}>
                    {trip.destination?.name}
                  </Text>
                  <Button title="Done" size="small" onPress={() => nav.clear()} />
                </>
              ) : (
                <>
                  <Text style={styles.barValue}>{formatDistance(progress.remaining)}</Text>
                  <Text style={styles.barDetail}>
                    {formatDuration(progress.remainingTime)} left
                  </Text>
                  <Button
                    title="End route"
                    size="small"
                    variant="secondary"
                    onPress={() => nav.stop()}
                  />
                </>
              )}
            </View>
          ) : trip.status !== 'idle' ? (
            <TripCard />
          ) : (
            <View style={styles.bar}>
              <Pressable
                style={styles.whereTo}
                onPress={() => setPlanning(true)}
                accessibilityRole="button"
                accessibilityLabel="Choose a destination"
              >
                <SymbolView
                  name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
                  size={16}
                  tintColor="#6B7076"
                />
                <Text style={styles.whereToText}>Where to?</Text>
              </Pressable>
              <Button
                title="End ride"
                size="small"
                variant="secondary"
                onPress={() => setMode('security')}
              />
            </View>
          )}
        </View>
      )}

      <EdgeGlow side="left" active={threat?.side === 'left' || threat?.side === 'both'} />
      <EdgeGlow side="right" active={threat?.side === 'right' || threat?.side === 'both'} />

      <Modal
        visible={planning}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPlanning(false)}
      >
        <SafeAreaView style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <ThemedText type="subtitle">Where to?</ThemedText>
            <Button
              title="Cancel"
              size="small"
              variant="secondary"
              onPress={() => setPlanning(false)}
            />
          </View>
          {planning && <TripSearch onDone={() => setPlanning(false)} />}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F2F1ED' },
  stage: { flex: 1 },
  top: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  speedValue: {
    color: '#111111',
    fontFamily: Type.light,
    fontSize: 88,
    lineHeight: 96,
    letterSpacing: -2,
  },
  speedUnit: {
    color: '#6B7076',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 2,
    marginTop: -8,
  },
  turn: { alignSelf: 'stretch', marginHorizontal: Spacing.three, marginTop: Spacing.two },
  pip: {
    position: 'absolute',
    right: Spacing.three,
    bottom: 64,
    // Narrow enough to sit beside the rider, who is in the middle of the screen.
    width: '37%',
    aspectRatio: 4 / 3,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Status.danger,
    overflow: 'hidden',
  },
  pipLabel: { position: 'absolute', top: 8, left: 8 },
  stageFooter: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  footerLeft: { gap: 6, alignItems: 'flex-start' },
  caption: {
    color: 'rgba(0,0,0,0.4)',
    fontFamily: Type.medium,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  notice: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: Status.danger,
  },
  cyclistNotice: { backgroundColor: Status.cyclist },
  cyclistText: { color: '#04130E' },
  noticeText: { color: '#FFF', fontFamily: Type.semibold, fontSize: 13, letterSpacing: 0.2 },
  bottom: { paddingHorizontal: Spacing.three, gap: Spacing.two },
  feed: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    overflow: 'hidden',
  },
  feedTop: {
    position: 'absolute',
    top: Spacing.two + 4,
    left: Spacing.two + 4,
    right: Spacing.two + 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  battery: { position: 'absolute', right: Spacing.two + 4, bottom: Spacing.two + 4 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    paddingLeft: 14,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
  },
  barValue: { color: '#111111', fontFamily: Type.regular, fontSize: 22, letterSpacing: -0.4 },
  barDetail: { flex: 1, color: '#6B7076', fontFamily: Type.regular, fontSize: 13 },
  whereTo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  whereToText: { color: '#6B7076', fontFamily: Type.regular, fontSize: 16 },
  sheet: { flex: 1, backgroundColor: '#F2F1ED', padding: Spacing.three, gap: Spacing.three },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.two,
  },
});
