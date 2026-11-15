import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

/**
 * Notifications from Velo.
 *
 * - Banners the app shows itself, the moment it learns the bike was moved. These need the app
 *   to be open (or only just closed), since that is when it hears from the bike.
 * - Push notifications, which reach a locked phone with the app closed. Those are sent by the
 *   agent server on the laptop, which watches the bike (device/agent_proxy.py); this file only
 *   gets the phone's push address for it. That needs an Expo project id (`eas init`).
 */

/** Show Velo's notifications as banners even while the app is open. Call once at start-up. */
export function setUpNotifications() {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Notifications are a nice-to-have.
  }
}

/** Asks for permission the first time. True if Velo may show notifications. */
export async function allowNotifications() {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return asked.granted;
  } catch {
    return false;
  }
}

/** Shows a notification on this phone right now. */
export async function notifyNow(title: string, body: string, data?: Record<string, string>) {
  if (!(await allowNotifications())) return false;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data, sound: 'default', interruptionLevel: 'timeSensitive' },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}

/** The Expo project id push notifications need, if the project has one. */
export function pushProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

/** This phone's address for push notifications, or null where push isn't possible. */
export async function pushToken(): Promise<string | null> {
  const projectId = pushProjectId();
  if (!projectId || !(await allowNotifications())) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  }
}
