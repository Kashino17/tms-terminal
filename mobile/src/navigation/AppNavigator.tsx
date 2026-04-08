import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import { ServerListScreen } from '../screens/ServerListScreen';
import { AddServerScreen } from '../screens/AddServerScreen';
import { TerminalScreen } from '../screens/TerminalScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { DrawingScreen } from '../screens/DrawingScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { PinSetupScreen } from '../screens/PinSetupScreen';
import { BrowserScreen } from '../screens/BrowserScreen';
import { ProcessMonitorScreen } from '../screens/ProcessMonitorScreen';
import { ManagerChatScreen } from '../screens/ManagerChatScreen';
import { colors } from '../theme';
import type { RootStackParamList } from '../types/navigation.types';

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
      <Stack.Screen
        name="ServerList"
        component={ServerListScreen}
        options={({ navigation }) => ({
          title: 'TMS Terminal',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <TouchableOpacity
                onPress={() => navigation.navigate('Settings')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Einstellungen"
                accessibilityRole="button"
              >
                <Feather name="settings" size={20} color={colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => navigation.navigate('Dashboard')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Server Dashboard"
                accessibilityRole="button"
              >
                <Feather name="grid" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
          ),
        })}
      />
      <Stack.Screen
        name="AddServer"
        component={AddServerScreen}
        options={{ title: 'Add Server', presentation: 'modal' }}
      />
      <Stack.Screen
        name="Terminal"
        component={TerminalScreen}
        options={{
          title: 'Terminal',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="Drawing"
        component={DrawingScreen}
        options={{ headerShown: false, animation: 'slide_from_right', animationDuration: 280 }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
      <Stack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ title: 'Dashboard' }}
      />
      <Stack.Screen
        name="PinSetup"
        component={PinSetupScreen}
        options={({ route }) => ({
          title:
            route.params?.mode === 'disable' ? 'Disable App Lock'
            : route.params?.mode === 'change' ? 'Change PIN'
            : 'Set App PIN',
          presentation: 'modal' as const,
        })}
      />
      <Stack.Screen
        name="Browser"
        component={BrowserScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 250,
        }}
      />
      <Stack.Screen
        name="Processes"
        component={ProcessMonitorScreen}
        options={{
          title: 'Processes',
          animation: 'slide_from_right',
          animationDuration: 280,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' as const, fontSize: 16 },
        }}
      />
      <Stack.Screen
        name="ManagerChat"
        component={ManagerChatScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
          animationDuration: 280,
        }}
      />
    </Stack.Navigator>
  );
}
