import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { RouteMap } from '@/components/route-map';
import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui/card';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { formatDuration } from '@/nav/geo';
import { parkingSpots, stayLength, type ParkingStay } from '@/parking/parking-log';

function hours(ms: number) {
  return formatDuration(ms / 1000);
}

/**
 * The Parking tab in History: where the bike was left, for how long, and how full each rack
 * was. This is the parking layer of Velo's street data: counts only, no pictures.
 */
export function ParkingHistory({ stays, since }: { stays: ParkingStay[]; since: number }) {
  const [now] = useState(() => Date.now());
  const recent = stays.filter((s) => s.startedAt >= since);

  if (stays.length === 0) {
    return (
      <ThemedText themeColor="textSecondary">
        No parking yet. Each time Velo is armed, it notes where the bike was left, how long it
        stayed, and how many other bikes were parked there.
      </ThemedText>
    );
  }

  const spots = parkingSpots(recent.length > 0 ? recent : stays, now);
  const average =
    recent.reduce((sum, s) => sum + stayLength(s, now), 0) / Math.max(recent.length, 1);
  const fullest = Math.max(...spots.map((s) => s.mostBikes), 1);
  const mostUsed = Math.max(...spots.map((s) => s.stays.length), 1);

  return (
    <>
      <Card style={styles.summary}>
        <ThemedText type="label">Last 7 days</ThemedText>
        <Text style={styles.total}>
          {recent.length} {recent.length === 1 ? 'stay' : 'stays'}
        </Text>
        <View style={styles.row}>
          <Stat label="Avg stay" value={recent.length ? hours(average) : '—'} />
          <Stat label="Spots" value={String(spots.length)} />
          <Stat label="Fullest rack" value={`${fullest} bikes`} />
        </View>
      </Card>

      <RouteMap
        track={spots.map((s) => [s.lat, s.lon])}
        pins={[]}
        showRoute={false}
        dots={spots.map((s) => ({
          at: [s.lat, s.lon],
          radius: 7 + 9 * (s.stays.length / mostUsed),
          color: Status.accent,
        }))}
        label="Map of where the bike was parked"
      />
      <ThemedText type="small" themeColor="textSecondary">
        Bigger circles are spots used more often.
      </ThemedText>

      {spots.map((spot) => (
        <Card key={spot.id} style={styles.spot}>
          <ThemedText style={styles.place} numberOfLines={1}>
            {spot.place ?? 'Unnamed spot'}
          </ThemedText>
          <ThemedText themeColor="textSecondary">
            {spot.stays.length} {spot.stays.length === 1 ? 'stay' : 'stays'} · avg{' '}
            {hours(spot.averageMs)}
          </ThemedText>
          <View style={styles.rack}>
            <View style={styles.rackTrack}>
              <View
                style={[styles.rackFill, { width: `${Math.max((spot.mostBikes / fullest) * 100, 4)}%` }]}
              />
            </View>
            <Text style={styles.rackText}>
              {spot.mostBikes === 0 ? 'No other bikes seen' : `Up to ${spot.mostBikes} other bikes`}
            </Text>
          </View>
        </Card>
      ))}

      <ThemedText type="small" themeColor="textSecondary">
        Velo&apos;s camera counts the bikes and people around the rack while it guards your bike.
        Only the counts are kept: no pictures of the rack or of anyone passing.
      </ThemedText>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.grow}>
      <Text style={styles.statValue}>{value}</Text>
      <ThemedText type="label" numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { gap: Spacing.two },
  total: { color: '#111111', fontFamily: Type.light, fontSize: 44, lineHeight: 50, letterSpacing: -1 },
  row: {
    flexDirection: 'row',
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Hairline,
  },
  grow: { flex: 1 },
  statValue: { color: '#111111', fontFamily: Type.medium, fontSize: 17 },
  spot: { gap: 4 },
  place: { fontFamily: Type.medium, fontSize: 18, lineHeight: 24 },
  rack: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginTop: 4 },
  rackTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#ECEBE6', overflow: 'hidden' },
  rackFill: { height: 8, borderRadius: 4, backgroundColor: Status.accent },
  rackText: { color: '#6B7076', fontFamily: Type.medium, fontSize: 12, minWidth: 130, textAlign: 'right' },
});
