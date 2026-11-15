import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Hairline, Status, Type } from '@/constants/theme';
import type { LatLon } from '@/nav/types';

/** Map tiles are drawn at half their pixel size so they stay sharp on a phone screen. */
const TILE = 128;
const MAX_ZOOM = 19;
const MIN_ZOOM = 12;
/** Room kept around the markers, in points. */
const MARGIN = 56;

/** A position on the whole-world map at a zoom level, in points. */
function onWorld(at: LatLon, zoom: number) {
  const size = TILE * 2 ** zoom;
  const lat = (at.lat * Math.PI) / 180;
  return {
    x: ((at.lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * size,
  };
}

type Props = {
  /** Where the bike is (or was last heard from) */
  bike: LatLon;
  /** Where the phone is, when known */
  you?: LatLon | null;
  /** Where the bike was parked, shown when it has moved away from there */
  parked?: LatLon | null;
};

/**
 * A small street map showing where the bike is, with the owner and the parking spot when
 * they are known. It zooms to fit them. For finding a bike on foot, not for riding.
 */
export function BikeMap({ bike, you, parked }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const shown = [bike, you, parked].filter((p): p is LatLon => Boolean(p));

  // The closest zoom at which everything fits.
  let zoom = MAX_ZOOM;
  for (; zoom > MIN_ZOOM; zoom--) {
    const spots = shown.map((p) => onWorld(p, zoom));
    const wide = Math.max(...spots.map((s) => s.x)) - Math.min(...spots.map((s) => s.x));
    const tall = Math.max(...spots.map((s) => s.y)) - Math.min(...spots.map((s) => s.y));
    if (wide <= size.width - MARGIN * 2 && tall <= size.height - MARGIN * 2) break;
  }
  const spots = shown.map((p) => onWorld(p, zoom));
  const centre = {
    x: (Math.max(...spots.map((s) => s.x)) + Math.min(...spots.map((s) => s.x))) / 2,
    y: (Math.max(...spots.map((s) => s.y)) + Math.min(...spots.map((s) => s.y))) / 2,
  };
  const left = centre.x - size.width / 2;
  const top = centre.y - size.height / 2;
  const place = (at: LatLon) => {
    const p = onWorld(at, zoom);
    return { left: p.x - left, top: p.y - top };
  };

  const tiles: { key: string; uri: string; left: number; top: number }[] = [];
  if (size.width > 0) {
    const count = 2 ** zoom;
    for (let ty = Math.floor(top / TILE); ty * TILE < top + size.height; ty++) {
      for (let tx = Math.floor(left / TILE); tx * TILE < left + size.width; tx++) {
        if (ty < 0 || ty >= count) continue;
        const wrapped = ((tx % count) + count) % count;
        tiles.push({
          key: `${zoom}/${tx}/${ty}`,
          uri: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${ty}.png`,
          left: tx * TILE - left,
          top: ty * TILE - top,
        });
      }
    }
  }

  return (
    <View
      style={styles.map}
      onLayout={(e) => setSize(e.nativeEvent.layout)}
      accessibilityLabel="Map showing where the bike is">
      {tiles.map((tile) => (
        <Image
          key={tile.key}
          source={{ uri: tile.uri }}
          style={[styles.tile, { left: tile.left, top: tile.top }]}
        />
      ))}
      {size.width > 0 && (
        <>
          {parked && <View style={[styles.parked, place(parked)]} />}
          {you && <View style={[styles.you, place(you)]} />}
          <View style={[styles.bike, place(bike)]}>
            <SymbolView
              name={{ ios: 'bicycle', android: 'pedal_bike', web: 'pedal_bike' }}
              size={18}
              tintColor="#FFFFFF"
            />
          </View>
        </>
      )}
      <Text style={styles.credit}>© OpenStreetMap</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    height: 220,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#E8E7E2',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
  tile: { position: 'absolute', width: TILE, height: TILE },
  // Markers are centred on their spot with negative margins.
  bike: {
    position: 'absolute',
    width: 38,
    height: 38,
    marginLeft: -19,
    marginTop: -19,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  you: {
    position: 'absolute',
    width: 18,
    height: 18,
    marginLeft: -9,
    marginTop: -9,
    borderRadius: 9,
    backgroundColor: Status.accent,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  parked: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    marginTop: -8,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: '#6B7076',
    backgroundColor: '#FFFFFF',
  },
  credit: {
    position: 'absolute',
    right: 6,
    bottom: 4,
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.8)',
    color: '#4A4E55',
    fontFamily: Type.regular,
    fontSize: 9,
  },
});
