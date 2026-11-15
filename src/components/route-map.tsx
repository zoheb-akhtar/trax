import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Hairline, Status, Type } from '@/constants/theme';
import { MAP_REQUEST_HEADERS } from '@/nav/api';

type Point = [number, number]; // [lat, lon]

/** Map tiles are drawn at half their pixel size so they stay sharp on a phone screen. */
const TILE = 128;
const MAX_ZOOM = 18;
const MIN_ZOOM = 11;
/** Room kept around the route, in points. */
const PAD = 26;

/** A position on the whole-world map at a zoom level, in points. */
function onWorld([lat, lon]: Point, zoom: number) {
  const size = TILE * 2 ** zoom;
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * size,
  };
}

/**
 * The path of a ride on a street map, zoomed to fit, with a red dot at each close pass.
 * The map loads from OpenStreetMap; without a connection the route still draws on its own.
 */
export function RouteMap({ track, pins }: { track: Point[]; pins: Point[] }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ready = size.width > 0 && track.length > 0;

  // The closest zoom at which the whole route fits.
  let zoom = MAX_ZOOM;
  if (ready) {
    for (; zoom > MIN_ZOOM; zoom--) {
      const spots = track.map((p) => onWorld(p, zoom));
      const wide = Math.max(...spots.map((s) => s.x)) - Math.min(...spots.map((s) => s.x));
      const tall = Math.max(...spots.map((s) => s.y)) - Math.min(...spots.map((s) => s.y));
      if (wide <= size.width - PAD * 2 && tall <= size.height - PAD * 2) break;
    }
  }
  const spots = ready ? track.map((p) => onWorld(p, zoom)) : [];
  const centre = ready
    ? {
        x: (Math.max(...spots.map((s) => s.x)) + Math.min(...spots.map((s) => s.x))) / 2,
        y: (Math.max(...spots.map((s) => s.y)) + Math.min(...spots.map((s) => s.y))) / 2,
      }
    : { x: 0, y: 0 };
  const left = centre.x - size.width / 2;
  const top = centre.y - size.height / 2;
  const place = (p: Point) => {
    const w = onWorld(p, zoom);
    return { x: w.x - left, y: w.y - top };
  };

  const tiles: { key: string; uri: string; left: number; top: number }[] = [];
  if (ready) {
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

  const start = ready ? place(track[0]) : null;
  const end = ready ? place(track[track.length - 1]) : null;
  const line = ready ? track.map((p) => `${place(p).x.toFixed(1)},${place(p).y.toFixed(1)}`).join(' ') : '';

  return (
    <View
      style={styles.map}
      onLayout={(e) => setSize(e.nativeEvent.layout)}
      accessibilityLabel="Map of the route ridden">
      {tiles.map((tile) => (
        <Image
          key={tile.key}
          // The map tile service asks every app to identify itself.
          source={{ uri: tile.uri, headers: MAP_REQUEST_HEADERS }}
          cachePolicy="disk"
          style={[styles.tile, { left: tile.left, top: tile.top }]}
        />
      ))}
      {ready && start && end && (
        <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
          {/* A white casing under the line keeps it readable over busy streets. */}
          <Polyline points={line} fill="none" stroke="#FFFFFF" strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" />
          <Polyline points={line} fill="none" stroke={Status.accent} strokeWidth={4.5} strokeLinejoin="round" strokeLinecap="round" />
          {pins.map((p, i) => (
            <Circle key={i} cx={place(p).x} cy={place(p).y} r={7} fill={Status.danger} stroke="#fff" strokeWidth={2.5} />
          ))}
          <Circle cx={start.x} cy={start.y} r={7} fill="#fff" stroke="#111111" strokeWidth={3} />
          <Circle cx={end.x} cy={end.y} r={8} fill="#111111" stroke="#fff" strokeWidth={2.5} />
        </Svg>
      )}
      <Text style={styles.credit}>© OpenStreetMap</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    width: '100%',
    aspectRatio: 16 / 11,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#E8E7E2',
    overflow: 'hidden',
  },
  tile: { position: 'absolute', width: TILE, height: TILE },
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
