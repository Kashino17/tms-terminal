import React from 'react';
import { TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import { HomeScreen } from '../screens/HomeScreen';
import { ServerListScreen } from '../screens/ServerListScreen';
import { PrayerTimesScreen } from '../screens/PrayerTimesScreen';
import { HydraScreen } from '../screens/HydraScreen';
import { AddServerScreen } from '../screens/AddServerScreen';
import { TerminalScreen } from '../screens/TerminalScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { DrawingScreen } from '../screens/DrawingScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { PinSetupScreen } from '../screens/PinSetupScreen';
import { BrowserScreen } from '../screens/BrowserScreen';
import { ProcessMonitorScreen } from '../screens/ProcessMonitorScreen';
import { ManagerChatScreen } from '../screens/ManagerChatScreen';
import { ManagerChatScreenV2 } from '../screens/ManagerChatScreenV2';
import { ManagerMemoryScreen } from '../screens/ManagerMemoryScreen';
import { ManagerArtifactsScreen } from '../screens/ManagerArtifactsScreen';
import { colors } from '../theme';
import { useSettingsStore } from '../store/settingsStore';
import type { RootStackParamList } from '../types/navigation.types';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

/**
 * Switches between the legacy ManagerChatScreen and the redesigned V2 based on
 * the `managerChatRedesignEnabled` flag in settings. Lets users toggle the new
 * UI on/off in Settings without re-deploying.
 */
function ManagerChatRouter(props: {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ManagerChat'>;
  route: RouteProp<RootStackParamList, 'ManagerChat'>;
}) {
  const useV2 = useSettingsStore((s) => s.managerChatRedesignEnabled);
  return useV2 ? <ManagerChatScreenV2 {...props} /> : <ManagerChatScreen {...props} />;
}

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions = {
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '600' as const },
  contentStyle: { backgroundColor: colors.bg },
};

export function AppNavigator() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      {/* ── Home (new start screen) ──────────────────────────── */}
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ headerShown: false }}
      />

      {/* ── Connections ──────────────────────────────────────── */}
      <Stack.Screen
        name="ServerList"
        component={ServerListScreen}
        options={{
          title: 'Connections',
          animation: 'fade_from_bottom',
          animationDuration: 250,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.primary,
        }}
      />

      {/* ── Hydra (Hydration Tracker) ────────────────────────── */}
      <Stack.Screen
        name="Hydra"
        component={HydraScreen}
        options={{
          title: 'Hydra',
          animation: 'fade_from_bottom',
          animationDuration: 250,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: '#3B82F6',
        }}
      />

      {/* ── Prayer Times ─────────────────────────────────────── */}
      <Stack.Screen
        name="PrayerTimes"
        component={PrayerTimesScreen}
        options={{
          title: 'Gebetszeiten',
          animation: 'fade_from_bottom',
          animationDuration: 250,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: '#10B981',
        }}
      />

      {/* ── Add Server — slide up from bottom (modal feel) ─────── */}
      <Stack.Screen
        name="AddServer"
        component={AddServerScreen}
        options={{
          title: 'Add Server',
          presentation: 'formSheet',
          animation: 'slide_from_bottom',
          animationDuration: 300,
          headerStyle: { backgroundColor: colors.surface },
          contentStyle: { backgroundColor: colors.surface },
        }}
      />

      {/* ── Terminal — fade when direct, instant when openManager pass-through ── */}
      <Stack.Screen
        name="Terminal"
        component={TerminalScreen}
        options={({ route }) => ({
          headerShown: false,
          animation: (route.params as any)?.openManager ? 'none' : 'fade_from_bottom',
          animationDuration: (route.params as any)?.openManager ? 0 : 250,
        })}
      />

      {/* ── Drawing — slide from right ────────────────────────── */}
      <Stack.Screen
        name="Drawing"
        component={DrawingScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 250,
        }}
      />

      {/* ── Settings — iOS-style slide from right ─────────────── */}
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Einstellungen',
          animation: 'slide_from_right',
          animationDuration: 280,
        }}
      />

      {/* ── Dashboard — fade in (overview feel) ───────────────── */}
      <Stack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          title: 'Dashboard',
          animation: 'fade',
          animationDuration: 200,
        }}
      />

      {/* ── PIN Setup — modal slide up ────────────────────────── */}
      <Stack.Screen
        name="PinSetup"
        component={PinSetupScreen}
        options={({ route }) => ({
          title:
            route.params?.mode === 'disable' ? 'App Lock deaktivieren'
            : route.params?.mode === 'change' ? 'PIN ändern'
            : 'App PIN setzen',
          presentation: 'formSheet',
          animation: 'slide_from_bottom',
          animationDuration: 300,
        })}
      />

      {/* ── Browser — slide from right ────────────────────────── */}
      <Stack.Screen
        name="Browser"
        component={BrowserScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 220,
        }}
      />

      {/* ── Processes — slide from right ──────────────────────── */}
      <Stack.Screen
        name="Processes"
        component={ProcessMonitorScreen}
        options={{
          title: 'Prozesse',
          animation: 'slide_from_right',
          animationDuration: 250,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' as const, fontSize: 16 },
        }}
      />

      {/* ── Manager Chat — slide up from bottom (chat feel) ──── */}
      <Stack.Screen
        name="ManagerChat"
        component={ManagerChatRouter}
        options={{
          headerShown: false,
          animation: 'slide_from_bottom',
          animationDuration: 300,
        }}
      />

      {/* ── Manager Memory — slide from right ─────────────────── */}
      <Stack.Screen
        name="ManagerMemory"
        component={ManagerMemoryScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 250,
        }}
      />

      {/* ── Manager Artifacts — slide from right ────────────────── */}
      <Stack.Screen
        name="ManagerArtifacts"
        component={ManagerArtifactsScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 250,
        }}
      />
    </Stack.Navigator>
  );
}
