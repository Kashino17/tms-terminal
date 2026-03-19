import React, { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './navigation/AppNavigator';
import { LockScreen } from './screens/LockScreen';
import { useLockStore } from './store/lockStore';
import { colors } from './theme';
import { ResponsiveProvider } from './hooks/useResponsive';
import { registerBackgroundHandler, registerForegroundHandler } from './services/notifications.service';
import { keywordAlertService } from './services/keywordAlert.service';
import { registerBackgroundUpdateCheck } from './services/updater.service';

// Background FCM handler must be registered before any component mounts.
try {
  registerBackgroundHandler();
} catch {
  // Firebase not ready on this cold start — background handler will be skipped
}

const darkTheme = {
  dark: true,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    notification: colors.destructive,
  },
};

export default function App() {
  const { ready, isEnabled, isUnlocked, lock, loadLockConfig } = useLockStore();
  const [appReady, setAppReady] = useState(false);

  // Load lock config before showing anything
  useEffect(() => {
    loadLockConfig().then(() => setAppReady(true)).catch(() => setAppReady(true));
  }, []);

  // Lock when app moves to background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' && isEnabled) {
        lock();
      }
    });
    return () => sub.remove();
  }, [isEnabled, lock]);

  useEffect(() => {
    keywordAlertService.init().catch(() => {});
    try {
      const unsubscribe = registerForegroundHandler();
      return unsubscribe;
    } catch {
      // Firebase not available
    }
  }, []);

  // Blank screen while reading AsyncStorage (~30ms) to prevent flash
  if (!appReady || !ready) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <ResponsiveProvider>
      <SafeAreaProvider>
        <NavigationContainer theme={darkTheme}>
          <StatusBar style="light" backgroundColor={colors.bg} translucent={false} />
          <AppNavigator />
        </NavigationContainer>
        {isEnabled && !isUnlocked && <LockScreen />}
      </SafeAreaProvider>
    </ResponsiveProvider>
  );
}
