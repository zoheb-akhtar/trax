import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { searchPlaces } from '@/nav/api';
import { formatDistance, formatDuration } from '@/nav/geo';
import { bikeLaneShare } from '@/nav/ground';
import { useNav } from '@/nav/nav-provider';
import type { LatLon, Parking, Place } from '@/nav/types';

const PARKING_KIND: Record<string, string> = {
  stands: 'Bike stands',
  wide_stands: 'Bike stands',
  safe_loops: 'Bike loops',
  bollard: 'Bollards',
  shed: 'Bike shed',
  lockers: 'Bike lockers',
  building: 'Indoor parking',
  wall_loops: 'Wheel racks',
  ground_slots: 'Wheel slots',
  rack: 'Bike rack',
};

function describeParking(p: Parking) {
  return [
    PARKING_KIND[p.kind ?? ''] ?? 'Bike parking',
    p.capacity ? `${p.capacity} spaces` : null,
    p.covered ? 'covered' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---- Trip card: what the planned route looks like, and the button to start it --------

/**
 * The planned trip, kept to what a rider needs before setting off: where, how long, one
 * thing worth knowing, and Start. Cancel is a full-size button so it is easy to dismiss.
 */
export function TripCard() {
  const trip = useNav();
  const { nav, route, roads, destination } = trip;
  const share = useMemo(() => (route ? bikeLaneShare(route, roads) : null), [route, roads]);
  const ready = trip.status === 'ready' && route;

  const facts = ready
    ? [
        formatDuration(route.duration),
        formatDistance(route.distance),
        share !== null ? `${Math.round(share * 100)}% bike lanes` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : trip.status === 'routing'
      ? 'Finding a cycling route…'
      : null;

  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.title} numberOfLines={1}>
            {destination?.name ?? 'Route'}
          </Text>
          {facts && <Text style={styles.muted}>{facts}</Text>}
          {trip.status === 'error' && <Text style={styles.error}>{trip.error}</Text>}
        </View>
        <Button title="Cancel" size="small" variant="secondary" onPress={() => nav.clear()} />
      </View>

      {ready && <Heads trip={trip} />}
      {ready && trip.extras !== 'ready' && trip.roads.length === 0 && (
        <View style={styles.row}>
          <Text style={[styles.muted, styles.grow]}>
            {trip.extras === 'error'
              ? 'The street map didn’t load. The route still works.'
              : 'Loading the street map…'}
          </Text>
          {trip.extras === 'error' && (
            <Button title="Retry" size="small" variant="secondary" onPress={() => nav.retryExtras()} />
          )}
        </View>
      )}

      {ready && (
        <View style={styles.actions}>
          <View style={styles.start}>
            <Button title="Start" size="large" onPress={() => nav.start(false)} />
          </View>
          {/* Rides the route by itself, for showing the app without leaving the room. */}
          <View style={styles.grow}>
            <Button title="Preview" size="large" variant="secondary" onPress={() => nav.start(true)} />
          </View>
        </View>
      )}
      {trip.status === 'error' && destination && (
        <Button title="Try again" variant="secondary" onPress={() => nav.setDestination(destination)} />
      )}

      <View style={styles.row}>
        <Toggle label="Prefer bike lanes" value={trip.bikeLanes} onChange={(on) => nav.setBikeLanes(on)} />
        <Text style={[styles.credit, styles.grow]}>© OpenStreetMap</Text>
      </View>
    </View>
  );
}

function closureNames(closures: { name: string | null }[]) {
  const names = [...new Set(closures.map((c) => c.name).filter(Boolean))].slice(0, 2);
  return names.length ? `: ${names.join(', ')}` : '';
}

/**
 * At most one line of "heads up" under the trip: a closure on the way, or good bike parking
 * at the end. Nothing is shown while that information loads, or when there is nothing to say.
 */
function Heads({ trip }: { trip: ReturnType<typeof useNav> }) {
  const { nav, destination, closures } = trip;
  if (destination?.isParking) {
    return (
      <View style={styles.row}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>P</Text>
        </View>
        <Text style={styles.body} numberOfLines={1}>
          Bike parking at the end{destination.detail ? ` · ${destination.detail}` : ''}
        </Text>
      </View>
    );
  }
  if (trip.extras !== 'ready') return null;
  if (closures.length > 0) {
    return (
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: Status.danger }]} />
        <Text style={styles.body} numberOfLines={2}>
          {closures.length === 1 ? 'A closure' : `${closures.length} closures`} near the route
          {closureNames(closures)}
        </Text>
      </View>
    );
  }
  const parking = trip.parking.find((p) => p.good && p.fromDestination < 350);
  if (!parking) return null;
  return (
    <View style={styles.row}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>P</Text>
      </View>
      <Text style={[styles.body, styles.grow]} numberOfLines={1}>
        Bike parking {formatDistance(parking.fromDestination)} from the end
      </Text>
      <Button
        title="Park there"
        size="small"
        variant="secondary"
        onPress={() =>
          nav.setDestination({
            name: 'Bike parking',
            detail: describeParking(parking),
            lat: parking.lat,
            lon: parking.lon,
            isParking: true,
          })
        }
      />
    </View>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      hitSlop={6}
      style={[styles.toggle, value && styles.toggleOn]}>
      <SymbolView
        name={{ ios: 'bicycle', android: 'pedal_bike', web: 'pedal_bike' }}
        size={16}
        tintColor={value ? '#FFFFFF' : '#6B7076'}
      />
      <Text style={[styles.toggleText, value && styles.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

// ---- Search: start and destination ---------------------------------------------------

type Field = 'from' | 'to';

/** Start and destination fields with search-as-you-type. Calls `onDone` once a destination is picked. */
export function TripSearch({ onDone }: { onDone(): void }) {
  const { nav, origin, destination, position } = useNav();
  const near: LatLon | null = position ?? origin ?? destination;
  const [field, setField] = useState<Field>('to');
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ query: string; places: Place[] } | null>(null);

  const query = text.trim();
  const searchable = query.length >= 3;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    // Wait for a pause in typing before asking the shared search server.
    const timer = setTimeout(() => {
      searchPlaces(query, near, controller.signal)
        .then((places) => setFound({ query, places }))
        .catch(() => {
          if (!controller.signal.aborted) setFound({ query, places: [] });
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchable, query, near]);

  const results = searchable && found?.query === query ? found.places : null;

  const choose = (place: Place | null) => {
    setText('');
    if (field === 'from') {
      nav.setOrigin(place);
      setField('to');
      return;
    }
    if (!place) return;
    nav.setDestination(place);
    Keyboard.dismiss();
    onDone();
  };

  const input = (which: Field, value: Place | null, placeholder: string) => (
    <TextInput
      value={field === which ? text : (value?.name ?? '')}
      onFocus={() => {
        setField(which);
        setText('');
      }}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={which === 'from' ? '#3A3D42' : '#6B7076'}
      autoFocus={which === 'to'}
      autoCorrect={false}
      returnKeyType="search"
      clearButtonMode="while-editing"
      style={styles.input}
      accessibilityLabel={which === 'from' ? 'Starting point' : 'Destination'}
    />
  );

  return (
    <View style={styles.search}>
      <View style={styles.field}>
        <View style={styles.startDot} />
        {input('from', origin, 'Current location')}
      </View>
      <View style={styles.divider} />
      <View style={styles.field}>
        <View style={styles.endDot} />
        {input('to', destination, 'Where to?')}
      </View>

      <View style={styles.results}>
        {field === 'from' && (
          <Pressable style={styles.result} onPress={() => choose(null)}>
            <Text style={styles.resultName}>Current location</Text>
          </Pressable>
        )}
        {!searchable && field === 'to' && (
          <Text style={styles.resultHint}>Type a place or an address.</Text>
        )}
        {searchable && results === null && <Text style={styles.resultHint}>Searching…</Text>}
        {results?.length === 0 && <Text style={styles.resultHint}>No places found.</Text>}
        {results?.slice(0, 6).map((place, i) => (
          <Pressable
            key={`${place.lat},${place.lon},${i}`}
            style={styles.result}
            onPress={() => choose(place)}>
            <Text style={styles.resultName} numberOfLines={1}>
              {place.name}
            </Text>
            {!!place.detail && (
              <Text style={styles.resultDetail} numberOfLines={1}>
                {place.detail}
              </Text>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const PANEL = 'rgba(255,255,255,0.97)';

const styles = StyleSheet.create({
  panel: {
    gap: 12,
    padding: Spacing.three,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: PANEL,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1 },
  title: { color: '#111111', fontFamily: Type.semibold, fontSize: 20, lineHeight: 26 },
  start: { flex: 2 },
  body: { flexShrink: 1, color: '#111111', fontFamily: Type.regular, fontSize: 14, lineHeight: 19 },
  muted: { color: '#6B7076', fontFamily: Type.regular, fontSize: 15, lineHeight: 21 },
  credit: { color: '#9A9DA3', fontFamily: Type.regular, fontSize: 10, textAlign: 'right' },
  error: { color: '#C62F34', fontFamily: Type.regular, fontSize: 14, lineHeight: 19 },
  dot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 7 },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Status.ok,
  },
  badgeText: { color: '#FFF', fontFamily: Type.bold, fontSize: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#E8E7E2',
  },
  toggleOn: { backgroundColor: '#111111' },
  toggleText: { color: '#6B7076', fontFamily: Type.medium, fontSize: 13 },
  toggleTextOn: { color: '#FFF' },

  search: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
  },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50 },
  input: { flex: 1, color: '#111111', fontFamily: Type.regular, fontSize: 16, paddingVertical: 12 },
  startDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: '#111111' },
  endDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#111111' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Hairline, marginLeft: 24 },
  results: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Hairline, paddingVertical: 4 },
  result: { paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  resultName: { color: '#111111', fontFamily: Type.medium, fontSize: 15 },
  resultDetail: { color: '#6B7076', fontFamily: Type.regular, fontSize: 12, marginTop: 1 },
  resultHint: { color: '#6B7076', fontFamily: Type.regular, fontSize: 13, paddingVertical: 12 },
});
