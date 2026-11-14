import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { MjpegView } from '@/components/mjpeg-view';
import { Status, Type } from '@/constants/theme';
import { isCloseVehicle, isCyclist, isVehicle } from '@/device/geometry';
import type { Connection, Detection } from '@/device/types';

export function detectionColor(d: Detection) {
  if (isCloseVehicle(d)) return Status.danger;
  if (isVehicle(d)) return Status.warn;
  if (isCyclist(d)) return Status.cyclist;
  return Status.accent;
}

type Props = {
  streamUrl: string | null;
  connection: Connection;
  detections: Detection[];
};

/** Live camera picture with detection boxes drawn on top. Fills its parent. */
export function CameraFeed({ streamUrl, connection, detections }: Props) {
  const showVideo = streamUrl && connection === 'connected';

  return (
    <View style={styles.frame}>
      {showVideo ? <MjpegView uri={streamUrl} /> : <Placeholder connection={connection} />}

      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {detections.map((d) => {
          const color = detectionColor(d);
          const [x, y, w, h] = d.box;
          return (
            <View
              key={d.id}
              style={[
                styles.box,
                {
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  width: `${w * 100}%`,
                  height: `${h * 100}%`,
                  borderColor: color,
                },
              ]}>
              <Text style={[styles.boxLabel, { backgroundColor: color }]} numberOfLines={1}>
                {d.label === 'bicycle' ? 'cyclist' : d.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Placeholder({ connection }: { connection: Connection }) {
  if (connection === 'simulated') {
    // A plain dusk road so the simulated boxes have something to sit on.
    return (
      <View style={StyleSheet.absoluteFill}>
        <LinearGradient colors={['#0E1622', '#26364D']} style={styles.sky} />
        <LinearGradient colors={['#2B2F36', '#16181C']} style={styles.road} />
      </View>
    );
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]}>
      <Text style={styles.placeholderText}>
        {connection === 'connecting' ? 'Connecting to Velo…' : 'No signal from Velo'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: '#0B0D10' },
  sky: { flex: 46 },
  road: { flex: 54 },
  center: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: '#8B9099', fontFamily: Type.regular, fontSize: 14 },
  box: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: 6,
  },
  boxLabel: {
    position: 'absolute',
    top: -1.5,
    left: -1.5,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderTopLeftRadius: 6,
    borderBottomRightRadius: 6,
    color: '#fff',
    fontFamily: Type.semibold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    overflow: 'hidden',
  },
});
