import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Hairline, Status, Type } from '@/constants/theme';
import { formatDistance } from '@/nav/geo';
import { SIGNAL_DISTANCE_M } from '@/nav/nav-store';
import type { Progress, TurnDirection } from '@/nav/types';

const ICON: Record<TurnDirection, SymbolViewProps['name']> = {
  depart: { ios: 'arrow.up', android: 'straight', web: 'straight' },
  straight: { ios: 'arrow.up', android: 'straight', web: 'straight' },
  'slight-left': { ios: 'arrow.up.left', android: 'turn_slight_left', web: 'turn_slight_left' },
  left: { ios: 'arrow.turn.up.left', android: 'turn_left', web: 'turn_left' },
  'sharp-left': { ios: 'arrow.turn.up.left', android: 'turn_sharp_left', web: 'turn_sharp_left' },
  'slight-right': { ios: 'arrow.up.right', android: 'turn_slight_right', web: 'turn_slight_right' },
  right: { ios: 'arrow.turn.up.right', android: 'turn_right', web: 'turn_right' },
  'sharp-right': { ios: 'arrow.turn.up.right', android: 'turn_sharp_right', web: 'turn_sharp_right' },
  uturn: { ios: 'arrow.uturn.left', android: 'u_turn_left', web: 'u_turn_left' },
  roundabout: {
    ios: 'arrow.triangle.2.circlepath',
    android: 'roundabout_left',
    web: 'roundabout_left',
  },
  arrive: { ios: 'flag.checkered', android: 'flag', web: 'flag' },
};

const LABEL: Record<TurnDirection, string> = {
  depart: 'Set off',
  straight: 'Continue',
  'slight-left': 'Keep left',
  left: 'Turn left',
  'sharp-left': 'Sharp left',
  'slight-right': 'Keep right',
  right: 'Turn right',
  'sharp-right': 'Sharp right',
  uturn: 'Turn around',
  roundabout: 'Roundabout',
  arrive: 'Arrive',
};

const isTurn = (d: TurnDirection) => d.includes('left') || d.includes('right') || d === 'uturn';

/**
 * The next turn: an arrow, how far away it is, and the street. As a left or
 * right turn gets close the arrow turns amber and flashes like an indicator.
 */
export function TurnBanner({ progress, compact }: { progress: Progress; compact?: boolean }) {
  const next = progress.next;
  const direction: TurnDirection = progress.arrived
    ? 'arrive'
    : progress.offRoute
      ? 'uturn'
      : (next?.direction ?? 'straight');
  const signalling =
    !progress.arrived &&
    !progress.offRoute &&
    isTurn(direction) &&
    progress.distanceToNext <= SIGNAL_DISTANCE_M;

  const size = compact ? 44 : 60;
  const title = progress.arrived
    ? 'You have arrived'
    : progress.offRoute
      ? 'Off route'
      : formatDistance(progress.distanceToNext);
  const detail = progress.arrived
    ? 'Destination reached'
    : progress.offRoute
      ? progress.rerouting
        ? 'Finding a new route'
        : `${formatDistance(progress.offBy)} from the route`
      : (next?.street ?? LABEL[direction]);

  return (
    <View style={[styles.banner, compact && styles.compact]}>
      <SignalBox size={size} signalling={signalling}>
        <SymbolView
          name={ICON[direction]}
          size={size * 0.52}
          weight="semibold"
          tintColor="#111111"
        />
      </SignalBox>
      <View style={styles.text}>
        <Text style={compact ? styles.titleCompact : styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {progress.arrived || progress.offRoute || !next?.street
            ? detail
            : `${LABEL[direction]} · ${detail}`}
        </Text>
      </View>
      {!compact && progress.then && !progress.arrived && !progress.offRoute && (
        <View style={styles.then}>
          <Text style={styles.thenLabel}>THEN</Text>
          <SymbolView name={ICON[progress.then.direction]} size={18} tintColor="#6B7076" />
        </View>
      )}
    </View>
  );
}

function SignalBox({
  size,
  signalling,
  children,
}: {
  size: number;
  signalling: boolean;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (signalling && !reduceMotion) {
      // On, off, on, off: a turn indicator, so it is stepped, not eased.
      pulse.set(withRepeat(withTiming(0.25, { duration: 380 }), -1, true));
    } else {
      cancelAnimation(pulse);
      pulse.set(withTiming(1, { duration: 150 }));
    }
  }, [signalling, reduceMotion, pulse]);

  const flash = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View
      style={[styles.box, { width: size, height: size, borderRadius: size * 0.28 }]}
      accessibilityLabel={signalling ? 'Turn coming up' : undefined}>
      {signalling && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: Status.warn, borderRadius: size * 0.28 }, flash]}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    backgroundColor: 'rgba(255,255,255,0.96)',
  },
  compact: { padding: 8, borderRadius: 16, gap: 12 },
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8E7E2',
    overflow: 'hidden',
  },
  text: { flex: 1 },
  title: { color: '#111111', fontFamily: Type.light, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  titleCompact: { color: '#111111', fontFamily: Type.regular, fontSize: 22, lineHeight: 26, letterSpacing: -0.4 },
  detail: { color: '#6B7076', fontFamily: Type.regular, fontSize: 13, lineHeight: 18 },
  then: { alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  thenLabel: { color: '#6B7076', fontFamily: Type.medium, fontSize: 9, letterSpacing: 1.4 },
});
