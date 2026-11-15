import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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

import { describeAlarmPicture, oneLine } from '@/agent/agent';
import { makeClient } from '@/agent/client';
import { CALLOUT_PROMPT } from '@/agent/prompt';
import { laptopPushes } from '@/components/push-watcher';
import { TalkThroughBike } from '@/components/talk-through-bike';
import { Button } from '@/components/ui/button';
import { Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { pictureAsBase64, pictureUri } from '@/history/files';
import { haptic } from '@/lib/haptics';
import { notifyNow } from '@/lib/notify';
import { say } from '@/lib/voice';
import { useSecurity } from '@/security/security-provider';
import { useSettings } from '@/settings/settings-provider';

/** What the bike's speaker says to whoever is at the bike when the owner taps "Warn them". */
/**
 * Only an event this recent is texted about. When a new alarm starts, the screen can briefly
 * see an older one as the cause; that one was dealt with at the time.
 */
const ALERT_FRESH_MS = 2 * 60 * 1000;
/** Whether an event is recent enough to text about. Called from effects, at the moment they run. */
function isFresh(ts: number) {
  return Date.now() - ts < ALERT_FRESH_MS;
}

export const WARNING_LINE =
  'This bike is alarmed. You are being recorded, and the owner has been alerted. Please step away from the bike.';

/** Full-screen alert while the device's alarm is sounding, over every tab. */
export function AlarmTakeover() {
  const { state, silenceAlarm, sayOnBike, hasSpeaker } = useDevice();
  const { entries, describeEntry } = useSecurity();
  const { agentEnabled, agentUrl, agentToken } = useSettings();
  const active = state.alarm;
  // What set the alarm off: the newest thing in the log that could have.
  const cause = entries.find(
    (e) => e.kind === 'tamper' || e.kind === 'motion' || e.kind === 'siren',
  );
  const fromPhone = cause?.kind === 'siren';
  const picture = fromPhone ? undefined : cause?.pictures[0];

  // The AI agent looks at the picture once and says what it shows. If that fails or is slow,
  // the screen simply carries on without a description.
  const asked = useRef(new Set<string>());
  const [looking, setLooking] = useState(false);
  const [callout, setCallout] = useState<{ id: string; line: string } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** Says a line out loud at the bike, and shows what was said. */
  const sayAtBike = (line: string) => {
    haptic.commit();
    sayOnBike(line, true).then((sent) => setSaid(sent ? line : 'Couldn’t reach the bike.'));
  };
  const causeId = cause?.id;
  const pictureFile = picture?.file;
  const described = Boolean(cause?.description);

  // A notification the moment the bike is moved.
  const alerted = useRef(new Set<string>());
  const causeTs = cause?.ts ?? 0;
  const causePlace = cause?.place ?? null;
  useEffect(() => {
    if (!active || !causeId || fromPhone || alerted.current.has(causeId)) return;
    if (!isFresh(causeTs)) return;
    alerted.current.add(causeId);
    const time = new Date(causeTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const where = causePlace ? ` near ${causePlace}` : '';
    // A notification banner, unless the laptop is already pushing one for this.
    if (!laptopPushes()) {
      notifyNow('Velo: bike moved', `Your bike was moved at ${time}${where}. Its alarm is sounding.`, {
        kind: 'tamper',
      });
    }
  }, [active, causeId, fromPhone, causeTs, causePlace]);

  // Once the picture is saved, the AI says what it shows, and a second notification says it too.
  useEffect(() => {
    if (!active || !causeId || !pictureFile || fromPhone || asked.current.has(causeId)) return;
    const describing = agentEnabled && agentUrl.trim() !== '' && !described;
    if (!describing) return;
    asked.current.add(causeId);
    let current = true;
    (async () => {
      const data = await pictureAsBase64(pictureFile);
      if (!data) return;
      let seen: string | null = null;
      if (describing) {
        setLooking(true);
        try {
          seen = await describeAlarmPicture(makeClient(agentUrl, agentToken), data);
          if (seen) {
            describeEntry(causeId, seen); // kept with the entry, so it also shows in History
            if (current) say(seen, true);
            if (isFresh(causeTs)) notifyNow('Velo sees', seen, { kind: 'tamper' });
          }
        } catch {
          // No description this time; the alarm itself is unaffected.
        } finally {
          setLooking(false);
        }
      }
      // A warning addressed to the person in the picture, ready for the owner to send.
      if (seen && hasSpeaker) {
        try {
          const line = await oneLine(makeClient(agentUrl, agentToken), CALLOUT_PROMPT, seen);
          if (current && line && line.trim() !== 'NONE') setCallout({ id: causeId, line });
        } catch {
          // The set warning and hold-to-talk still work.
        }
      }
    })();
    return () => {
      current = false;
    };
    // describeEntry is recreated every render; the ids above are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, causeId, pictureFile, fromPhone, described, agentEnabled, agentUrl, agentToken, causeTs, hasSpeaker]);
  const tailored = callout && callout.id === causeId ? callout.line : null;

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
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.centre}
            showsVerticalScrollIndicator={false}>
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
            {!fromPhone && (cause?.description || looking) && (
              <View style={styles.seen}>
                <Text style={styles.seenLabel}>VELO SEES</Text>
                <Text style={styles.seenText}>
                  {cause?.description ?? 'Looking at the camera…'}
                </Text>
                {tailored && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Say through the bike: ${tailored}`}
                    onPress={() => sayAtBike(tailored)}
                    style={styles.tell}>
                    <Text style={styles.tellLabel}>TELL THEM</Text>
                    <Text style={styles.tellText}>“{tailored}”</Text>
                  </Pressable>
                )}
              </View>
            )}
          </ScrollView>
          {hasSpeaker && (
            <View style={styles.speakerRow}>
              <View style={styles.grow}>
                <Button title="Warn them" variant="onDanger" onPress={() => sayAtBike(WARNING_LINE)} />
              </View>
              <TalkThroughBike />
            </View>
          )}
          {said && (
            <Text style={styles.saidText} numberOfLines={2}>
              Said at the bike: “{said}”
            </Text>
          )}
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
          size={34}
          tintColor={Status.danger}
        />
      </View>
    </View>
  );
}

const ICON = 72;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Status.danger },
  content: { flex: 1, padding: Spacing.four },
  scroll: { flex: 1, marginBottom: Spacing.two },
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
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
  speakerRow: { flexDirection: 'row', gap: Spacing.two, marginBottom: Spacing.two },
  grow: { flex: 1 },
  saidText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Type.regular,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  tell: {
    marginTop: Spacing.two,
    padding: Spacing.two,
    gap: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  tellLabel: { color: Status.danger, fontFamily: Type.semibold, fontSize: 11, letterSpacing: 1.5 },
  tellText: { color: '#111111', fontFamily: Type.medium, fontSize: 15, lineHeight: 20 },
  seen: {
    alignSelf: 'stretch',
    marginTop: Spacing.three,
    padding: Spacing.three,
    gap: 6,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  seenLabel: { color: 'rgba(255,255,255,0.8)', fontFamily: Type.semibold, fontSize: 12, letterSpacing: 1.5 },
  seenText: { color: '#fff', fontFamily: Type.medium, fontSize: 19, lineHeight: 26 },
  body: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Type.regular,
    fontSize: 15,
    textAlign: 'center',
  },
  picture: {
    width: '100%',
    // Wider than the camera's 4:3, so the description and buttons fit without scrolling.
    aspectRatio: 16 / 9,
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
