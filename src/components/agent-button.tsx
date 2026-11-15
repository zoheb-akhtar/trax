import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { useAgent } from '@/agent/agent-provider';
import { Status } from '@/constants/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SPRING = { damping: 30, stiffness: 450 };

/**
 * Tap and talk to Velo's AI agent. Tap again to finish early. It never opens the written
 * conversation; that is reached by tapping the caption card. Hidden when the agent is off.
 */
export function AgentButton() {
  const { enabled, talk, listening, choosing, thinking } = useAgent();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  if (!enabled) return null;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop listening' : 'Talk to Velo'}
      hitSlop={8}
      onPressIn={() => {
        scale.set(withSpring(0.92, SPRING));
      }}
      onPressOut={() => {
        scale.set(withSpring(1, SPRING));
      }}
      // A long press counts as a tap too: a gloved or slow press must never do something else.
      onPress={talk}
      onLongPress={talk}
      style={[styles.button, (listening || choosing) && styles.listening, style]}>
      {thinking ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <SymbolView
          name={
            listening
              ? { ios: 'waveform', android: 'graphic_eq', web: 'graphic_eq' }
              : choosing
                ? { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }
                : { ios: 'mic.fill', android: 'mic', web: 'mic' }
          }
          size={22}
          tintColor="#ffffff"
        />
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  // Blue with a soft glow while Velo is listening or waiting for a question
  listening: {
    backgroundColor: Status.accent,
    shadowColor: Status.accent,
    shadowOpacity: 0.75,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  button: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
