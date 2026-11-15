import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { haptic } from '@/lib/haptics';
import { say } from '@/lib/voice';
import { useNav } from '@/nav/nav-provider';
import { useSettings } from '@/settings/settings-provider';

const COUNTDOWN_S = 10;

/**
 * When Velo reports a fall, counts down and then opens a message to the rider's
 * emergency contact with their location. The rider can cancel with "I'm OK".
 * The message is prepared, not sent: the phone still asks the rider to send it.
 */
export function CrashTakeover() {
  const { state, connection } = useDevice();
  const { position, nav } = useNav();
  const { contactName, contactPhone } = useSettings();
  // Crashes already dealt with, including any that happened before the app connected.
  const known = useRef<Set<string> | null>(null);
  const messaged = useRef<string | null>(null);
  const [current, setCurrent] = useState<{ id: string; seenAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const online = connection === 'connected' || connection === 'simulated';
  const crashIds = state.events.filter((e) => e.kind === 'crash').map((e) => e.id);
  const crashKey = crashIds.join(',');
  useEffect(() => {
    if (!online) return;
    if (known.current === null) {
      known.current = new Set(crashIds);
      return;
    }
    const fresh = crashIds.find((id) => !known.current!.has(id));
    if (!fresh) return;
    known.current.add(fresh);
    say('Crash detected. Tap I am OK to cancel.', true);
    nav.locate();
    // The countdown runs on the phone's clock from when it heard about the crash.
    const timer = setTimeout(() => {
      setNow(Date.now());
      setCurrent({ id: fresh, seenAt: Date.now() });
    }, 0);
    return () => clearTimeout(timer);
    // crashKey stands in for the list of ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, crashKey]);

  const active = current !== null;
  const left = current ? Math.max(COUNTDOWN_S - Math.floor((now - current.seenAt) / 1000), 0) : 0;
  const done = active && left === 0;

  useEffect(() => {
    if (!active || done) return;
    const timer = setInterval(() => {
      haptic.alarm();
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [active, done]);

  // At zero, open a message to the contact. The rider still has to press send.
  const currentId = current?.id;
  useEffect(() => {
    if (!done || !currentId || messaged.current === currentId || !contactPhone) return;
    messaged.current = currentId;
    const where = position
      ? ` My location: https://maps.apple.com/?ll=${position.lat.toFixed(5)},${position.lon.toFixed(5)}`
      : '';
    const body = encodeURIComponent(`I may have crashed while cycling.${where} (sent with Velo)`);
    Linking.openURL(`sms:${contactPhone}${Platform.OS === 'ios' ? '&' : '?'}body=${body}`).catch(
      () => {},
    );
  }, [done, currentId, contactPhone, position]);

  const dismiss = () => setCurrent(null);

  const who = contactName || contactPhone || 'your emergency contact';

  return (
    <Modal visible={active} animationType="fade" statusBarTranslucent onRequestClose={dismiss}>
      <View style={styles.screen}>
        <SafeAreaView style={styles.content}>
          <View style={styles.centre}>
            <SymbolView
              name={{ ios: 'figure.fall', android: 'personal_injury', web: 'personal_injury' }}
              size={64}
              tintColor="#111111"
            />
            <Text style={styles.title}>{done ? 'Are you OK?' : 'Crash detected'}</Text>
            {!done && <Text style={styles.count}>{left}</Text>}
            <Text style={styles.body}>
              {done
                ? contactPhone
                  ? `A message to ${who} with your location is ready to send.`
                  : 'No emergency contact is set. Add one in the Device tab.'
                : contactPhone
                  ? `Messaging ${who} with your location when this reaches zero.`
                  : 'Add an emergency contact in the Device tab to alert someone automatically.'}
            </Text>
          </View>
          <Button title="I'm OK" size="large" onPress={dismiss} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Status.warn },
  content: { flex: 1, padding: Spacing.four },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  title: {
    color: '#111111',
    fontFamily: Type.semibold,
    fontSize: 38,
    lineHeight: 44,
    letterSpacing: -1,
  },
  count: {
    color: '#111111',
    fontFamily: Type.light,
    fontSize: 120,
    lineHeight: 128,
    fontVariant: ['tabular-nums'],
  },
  body: {
    color: '#111111',
    fontFamily: Type.regular,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
});
