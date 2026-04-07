import React, { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './navigation/AppNavigator';
import { LockScreen } from './screens/LockScreen';
import { useLockStore } from './store/lockStore';
import { useSettingsStore } from './store/settingsStore';
import { colors } from './theme';
import { ResponsiveProvider } from './hooks/useResponsive';
import { registerBackgroundHandler, registerForegroundHandler, registerNotificationResponseHandler } from './services/notifications.service';
import { keywordAlertService } from './services/keywordAlert.service';
import { useAutopilotStore } from './store/autopilotStore';
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

  // Load lock config before showing anything + cleanup old autopilot items
  useEffect(() => {
    loadLockConfig().then(() => setAppReady(true)).catch(() => setAppReady(true));
    useAutopilotStore.getState().cleanupOldDone();
  }, []);

  // Lock when app moves to background (respects grace period)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' && isEnabled) {
        const grace = useSettingsStore.getState().lockGraceSeconds;
        const lastUnlock = useLockStore.getState().lastUnlockTime;
        if (grace > 0 && lastUnlock > 0 && Date.now() - lastUnlock < grace * 1000) {
          return; // within grace period — don't lock
        }
        lock();
      }
    });
    return () => sub.remove();
  }, [isEnabled, lock]);

  useEffect(() => {
    keywordAlertService.init().catch(() => {});
    const cleanups: (() => void)[] = [];
    try {
      cleanups.push(registerForegroundHandler());
    } catch {
      // Firebase not available
    }
    try {
      cleanups.push(registerNotificationResponseHandler());
    } catch {
      // expo-notifications not available
    }
    return () => { cleanups.forEach((fn) => fn()); };
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
