import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';

let enabled = true;
let lastSpoke = 0;
/**
 * True while the microphone is open, so Velo doesn't talk over the owner or record itself.
 * Urgent lines (a vehicle close, the alarm) are still said: safety comes before a clean recording.
 */
let muted = false;

export function setMuted(on: boolean) {
  muted = on;
  if (on) Speech.stop().catch(() => {});
}

/** Where Velo's voice comes from: the bike's speaker, the phone, or both. */
export type SpeakFrom = 'bike' | 'phone' | 'both';
let speakFrom: SpeakFrom = 'bike';
/** Sends a line to the bike's speaker; set while a device with a speaker is connected. */
type BikeSpeaker = (text: string, urgent: boolean) => Promise<boolean>;
let bike: BikeSpeaker | null = null;

export function setSpeakFrom(where: SpeakFrom) {
  speakFrom = where;
}

export function setBikeSpeaker(speaker: BikeSpeaker | null) {
  bike = speaker;
}

/**
 * The voice Velo speaks with: Zoe (Premium) if the phone has it, else the best English voice
 * installed. iOS only hands out its better voices to apps that ask for them by name.
 * To install Zoe: Settings > Accessibility > Spoken Content > Voices > English > Zoe (Premium).
 */
const PREFERRED_VOICE = 'Zoe';
let voiceId: string | undefined;

/** Picks the voice once at start-up. Speech works before this finishes, in the default voice. */
export async function chooseVoice() {
  try {
    const voices = (await Speech.getAvailableVoicesAsync()).filter((v) =>
      v.language.toLowerCase().startsWith('en'),
    );
    const rank = (id: string) => (/premium/i.test(id) ? 2 : /enhanced/i.test(id) ? 1 : 0);
    const best = [...voices].sort((a, b) => {
      const byQuality = rank(b.identifier) - rank(a.identifier);
      if (byQuality !== 0) return byQuality;
      const preferred = Number(b.name === PREFERRED_VOICE) - Number(a.name === PREFERRED_VOICE);
      if (preferred !== 0) return preferred;
      return Number(b.language === 'en-US') - Number(a.language === 'en-US');
    })[0];
    // Zoe at the best quality installed beats another voice at the same quality.
    const zoe = voices
      .filter((v) => v.name === PREFERRED_VOICE)
      .sort((a, b) => rank(b.identifier) - rank(a.identifier))[0];
    const pick = zoe && best && rank(zoe.identifier) >= rank(best.identifier) ? zoe : best;
    voiceId = pick?.identifier;
    return pick ? `${pick.name}${rank(pick.identifier) === 2 ? ' (Premium)' : rank(pick.identifier) === 1 ? ' (Enhanced)' : ''}` : null;
  } catch {
    return null;
  }
}

function phoneSpeak(text: string, interrupt: boolean) {
  try {
    if (interrupt) Speech.stop().catch(() => {});
    Speech.speak(text, { rate: 1.0, pitch: 1, voice: voiceId });
    return true;
  } catch {
    // Speech is a nice-to-have; never let it break the ride screen.
    return false;
  }
}

/**
 * Says a line from wherever it should come from. On the bike it is loud and needs no phone in
 * hand; if the bike can't be reached the phone says it instead, so nothing is lost.
 */
function deliver(text: string, interrupt: boolean) {
  const onBike = bike !== null && speakFrom !== 'phone';
  const onPhone = !onBike || speakFrom === 'both';
  if (onBike) {
    bike!(text, interrupt)
      .then((sent) => {
        if (!sent && !onPhone) phoneSpeak(text, interrupt);
      })
      .catch(() => {
        if (!onPhone) phoneSpeak(text, interrupt);
      });
  }
  return onPhone ? phoneSpeak(text, interrupt) : true;
}

/** Routine announcements are dropped if another was spoken this recently. */
const MIN_GAP_MS = 2500;

export function setVoiceEnabled(on: boolean) {
  enabled = on;
  if (!on) Speech.stop().catch(() => {});
}

/**
 * Sets the phone's audio up for a bike: speech plays even with the silent switch on, and other
 * apps' audio (music, a podcast) dips under it rather than stopping. Call once at start-up.
 */
export function setUpAudio() {
  setAudioModeAsync({
    playsInSilentMode: true,
    allowsRecording: false,
    interruptionMode: 'duckOthers',
  }).catch(() => {});
}

/**
 * Says a line after whatever is being said now, without interrupting it. For Velo speaking up
 * by itself (a briefing, a debrief), which must not cut across an answer or a warning.
 */
export function sayAfter(text: string): boolean {
  if (!enabled || muted) return false;
  lastSpoke = Date.now();
  return deliver(text, false);
}

/** Stops whatever is being said, e.g. before listening to the owner. */
export function hush() {
  Speech.stop().catch(() => {});
}

/**
 * Says a short line aloud. Urgent lines interrupt whatever is being said;
 * routine ones are skipped when the voice has only just spoken.
 * Returns whether the line was actually said.
 */
export function say(text: string, urgent = false): boolean {
  if (!enabled || (muted && !urgent)) return false;
  const now = Date.now();
  if (!urgent && now - lastSpoke < MIN_GAP_MS) return false;
  lastSpoke = now;
  return deliver(text, urgent);
}
