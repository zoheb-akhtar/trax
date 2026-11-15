import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Status } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESS_SPRING = { damping: 30, stiffness: 450 };
const STATE_SPRING = { damping: 26, stiffness: 220 };

/** The big round shield: tap to arm or disarm. */
export function ArmControl({ armed, onToggle }: { armed: boolean; onToggle(): void }) {
  const pressed = useSharedValue(1);
  const progress = useDerivedValue(() => withSpring(armed ? 1 : 0, STATE_SPRING));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressed.value }],
    borderColor: interpolateColor(progress.value, [0, 1], ['#D6D5CF', Status.ok]),
    backgroundColor: interpolateColor(progress.value, [0, 1], ['#FFFFFF', '#E2F4E9']),
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.35,
    transform: [{ scale: 0.9 + progress.value * 0.25 }],
  }));

  return (
    <AnimatedPressable
      accessibilityRole="switch"
      accessibilityState={{ checked: armed }}
      accessibilityLabel={armed ? 'Disarm Trax' : 'Arm Trax'}
      onPressIn={() => {
        pressed.set(withSpring(0.94, PRESS_SPRING));
      }}
      onPressOut={() => {
        pressed.set(withSpring(1, PRESS_SPRING));
      }}
      onPress={() => {
        haptic.commit();
        onToggle();
      }}
      style={styles.hit}>
      <Animated.View style={[styles.halo, haloStyle]} />
      <Animated.View style={[styles.ring, ringStyle]}>
        <SymbolView
          name={
            armed
              ? { ios: 'lock.shield.fill', android: 'shield_lock', web: 'shield_lock' }
              : { ios: 'lock.open.fill', android: 'lock_open', web: 'lock_open' }
          }
          size={64}
          tintColor={armed ? Status.ok : '#8A8E94'}
        />
      </Animated.View>
    </AnimatedPressable>
  );
}

const SIZE = 176;

const styles = StyleSheet.create({
  hit: { width: SIZE + 48, height: SIZE + 48, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: Status.ok,
  },
  ring: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
