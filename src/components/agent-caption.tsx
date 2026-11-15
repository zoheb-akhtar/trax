import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAgent } from '@/agent/agent-provider';
import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';

const WHILE_RIDING = ['Anything behind me?', 'Take me to the nearest library', 'Show the rear camera'];
const WHILE_PARKED = ['What happened while I was away?', 'What can the rear camera see?', 'How safe were my rides this week?'];

/**
 * What the AI agent heard, did and said, as a small card over the top of whatever screen
 * is showing. It appears when the owner talks to Trax and leaves by itself afterwards,
 * so talking to Trax never takes over the screen. During a ride it shrinks to a small
 * "Listening" marker and the answer is only spoken, so the map stays clear.
 */
export function AgentCaption() {
  const insets = useSafeAreaInsets();
  const {
    active,
    open,
    listening,
    transcribing,
    choosing,
    heard,
    thinking,
    confirming,
    answer,
    ask,
    current,
    dismiss,
    setOpen,
  } = useAgent();
  const { state } = useDevice();
  if (!active || open) return null;

  const question = current.find((line) => line.kind === 'you')?.text;
  const reply = current.findLast((line) => line.kind === 'trax' || line.kind === 'problem');
  const done = current.filter((line) => line.kind === 'did');

  // While riding, nothing may cover the map: just a small "Listening" marker, and the answer
  // is spoken. The card only appears for something that needs a tap.
  const needsTap = Boolean(confirming) || (choosing && !question);
  if (state.mode === 'ride' && !needsTap) {
    if (!listening && !thinking) return null;
    return (
      <Animated.View
        entering={FadeInUp.duration(150)}
        exiting={FadeOutUp.duration(150)}
        pointerEvents="none"
        style={[styles.pill, { top: insets.top + 68 }]}>
        {thinking ? (
          <ActivityIndicator size="small" color="#6B7076" />
        ) : (
          <SymbolView
            name={{ ios: 'waveform', android: 'graphic_eq', web: 'graphic_eq' }}
            size={16}
            tintColor={Status.accent}
          />
        )}
        <Text style={styles.pillText}>
          {thinking ? 'Thinking' : transcribing ? 'Got it' : 'Listening'}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeInUp.duration(180)}
      exiting={FadeOutUp.duration(200)}
      style={[styles.card, { top: insets.top + 68 }]}>
      {choosing && !question && (
        <View style={styles.choices}>
          <Text style={styles.question}>Tap a question</Text>
          {(state.mode === 'ride' ? WHILE_RIDING : WHILE_PARKED).map((text) => (
            <Pressable
              key={text}
              accessibilityRole="button"
              style={styles.choice}
              onPress={() => ask(text)}>
              <Text style={styles.choiceText}>{text}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the conversation with Trax"
        onPress={() => setOpen(true)}>
        {listening ? (
          <View style={styles.row}>
            <SymbolView
              name={{ ios: 'waveform', android: 'graphic_eq', web: 'graphic_eq' }}
              size={18}
              tintColor={Status.accent}
            />
            <Text style={[styles.heard, !heard && styles.hint]} numberOfLines={3}>
              {heard || (transcribing ? 'Got it…' : 'Listening…')}
            </Text>
          </View>
        ) : (
          question && (
            <Text style={styles.question} numberOfLines={2}>
              {question}
            </Text>
          )
        )}

        {done.map((line) => (
          <View key={line.id} style={styles.row}>
            <SymbolView
              name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
              size={14}
              tintColor={Status.ok}
            />
            <Text style={styles.did}>{line.text}</Text>
          </View>
        ))}

        {thinking && !confirming && (
          <View style={styles.row}>
            <ActivityIndicator size="small" color="#6B7076" />
            <Text style={styles.did}>Thinking</Text>
          </View>
        )}

        {reply && !thinking && (
          <Text style={[styles.reply, reply.kind === 'problem' && styles.problem]}>{reply.text}</Text>
        )}
      </Pressable>

      {confirming && (
        <View style={styles.confirm}>
          <Text style={styles.reply}>{confirming}</Text>
          <View style={styles.buttons}>
            <View style={styles.fill}>
              <Button title="No" variant="secondary" size="large" onPress={() => answer(false)} />
            </View>
            <View style={styles.fill}>
              <Button title="Yes" size="large" onPress={() => answer(true)} />
            </View>
          </View>
        </View>
      )}

      {!confirming && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={12}
          style={styles.close}
          onPress={dismiss}>
          <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={12} tintColor="#8A8E94" />
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    padding: Spacing.three,
    paddingRight: Spacing.five,
    gap: Spacing.two,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginTop: 4 },
  fill: { flex: 1 },
  heard: { flex: 1, fontFamily: Type.medium, fontSize: 18, lineHeight: 24, color: '#111111' },
  hint: { color: '#8A8E94' },
  question: { fontFamily: Type.medium, fontSize: 14, color: '#6B7076' },
  did: { fontFamily: Type.medium, fontSize: 13, color: '#6B7076' },
  reply: { fontFamily: Type.medium, fontSize: 18, lineHeight: 25, color: '#111111', marginTop: 6 },
  problem: { color: Status.danger },
  confirm: { gap: Spacing.two },
  buttons: { flexDirection: 'row', gap: Spacing.two, marginTop: 4 },
  close: { position: 'absolute', top: 14, right: 14 },
  pill: {
    position: 'absolute',
    right: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pillText: { fontFamily: Type.medium, fontSize: 14, color: '#111111' },
  choices: { gap: Spacing.two },
  choice: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
    backgroundColor: '#F2F1ED',
  },
  choiceText: { fontFamily: Type.medium, fontSize: 17, color: '#111111' },
});
