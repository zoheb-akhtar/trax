import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAgent } from '@/agent/agent-provider';
import { Spacing, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { haptic } from '@/lib/haptics';
import { say } from '@/lib/voice';
import { useNav } from '@/nav/nav-provider';

/** The beats of the demo, in order. */
const LABELS = ['Route', 'Car behind', 'Arm', 'Bike moved', 'Recap'];

/**
 * One tap per beat of the live demo, so the presenter can keep talking: plan a route by
 * voice, ride with a car closing in, arm the bike, someone moves it, then catch up.
 * Shown only with the built-in pretend bike or the laptop test server, never a real Velo.
 * Tap to run the next beat; press and hold to start again.
 */
export function DemoDirector({ riding }: { riding: boolean }) {
  const agent = useAgent();
  const { nav } = useNav();
  const device = useDevice();
  const [next, setNext] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const later = (ms: number, action: () => void) => {
    timers.current.push(setTimeout(action, ms));
  };

  // Built when a beat runs, never during render: the beats read refs and set timers.
  const runStep = (index: number) => {
    const steps: (() => void)[] = [
      () => {
        // The rider is at the bike and about to set off, so it is no longer guarding: starting
        // from ride mode means the agent can start guidance without asking to disarm first.
        device.setMode('ride');
        later(600, () => agent.ask('Take me to the Boston Public Library.'));
      },
      () => {
        // Preview rides the planned route by itself, so the bike moves on screen indoors.
        if (nav.getSnapshot().route) nav.start(true);
        later(1500, () => device.simulateCar?.());
        // A pothole on the way, which shows on the ride map afterwards.
        later(4500, () => device.simulatePothole?.());
        later(7500, () => agent.ask('Anything behind me?'));
      },
      () => {
        nav.stop();
        device.setMode('security');
        say('Velo is armed. I’ll watch the bike.', true);
      },
      () => device.simulateTamper?.(),
      () => {
        device.silenceAlarm();
        later(800, () => agent.ask('What happened while I was away?'));
      },
    ];
    steps[index]();
  };

  if (device.settings.source !== 'simulated' && !device.testRoutes) return null;

  const done = next >= LABELS.length;
  const run = () => {
    haptic.tap();
    if (done) {
      setNext(0);
      return;
    }
    runStep(next);
    setNext(next + 1);
  };
  const restart = () => {
    haptic.commit();
    timers.current.forEach(clearTimeout);
    timers.current = [];
    nav.clear();
    device.silenceAlarm();
    setNext(0);
  };

  return (
    <View style={[styles.wrap, riding ? styles.left : styles.besideName]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={done ? 'Demo finished. Tap to start again' : `Demo: ${LABELS[next]}`}
        accessibilityHint="Press and hold to start the demo again"
        onPress={run}
        onLongPress={restart}
        hitSlop={8}
        style={styles.pill}>
        <Text style={styles.count}>{done ? 'Demo ↺' : `Demo ${next + 1}/${LABELS.length}`}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {done ? 'Again' : LABELS[next]}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', height: 52, justifyContent: 'center' },
  left: { left: Spacing.three },
  // On the parked home screen, next to the "Velo" wordmark.
  besideName: { left: 104 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: 'rgba(17,17,17,0.08)',
  },
  count: { fontFamily: Type.semibold, fontSize: 12, color: '#6B7076' },
  label: { fontFamily: Type.semibold, fontSize: 13, color: '#111111' },
});
