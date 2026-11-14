import {
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance } from 'react-native';

import { AlarmTakeover } from '@/components/alarm-takeover';
import AppTabs from '@/components/app-tabs';
import { DeviceProvider } from '@/device/device-provider';
import { HistoryProvider } from '@/history/history-provider';
import { NavProvider } from '@/nav/nav-provider';
import { SecurityProvider } from '@/security/security-provider';

// Hold the splash screen until the typeface has loaded, so text never flashes in a fallback font.
SplashScreen.preventAutoHideAsync();

// The app is light-only; this keeps system-drawn parts (tab bar, sheets, keyboard) light too.
Appearance.setColorScheme('light');

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Inter_300Light,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const ready = loaded || error != null; // on a font failure, carry on with the system font

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider value={DefaultTheme}>
      <StatusBar style="dark" />
      <DeviceProvider>
        <NavProvider>
          <HistoryProvider>
            <SecurityProvider>
              <AppTabs />
              <AlarmTakeover />
            </SecurityProvider>
          </HistoryProvider>
        </NavProvider>
      </DeviceProvider>
    </ThemeProvider>
  );
}
