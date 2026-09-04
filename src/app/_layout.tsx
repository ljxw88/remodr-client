import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

import { autoConnectSavedHosts } from '@/features/connection/saved-host-connector';
import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { AppBackground } from '@/components/ui/app-background';
import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';
SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 300, fade: true });

const AbyssTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Colors.accent,
    // Transparent: each route paints the canvas itself, so a colour here would
    // only ever be seen through one, and a route that is see-through is what
    // made transitions read as a double exposure.
    background: 'transparent',
    card: Colors.backgroundElement,
    text: Colors.text,
    border: Colors.border,
    notification: Colors.accent,
  },
};

export default function RootLayout() {
  const stackOptions = useStackScreenOptions();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontError, fontsLoaded]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      void autoConnectSavedHosts()
        .then(() => connectAgentRuntime())
        .catch((error) => {
          console.warn('[SSH] Could not load saved hosts for auto-connect', error);
        });
    }
  }, []);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ThemeProvider value={AbyssTheme}>
      <StatusBar style="light" />
      <View style={styles.root}>
        {/*
          What shows behind the navigator's own furniture. A stack header is
          transparent so a route's canvas reads through it, but a header is not
          part of the route and nothing else paints that band — without this it
          is a black bar above every pushed screen.
        */}
        <AppBackground />
        <Stack
          screenOptions={{
            ...stackOptions,
            headerShown: false,
          }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="hosts" />
          <Stack.Screen name="agents" />
          <Stack.Screen name="diagnostics" />
          <Stack.Screen name="connect" />
          <Stack.Screen name="files" />
          <Stack.Screen name="monitor" />
          <Stack.Screen name="docker" />
          <Stack.Screen name="tunnels" />
        </Stack>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // The foot of the canvas gradient. Nothing should ever see this — a route
    // covers it from the first frame — but it means an unpainted moment is the
    // colour the app is about to be.
    backgroundColor: Colors.background,
  },
});
