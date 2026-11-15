import { requireOptionalNativeModule } from 'expo';

/**
 * Listening to the owner's voice, with on-device speech recognition.
 *
 * The recogniser is native code that is only present in Trax's own build of the app.
 * In Expo Go it is missing, so everything here reports "unavailable" instead of crashing,
 * and the agent falls back to typed questions.
 */
type SpeechModule = (typeof import('expo-speech-recognition'))['ExpoSpeechRecognitionModule'];

let cached: SpeechModule | null | undefined;

function recogniser(): SpeechModule | null {
  if (cached === undefined) {
    cached = null;
    // Only load the package where its native part exists; loading it elsewhere throws.
    if (requireOptionalNativeModule('ExpoSpeechRecognition')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cached = require('expo-speech-recognition').ExpoSpeechRecognitionModule as SpeechModule;
      } catch {
        cached = null;
      }
    }
  }
  return cached;
}

export function canListen() {
  try {
    return recogniser()?.isRecognitionAvailable() ?? false;
  } catch {
    return false;
  }
}

export type ListenResult =
  | { ok: true; text: string }
  /** denied: no microphone or speech permission. nothing: no words were heard. */
  | { ok: false; reason: 'denied' | 'nothing' | 'cancelled' | 'failed' };

export type Listening = {
  /** Stop listening and use what has been heard so far. */
  finish(): void;
  /** Stop listening and throw away what was heard. */
  cancel(): void;
  result: Promise<ListenResult>;
};

/** Words the recogniser should expect, so it hears "Trax" rather than "tracks". */
const VOCABULARY = ['Trax', 'arm the bike', 'disarm', 'rear camera', 'front camera', 'close pass'];

/** Listens for one spoken question. `onHeard` gets the words as they are recognised. */
export function listen(onHeard: (text: string) => void): Listening {
  const speech = recogniser();
  let cancelled = false;
  let started = false;

  const result = (async (): Promise<ListenResult> => {
    if (!speech) return { ok: false, reason: 'failed' };
    const permission = await speech.requestPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'denied' };
    if (cancelled) return { ok: false, reason: 'cancelled' };

    return new Promise<ListenResult>((resolve) => {
      let heard = '';
      let failed = false;
      const subscriptions = [
        speech.addListener('result', (event) => {
          heard = event.results[0]?.transcript ?? heard;
          onHeard(heard);
        }),
        speech.addListener('error', (event) => {
          // Silence and a deliberate stop are not failures.
          if (event.error !== 'no-speech' && event.error !== 'aborted') failed = true;
        }),
        // "end" is always the last event, whatever happened before it.
        speech.addListener('end', () => {
          subscriptions.forEach((subscription) => subscription.remove());
          const text = heard.trim();
          if (cancelled) resolve({ ok: false, reason: 'cancelled' });
          else if (text) resolve({ ok: true, text });
          else resolve({ ok: false, reason: failed ? 'failed' : 'nothing' });
        }),
      ];

      started = true;
      speech.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false, // one question: stops by itself after a pause
        contextualStrings: VOCABULARY,
        // Play-and-record through the loudspeaker, so the spoken answer that follows is loud.
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
          mode: 'default',
        },
      });
    });
  })().catch((): ListenResult => ({ ok: false, reason: 'failed' }));

  return {
    result,
    finish: () => {
      if (started) speech?.stop();
      else cancelled = true;
    },
    cancel: () => {
      cancelled = true;
      if (started) speech?.abort();
    },
  };
}
