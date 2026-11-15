import * as Speech from 'expo-speech';

let enabled = true;
let lastSpoke = 0;
/** True while the microphone is open, so Velo doesn't talk over the owner or record itself. */
let muted = false;

export function setMuted(on: boolean) {
  muted = on;
  if (on) Speech.stop().catch(() => {});
}

/** Routine announcements are dropped if another was spoken this recently. */
const MIN_GAP_MS = 2500;

export function setVoiceEnabled(on: boolean) {
  enabled = on;
  if (!on) Speech.stop().catch(() => {});
}

/** Stops whatever is being said, e.g. before listening to the owner. */
export function hush() {
  Speech.stop().catch(() => {});
}

/**
 * Says a short line aloud. Urgent lines interrupt whatever is being said;
 * routine ones are skipped when the voice has only just spoken.
 */
export function say(text: string, urgent = false) {
  if (!enabled || muted) return;
  const now = Date.now();
  if (!urgent && now - lastSpoke < MIN_GAP_MS) return;
  lastSpoke = now;
  try {
    if (urgent) Speech.stop().catch(() => {});
    Speech.speak(text, { rate: 1.02, pitch: 1 });
  } catch {
    // Speech is a nice-to-have; never let it break the ride screen.
  }
}
