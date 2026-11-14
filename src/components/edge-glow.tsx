import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';

const RED = 'rgba(229,72,77,0.6)';
const CLEAR = 'rgba(229,72,77,0)';

/** Red glow down one edge of the screen, on the side a close vehicle is on. */
export function EdgeGlow({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  const style = useAnimatedStyle(() => ({
    opacity: withTiming(active ? 1 : 0, { duration: active ? 120 : 400 }),
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.edge, { [side]: 0 }, style]}>
      <LinearGradient
        colors={side === 'left' ? [RED, CLEAR] : [CLEAR, RED]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', top: 0, bottom: 0, width: 56 },
});
