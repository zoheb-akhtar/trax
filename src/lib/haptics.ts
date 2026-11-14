import * as Haptics from 'expo-haptics';

/** Haptics are a nice-to-have; never let a missing engine (web, simulator) throw. */
function safe(run: () => Promise<void>) {
  run().catch(() => {});
}

export const haptic = {
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  commit: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  warning: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  alarm: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
