import AsyncStorage from '@react-native-async-storage/async-storage';

/** Keys were "velo.*" before the app was renamed Trax. */
const OLD_PREFIX = 'velo.';
const PREFIX = 'trax.';

/**
 * Reads a saved value. If it was saved under the app's old name, it is moved to the new key
 * the first time it is read, so nothing is lost by the rename.
 */
export async function readStored(key: string): Promise<string | null> {
  const value = await AsyncStorage.getItem(key);
  if (value != null || !key.startsWith(PREFIX)) return value;
  const oldKey = OLD_PREFIX + key.slice(PREFIX.length);
  const old = await AsyncStorage.getItem(oldKey);
  if (old == null) return null;
  await AsyncStorage.setItem(key, old);
  AsyncStorage.removeItem(oldKey).catch(() => {});
  return old;
}
