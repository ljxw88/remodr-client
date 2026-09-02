import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';

SplashScreen.preventAutoHideAsync();

const AbyssTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#6C7CFF',
    background: '#08090B',
    card: '#141519',
    text: '#F5F6F8',
    border: '#252830',
    notification: '#6C7CFF',
  },
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });
  if (!fontsLoaded) {
    return <AnimatedSplashOverlay />;
  }

  return (
    <ThemeProvider value={AbyssTheme}>
      <StatusBar style="light" />
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="hosts" />
        <Stack.Screen name="agents" />
        <Stack.Screen name="diagnostics" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="terminal" />
        <Stack.Screen name="files" />
        <Stack.Screen name="monitor" />
        <Stack.Screen name="docker" />
        <Stack.Screen name="tunnels" />
      </Stack>
    </ThemeProvider>
  );
}
