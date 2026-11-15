import { SymbolView } from 'expo-symbols';
import { useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAgent, type TranscriptLine } from '@/agent/agent-provider';
import { Button } from '@/components/ui/button';
import { Hairline, Spacing, Status, Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';

const WHILE_RIDING = ['Anything behind me?', 'Take me to Boston Public Library', 'Show the rear camera'];
const WHILE_PARKED = ['What happened while I was away?', 'What can the rear camera see?', 'How safe were my rides this week?'];

/** The conversation with Velo's AI agent: what was asked, what it did, and what it said. */
export function AgentSheet() {
  const { open, setOpen, thinking, transcript, confirming, answer, ask, reset } = useAgent();
  const { state } = useDevice();
  const [draft, setDraft] = useState('');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const suggestions = state.mode === 'ride' ? WHILE_RIDING : WHILE_PARKED;

  const send = (text: string) => {
    ask(text);
    setDraft('');
  };

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}>
          <View style={styles.header}>
            <View style={styles.badge}>
              <SymbolView
                name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
                size={16}
                tintColor="#ffffff"
              />
            </View>
            <Text style={styles.title}>Ask Velo</Text>
            {transcript.length > 0 && (
              <Button title="Clear" size="small" variant="secondary" onPress={reset} />
            )}
            <Button title="Done" size="small" onPress={() => setOpen(false)} />
          </View>

          <ScrollView
            ref={scroll}
            style={styles.fill}
            contentContainerStyle={styles.lines}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
            {transcript.length === 0 && (
              <View style={styles.intro}>
                <Text style={styles.introTitle}>Velo can see what the bike sees and run the app for you.</Text>
                <Text style={styles.introBody}>
                  It asks before disarming or sounding the alarm, and only looks through a camera
                  when you ask it to or when the alarm goes off.
                </Text>
                {suggestions.map((text) => (
                  <Pressable
                    key={text}
                    accessibilityRole="button"
                    style={styles.suggestion}
                    onPress={() => send(text)}>
                    <Text style={styles.suggestionText}>{text}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {transcript.map((line) => (
              <Line key={line.id} line={line} />
            ))}
            {thinking && !confirming && (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" color="#6B7076" />
                <Text style={styles.did}>Thinking</Text>
              </View>
            )}
          </ScrollView>

          {confirming ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmText}>{confirming}</Text>
              <View style={styles.confirmButtons}>
                <View style={styles.fill}>
                  <Button title="No" variant="secondary" onPress={() => answer(false)} />
                </View>
                <View style={styles.fill}>
                  <Button title="Yes" onPress={() => answer(true)} />
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.composer}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Ask or tell Velo something"
                placeholderTextColor="#9A9EA4"
                style={styles.input}
                returnKeyType="send"
                editable={!thinking}
                // Take the text from the field itself: it can be ahead of `draft` while typing fast.
                onSubmitEditing={(event) => send(event.nativeEvent.text)}
              />
              <Button title="Send" disabled={thinking || !draft.trim()} onPress={() => send(draft)} />
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Line({ line }: { line: TranscriptLine }) {
  if (line.kind === 'did') {
    return (
      <View style={styles.didRow}>
        <SymbolView
          name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
          size={14}
          tintColor={Status.ok}
        />
        <Text style={styles.did}>{line.text}</Text>
      </View>
    );
  }
  if (line.kind === 'you') {
    return (
      <View style={[styles.bubble, styles.you]}>
        <Text style={[styles.text, styles.youText]}>{line.text}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.bubble, styles.velo, line.kind === 'problem' && styles.problem]}>
      <Text style={styles.text}>{line.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F2F1ED' },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Hairline,
  },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
  },
  title: { flex: 1, fontFamily: Type.semibold, fontSize: 18, color: '#111111' },
  lines: { padding: Spacing.three, gap: Spacing.two },
  intro: { gap: Spacing.two, paddingVertical: Spacing.three },
  introTitle: { fontFamily: Type.semibold, fontSize: 22, lineHeight: 28, color: '#111111' },
  introBody: { fontFamily: Type.regular, fontSize: 15, lineHeight: 21, color: '#6B7076', marginBottom: Spacing.two },
  suggestion: {
    paddingVertical: 14,
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
  suggestionText: { fontFamily: Type.medium, fontSize: 15, color: '#111111' },
  bubble: { maxWidth: '86%', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18 },
  you: { alignSelf: 'flex-end', backgroundColor: '#111111' },
  velo: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
  problem: { backgroundColor: '#FDECEC', borderColor: 'rgba(229,72,77,0.3)' },
  text: { fontFamily: Type.regular, fontSize: 16, lineHeight: 22, color: '#111111' },
  youText: { color: '#FFFFFF' },
  didRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  did: { fontFamily: Type.medium, fontSize: 13, color: '#6B7076' },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingHorizontal: 4 },
  confirm: {
    margin: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.three,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
  },
  confirmText: { fontFamily: Type.semibold, fontSize: 18, color: '#111111' },
  confirmButtons: { flexDirection: 'row', gap: Spacing.two },
  composer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, padding: Spacing.three },
  input: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Hairline,
    fontFamily: Type.regular,
    fontSize: 16,
    color: '#111111',
  },
});
