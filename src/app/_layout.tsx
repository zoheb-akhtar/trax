import {
  Montserrat_300Light,
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  useFonts,
} from '@expo-google-fonts/montserrat';
import { DarkTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AlarmTakeover } from '@/components/alarm-takeover';
import AppTabs from '@/components/app-tabs';
import { DeviceProvider } from '@/device/device-provider';
import { HistoryProvider } from '@/history/history-provider';
import { NavProvider } from '@/nav/nav-provider';

// Hold the splash screen until the typeface has loaded, so text never flashes in a fallback font.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Montserrat_300Light,
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
  });
  const ready = loaded || error != null; // on a font failure, carry on with the system font

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider value={DarkTheme}>
      <StatusBar style="light" />
      <DeviceProvider>
        <NavProvider>
          <HistoryProvider>
            <AppTabs />
            <AlarmTakeover />
          </HistoryProvider>
        </NavProvider>
      </DeviceProvider>
    </ThemeProvider>
  );
}
