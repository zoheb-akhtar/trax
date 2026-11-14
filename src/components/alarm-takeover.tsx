import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useEffect } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { pictureUri } from '@/history/files';
import { haptic } from '@/lib/haptics';
import { useSecurity } from '@/security/security-provider';

/** Full-screen alert while the device's alarm is sounding, over every tab. */
export function AlarmTakeover() {
  const { state, silenceAlarm } = useDevice();
  const { entries } = useSecurity();
  const active = state.alarm;
  // What set the alarm off: the newest thing in the log that could have.
  const cause = entries.find(
    (e) => e.kind === 'tamper' || e.kind === 'motion' || e.kind === 'siren',
  );
  const fromPhone = cause?.kind === 'siren';
  const picture = fromPhone ? undefined : cause?.pictures[0];

  useEffect(() => {
    if (!active) return;
    haptic.alarm();
    const timer = setInterval(haptic.alarm, 1200);
    return () => clearInterval(timer);
  }, [active]);

  return (
    <Modal visible={active} animationType="fade" statusBarTranslucent onRequestClose={silenceAlarm}>
      <View style={styles.screen}>
        <SafeAreaView style={styles.content}>
          <View style={styles.centre}>
            <PulsingIcon />
            <Text style={styles.title}>{fromPhone ? 'Alarm sounding' : 'Bike moved'}</Text>
            <Text style={styles.body}>
              {fromPhone ? 'You set it off from this phone' : "Velo's alarm is sounding"}
              {cause
                ? ` · ${new Date(cause.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : ''}
            </Text>
            {picture && (
              <Animated.View entering={FadeIn.duration(250)} style={styles.picture}>
                <Image
                  source={{ uri: pictureUri(picture.file) }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
                <Text style={styles.tag}>
                  {picture.camera === 'rear' ? 'Rear camera' : 'Front camera'}
                </Text>
              </Animated.View>
            )}
          </View>
          <Button title="Silence alarm" variant="onDanger" size="large" onPress={silenceAlarm} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function PulsingIcon() {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    pulse.set(
      withRepeat(withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }), -1, false),
    );
  }, [pulse, reduceMotion]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 0.8 }],
  }));

  return (
    <View style={styles.iconWrap}>
      <Animated.View style={[styles.pulse, ringStyle]} />
      <View style={styles.icon}>
        <SymbolView
          name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
          size={44}
          tintColor={Status.danger}
        />
      </View>
    </View>
  );
}

const ICON = 96;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Status.danger },
  content: { flex: 1, padding: Spacing.four },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  iconWrap: {
    width: ICON,
    height: ICON,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.three,
  },
  pulse: {
    position: 'absolute',
    width: ICON,
    height: ICON,
    borderRadius: ICON / 2,
    backgroundColor: '#fff',
  },
  icon: {
    width: ICON,
    height: ICON,
    borderRadius: ICON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  title: {
    color: '#fff',
    fontFamily: Type.semibold,
    fontSize: 42,
    lineHeight: 48,
    letterSpacing: -1,
  },
  body: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Type.regular,
    fontSize: 15,
    textAlign: 'center',
  },
  picture: {
    width: '100%',
    aspectRatio: 4 / 3,
    marginTop: Spacing.three,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#fff',
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  tag: {
    position: 'absolute',
    top: 10,
    left: 10,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontFamily: Type.medium,
    fontSize: 11,
    letterSpacing: 0.8,
  },
});
