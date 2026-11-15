import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Hairline, Status } from '@/constants/theme';

type Point = [number, number]; // [lat, lon]

/** The path of a ride drawn to fit its box, with a red dot at each close pass. */
export function RouteMap({ track, pins }: { track: Point[]; pins: Point[] }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const pad = 22;

  const lats = track.map((p) => p[0]);
  const lons = track.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  // Longitude degrees are narrower than latitude degrees away from the equator.
  const squash = Math.cos((midLat * Math.PI) / 180);
  const west = Math.min(...lons) * squash;
  const east = Math.max(...lons) * squash;
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const scale = Math.min(
    (size.width - pad * 2) / Math.max(east - west, 1e-6),
    (size.height - pad * 2) / Math.max(north - south, 1e-6),
  );
  const place = ([lat, lon]: Point) => ({
    x: size.width / 2 + (lon * squash - (west + east) / 2) * scale,
    y: size.height / 2 - (lat - (south + north) / 2) * scale,
  });
  const start = place(track[0]);
  const end = place(track[track.length - 1]);

  return (
    <View style={styles.map} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      {size.width > 0 && (
        <Svg width={size.width} height={size.height}>
          <Polyline
            points={track.map((p) => `${place(p).x.toFixed(1)},${place(p).y.toFixed(1)}`).join(' ')}
            fill="none"
            stroke={Status.accent}
            strokeWidth={4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {pins.map((p, i) => (
            <Circle
              key={i}
              cx={place(p).x}
              cy={place(p).y}
              r={6}
              fill={Status.danger}
              stroke="#fff"
              strokeWidth={2}
            />
          ))}
          <Circle cx={start.x} cy={start.y} r={6} fill="#fff" stroke="#111111" strokeWidth={3} />
          <Circle cx={end.x} cy={end.y} r={7} fill="#111111" />
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
});
