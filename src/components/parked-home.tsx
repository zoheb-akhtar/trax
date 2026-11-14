import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ArmedBike } from '@/components/armed-bike';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import type { Connection } from '@/device/types';
import { formatDistance, formatDuration } from '@/nav/geo';
import { useNav } from '@/nav/nav-provider';
import { useSecurity } from '@/security/security-provider';

const LINK: Record<Connection, { label: string; color: string }> = {
  connected: { label: 'In range', color: Status.ok },
  simulated: { label: 'Simulated', color: Status.warn },
  connecting: { label: 'Connecting', color: Status.warn },
  offline: { label: 'Out of range', color: Status.danger },
};

/**
 * The Ride tab while Velo is armed: the bike, its status at a glance, where
 * you're going next, and the button that starts the ride.
 */
export function ParkedHome({ onPlan }: { onPlan(): void }) {
  const insets = useSafeAreaInsets();
  const { state, connection, setMode } = useDevice();
  const { parked } = useSecurity();
  const trip = useNav();
  const { nav, destination, route } = trip;
  const link = LINK[connection];
  const since = parked
    ? new Date(parked.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const goodParking = trip.parking.find((p) => p.good && p.fromDestination < 350);

  const start = () => {
    setMode('ride');
    // With a route ready, the ride begins already following it.
    if (trip.status === 'ready') nav.start(false);
  };

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + Spacing.two, paddingBottom: insets.bottom + Spacing.three },
      ]}
    >
      <View style={styles.heading}>
        <ThemedText type="label" numberOfLines={1}>
          {parked?.place ? `Parked · ${parked.place}` : 'Parked'}
        </ThemedText>
        <Text style={styles.title}>Armed</Text>
      </View>

      <View style={styles.hero}>
        <ArmedBike size={350} />
      </View>

      <View style={styles.stats}>
        <Stat
          value={state.battery == null ? '–' : `${Math.round(state.battery)}%`}
          label="Battery"
        />
        <View style={styles.rule} />
        <Stat value={since ?? '–'} label="Armed since" />
        <View style={styles.rule} />
        <Stat value={link.label} label="Velo" dot={link.color} />
      </View>

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
  );
}

function Stat({ value, label, dot }: { value: string; label: string; dot?: string }) {
  return (
    <View style={styles.stat}>
      <View style={styles.inline}>
        {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
        <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
      </View>
      <ThemedText type="label" numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: Spacing.three, gap: Spacing.three },
  heading: { alignItems: 'center', gap: 2 },
  title: {
    color: '#111111',
    fontFamily: Type.regular,
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -1,
  },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 180 },
  stats: { flexDirection: 'row', alignItems: 'center' },
  stat: { flex: 1, alignItems: 'center', gap: 4 },
  statValue: { color: '#111111', fontFamily: Type.medium, fontSize: 17 },
  rule: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: 'rgba(0,0,0,0.15)' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: Spacing.three,
  },
  whereTo: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 },
  whereToText: { color: '#6B7076', fontFamily: Type.regular, fontSize: 16 },
  trip: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 },
  grow: { flex: 1, gap: 2 },
  tripName: { color: '#111111', fontFamily: Type.medium, fontSize: 17 },
  muted: { color: '#6B7076', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
  error: { color: '#C62F34', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
});
