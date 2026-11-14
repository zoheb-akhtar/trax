/** Browsers play MJPEG natively in an <img>. */
export function MjpegView({ uri }: { uri: string }) {
  return (
    <img
      src={uri}
      alt="Live camera"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
    />
  );
}
