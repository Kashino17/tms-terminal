import React, { useEffect, useState, useCallback } from 'react';
import { AppState, View, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { AppNavigator } from './navigation/AppNavigator';
import { LockScreen } from './screens/LockScreen';
import { AdhanAlert } from './components/AdhanAlert';
import { useLockStore } from './store/lockStore';
import { useSettingsStore } from './store/settingsStore';
import { colors } from './theme';
import { ResponsiveProvider } from './hooks/useResponsive';
import { registerBackgroundHandler, registerForegroundHandler, registerNotificationResponseHandler } from './services/notifications.service';
import { keywordAlertService } from './services/keywordAlert.service';
import { useAutopilotStore } from './store/autopilotStore';
import { registerBackgroundUpdateCheck } from './services/updater.service';
import {
  setupAdhanNotificationChannel, playAdhan, stopAdhan, getSelectedAdhan,
} from './services/adhan.service';
import { setupManagerNotificationChannel } from './services/managerNotifications.service';
import { startAdhanScheduler } from './services/adhanScheduler';

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
  // UI-version switch: remount the WHOLE NavigationContainer on toggle — a key
  // on the inner Stack.Navigator alone does not reliably reset navigation
  // state, so initialRouteName was ignored when flipping the Design switch.
  const seasonTwoEnabled = useSettingsStore((s) => s.seasonTwoEnabled);
  const [appReady, setAppReady] = useState(false);
  // Der Wecker-Modus (Fajr) laeuft von selbst an, ohne Knopf. Deshalb steht er
  // hier und nicht im Bildschirm — der Dialog muss auch erscheinen, wenn gerade
  // ein Terminal oder der Browser zu ist.
  const [adhanAlert, setAdhanAlert] = useState<
    { name: string; time: string; arabic: string; wecker: boolean } | null
  >(null);

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

  // Global Adhan notification listeners (works from any screen, lockscreen, background)
  useEffect(() => {
    setupAdhanNotificationChannel();
    setupManagerNotificationChannel();

    // Adhan-Alarme fuer den ganzen Tag planen. Laeuft hier und nicht in einem
    // Bildschirm: der klassische HomeScreen ist die einzige Stelle gewesen, an der
    // Alarme entstanden sind, und den rendert das neue Layout nicht — dort klang
    // deshalb nie ein Adhan, obwohl die Zeiten stimmten. Der Dienst plant auch
    // neu, sobald die App wieder in den Vordergrund kommt.
    //
    // Damit ist auch der Neustart des Handys abgedeckt: AlarmManager-Alarme
    // ueberleben keinen Reboot, aber der Dienst plant beim naechsten Start neu.
    // Kein BOOT_COMPLETED-Receiver noetig — Receiver koennten nur merken, dass
    // geplant werden muss, und genau das passiert hier ohnehin.
    //
    // Die eine Luecke, die bleibt: Wurde das Handy neu gestartet und die App
    // danach nicht geoeffnet, klingelt vor dem ersten Start kein Alarm. Das ist
    // ohne Empfang von Standort und Zeiten nicht loesbar — und die Zeiten sind
    // genau das, was zum Planen gebraucht wird.
    startAdhanScheduler();

    const showAdhan = (d: any) => {
      setAdhanAlert({
        name: d.prayerName as string,
        time: d.prayerTime as string,
        arabic: d.prayerArabic as string,
        wecker: !!(d.wecker ?? d.isWecker), // beide Namen kommen im Umlauf vor
      });
    };

    // Foreground: notification received while app is open
    const fgSub = Notifications.addNotificationReceivedListener(notification => {
      const d = notification.request.content.data;
      if (d?.type === 'adhan') showAdhan(d);
    });

    // Background/Lockscreen: user tapped the notification → app opens
    const bgSub = Notifications.addNotificationResponseReceivedListener(response => {
      const d = response.notification.request.content.data;
      if (d?.type === 'adhan') showAdhan(d);
    });

    return () => { fgSub.remove(); bgSub.remove(); };
  }, []);

  // Blank screen while reading AsyncStorage (~30ms) to prevent flash
  if (!appReady || !ready) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ResponsiveProvider>
        <SafeAreaProvider>
          <NavigationContainer key={seasonTwoEnabled ? 's2' : 'classic'} theme={darkTheme}>
            <StatusBar style="light" backgroundColor={colors.bg} translucent={false} />
            <AppNavigator />
          </NavigationContainer>
          {isEnabled && !isUnlocked && <LockScreen />}
          <AdhanAlert
            visible={!!adhanAlert}
            prayerName={adhanAlert?.name ?? ''}
            prayerTime={adhanAlert?.time ?? ''}
            prayerArabic={adhanAlert?.arabic ?? ''}
            wecker={adhanAlert?.wecker ?? false}
            onLoud={async () => {
              // Beim Wecker laeuft der Ton schon (AdhanFullscreenActivity bzw. der
              // Autoplay-Zweig im AdhanAlert) — der Knopf schliesst nur das Fenster.
              const wecker = adhanAlert?.wecker ?? false;
              if (wecker) {
                setAdhanAlert(null);
                return;
              }
              setAdhanAlert(null);
              await playAdhan(await getSelectedAdhan());
            }}
            onSilent={() => {
              setAdhanAlert(null);
              stopAdhan();
            }}
          />
        </SafeAreaProvider>
      </ResponsiveProvider>
    </GestureHandlerRootView>
  );
}
