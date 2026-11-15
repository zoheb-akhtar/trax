import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Type } from '@/constants/theme';
import type { CameraView } from '@/device/types';
import { haptic } from '@/lib/haptics';

const LABEL: Record<CameraView, string> = { front: 'Front', security: 'Security', rear: 'Rear' };

/**
 * Shows which camera is on screen. The app picks the camera itself; tapping one
 * here holds that camera for a while, marked "HELD".
 */
export function CameraSwitch({
  cameras,
  value,
  automatic,
  onChange,
}: {
  cameras: CameraView[];
  value: CameraView;
  automatic: boolean;
  onChange(camera: CameraView): void;
}) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      <Text style={styles.mode}>{automatic ? 'AUTO' : 'HELD'}</Text>
      {cameras.map((camera) => {
        const selected = camera === value;
        return (
          <Pressable
            key={camera}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={8}
            onPress={() => {
              haptic.tap();
              onChange(camera);
            }}
            style={[styles.option, selected && styles.selected]}>
            <Text style={[styles.label, selected && styles.selectedLabel]}>{LABEL[camera]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  mode: {
    color: 'rgba(255,255,255,0.55)',
    fontFamily: Type.medium,
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 8,
  },
  option: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
  selected: { backgroundColor: '#fff' },
  label: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  selectedLabel: { color: '#000' },
});
