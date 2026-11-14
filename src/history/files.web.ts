/** The web build has no file storage, so rides are saved without pictures. */

export async function savePicture(_url: string, _rideId: string, _name: string) {
  return null as string | null;
}

export function pictureUri(relativePath: string) {
  return relativePath;
}

export function deleteRidePictures(_rideId: string) {}
