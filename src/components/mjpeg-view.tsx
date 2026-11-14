import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

/** Shows an MJPEG stream. React Native's Image can't play MJPEG, so this uses a web view. */
export function MjpegView({ uri }: { uri: string }) {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"></head>
<body style="margin:0;background:#000;overflow:hidden">
<img src=${JSON.stringify(uri)} style="width:100vw;height:100vh;object-fit:cover" />
</body></html>`;

  return (
    <WebView
      source={{ html }}
      originWhitelist={['*']}
      style={styles.fill}
      scrollEnabled={false}
      pointerEvents="none"
      mixedContentMode="always"
    />
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, backgroundColor: '#000' },
});
