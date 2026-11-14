import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
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

/** Summary of the planned trip: time, parking, closures, and Start. */
export function TripCard() {
  const trip = useNav();
  const { nav, route } = trip;
  const parking = trip.parking.find((p) => p.good && p.fromDestination < 350) ?? null;

  return (
    <View style={styles.panel}>
      <View style={styles.summary}>
        {trip.status === 'routing' && (
          <>
            <ActivityIndicator color="#111111" />
            <Text style={styles.body}>Finding a cycling route…</Text>
          </>
        )}
        {trip.status === 'error' && <Text style={[styles.error, styles.grow]}>{trip.error}</Text>}
        {trip.status === 'ready' && route && (
          <>
            <Text style={styles.big}>{formatDuration(route.duration)}</Text>
            <Text style={[styles.muted, styles.grow]} numberOfLines={1}>
              {formatDistance(route.distance)} to {trip.destination?.name}
            </Text>
          </>
        )}
        <Pressable
          onPress={() => nav.clear()}
          hitSlop={12}
          style={styles.close}
          accessibilityLabel="Clear route">
          <SymbolView
            name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
            size={22}
            tintColor="#6B7076"
          />
        </Pressable>
      </View>

      {trip.status === 'ready' && (
        <>
          {trip.destination?.isParking ? (
            // Already heading to a parking spot: say so, and don't offer another.
            <View style={styles.row}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>P</Text>
              </View>
              <Text style={styles.body} numberOfLines={1}>
                Parking at the end · {trip.destination.detail}
              </Text>
            </View>
          ) : (
            <ParkingLine
              state={trip.extras}
              parking={parking}
              onPark={(p) =>
                nav.setDestination({
                  name: 'Bike parking',
                  detail: describeParking(p),
                  lat: p.lat,
                  lon: p.lon,
                  isParking: true,
                })
              }
              onRetry={() => nav.retryExtras()}
            />
          )}
          {trip.extras === 'ready' && (
            <View style={styles.row}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: trip.closures.length ? Status.danger : Status.ok },
                ]}
              />
              <Text style={styles.body} numberOfLines={2}>
                {trip.closures.length
                  ? `${trip.closures.length} closed or under construction near the route${closureNames(trip.closures)}`
                  : 'No closures mapped on this route'}
              </Text>
            </View>
          )}
        </>
      )}

      <View style={styles.actions}>
        <Toggle label="Bike lanes" value={trip.bikeLanes} onChange={(on) => nav.setBikeLanes(on)} />
        {trip.status === 'ready' && (
          <>
            <View style={styles.grow}>
              <Button title="Demo" variant="secondary" onPress={() => nav.start(true)} />
            </View>
            <View style={styles.grow}>
              <Button title="Start" onPress={() => nav.start(false)} />
            </View>
          </>
        )}
      </View>
      <Text style={styles.credit}>Map data © OpenStreetMap contributors</Text>
    </View>
  );
}

function closureNames(closures: { name: string | null }[]) {
  const names = [...new Set(closures.map((c) => c.name).filter(Boolean))].slice(0, 2);
  return names.length ? `: ${names.join(', ')}` : '';
}

function ParkingLine({
  state,
  parking,
  onPark,
  onRetry,
}: {
  state: 'idle' | 'loading' | 'ready' | 'error';
  parking: Parking | null;
  onPark(parking: Parking): void;
  onRetry(): void;
}) {
  if (state === 'loading') {
    return (
      <View style={styles.row}>
        <ActivityIndicator color="#6B7076" size="small" />
        <Text style={styles.muted}>Loading streets, parking and closures…</Text>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.row}>
        <Text style={[styles.muted, styles.grow]}>
          Couldn&apos;t load streets, parking and closures.
        </Text>
        <Button title="Retry" size="small" variant="secondary" onPress={onRetry} />
      </View>
    );
  }
  if (state !== 'ready') return null;
  if (!parking) {
    return <Text style={styles.muted}>No good bike parking mapped near the destination.</Text>;
  }
  return (
    <View style={styles.row}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>P</Text>
      </View>
      <View style={styles.grow}>
        <Text style={styles.body} numberOfLines={1}>
          Good parking · {formatDistance(parking.fromDestination)} walk
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {describeParking(parking)}
        </Text>
      </View>
      <Button title="Park here" size="small" variant="secondary" onPress={() => onPark(parking)} />
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
        tintColor={value ? '#111111' : '#6B7076'}
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
  summary: { flexDirection: 'row', alignItems: 'baseline', gap: 10, minHeight: 40 },
  close: { alignSelf: 'center' },
  big: { color: '#111111', fontFamily: Type.light, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  body: { flexShrink: 1, color: '#111111', fontFamily: Type.regular, fontSize: 14, lineHeight: 19 },
  muted: { color: '#6B7076', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
  credit: { color: '#9A9DA3', fontFamily: Type.regular, fontSize: 9, textAlign: 'center' },
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
    height: 52,
    paddingHorizontal: 12,
    borderRadius: 14,
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
