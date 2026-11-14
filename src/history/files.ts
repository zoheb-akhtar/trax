import { Directory, File, Paths } from 'expo-file-system';

/**
 * Ride pictures live in the app's documents folder, under rides/<ride id>/.
 * Paths are stored relative to that folder because its absolute location can
 * change when the app is updated.
 */

/** Downloads one picture. Returns its relative path, or null if it could not be saved. */
export async function savePicture(url: string, rideId: string, name: string) {
  try {
    const folder = new Directory(Paths.document, 'rides', rideId);
    folder.create({ intermediates: true, idempotent: true });
    await File.downloadFileAsync(url, new File(folder, name));
    return `rides/${rideId}/${name}`;
  } catch {
    return null;
  }
}

export function pictureUri(relativePath: string) {
  return new File(Paths.document, relativePath).uri;
}

export function deleteRidePictures(rideId: string) {
  try {
    const folder = new Directory(Paths.document, 'rides', rideId);
    if (folder.exists) folder.delete();
  } catch {
    // Nothing to clean up, or the folder is already gone.
  }
}
