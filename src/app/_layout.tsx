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
SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 300, fade: true });

const AbyssTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#6C7CFF',
    // Transparent so the gradient behind the navigator shows through.
    background: 'transparent',
    card: '#141519',
    text: '#F5F6F8',
    border: '#252830',
    notification: '#6C7CFF',
  },
};

export default function RootLayout() {
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
        <AppBackground />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: 'transparent' },
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
    backgroundColor: Colors.background,
  },
});
