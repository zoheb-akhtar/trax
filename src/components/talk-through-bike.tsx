import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Type } from '@/constants/theme';
import { useDevice } from '@/device/device-provider';
import { haptic } from '@/lib/haptics';

/** A recording is cut off at this length, so a stuck finger doesn't send a minute of audio. */
const LONGEST_MS = 15000;

type Phase = 'idle' | 'talking' | 'sending' | 'sent' | 'failed';

/**
 * Press and hold to speak through the bike's speaker, like a video doorbell: what the owner
 * says into the phone is played out loud at the bike.
 */
export function TalkThroughBike() {
  const { playOnBike } = useDevice();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>('idle');
  const run = useRef({ recording: false, cap: null as ReturnType<typeof setTimeout> | null });

  const finish = async () => {
    const state = run.current;
    if (!state.recording) return;
    state.recording = false;
    if (state.cap) clearTimeout(state.cap);
    setPhase('sending');
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = recorder.uri;
      const sent = uri ? await playOnBike(await new File(uri).bytes()) : false;
      setPhase(sent ? 'sent' : 'failed');
    } catch {
      setPhase('failed');
    }
  };

  const start = async () => {
    if (run.current.recording) return;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) return setPhase('failed');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      run.current.recording = true;
      run.current.cap = setTimeout(finish, LONGEST_MS);
      haptic.tap();
      setPhase('talking');
    } catch {
      setPhase('failed');
    }
  };

  const label = {
    idle: 'Hold to talk',
    talking: 'Talking… let go to send',
    sending: 'Sending…',
    sent: 'Played on the bike',
    failed: 'Couldn’t reach the bike',
  }[phase];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Hold to talk through the bike's speaker"
      onPressIn={start}
      onPressOut={finish}
      style={[styles.button, phase === 'talking' && styles.talking]}>
      <SymbolView
        name={{ ios: 'mic.fill', android: 'mic', web: 'mic' }}
        size={18}
        tintColor={phase === 'talking' ? '#E5484D' : '#FFFFFF'}
      />
      <Text style={[styles.text, phase === 'talking' && styles.talkingText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  talking: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  text: { color: '#FFFFFF', fontFamily: Type.semibold, fontSize: 15 },
  talkingText: { color: '#E5484D' },
});
