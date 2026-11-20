import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AddServerScreen } from '../screens/AddServerScreen';
import { PinSetupScreen } from '../screens/PinSetupScreen';
import { SeasonTwoWebRoot } from '../season2/SeasonTwoWebRoot';
import { colors } from '../theme';
import type { RootStackParamList } from '../types/navigation.types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions = {
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '600' as const },
  contentStyle: { backgroundColor: colors.bg },
};

/**
 * The app is the Liquid-Deck page (SeasonTwoWebRoot). The two native forms
 * below are opened from it and return with goBack().
 */
export function AppNavigator() {
  return (
    <Stack.Navigator initialRouteName="SeasonTwo" screenOptions={screenOptions}>
      <Stack.Screen
        name="SeasonTwo"
        component={SeasonTwoWebRoot}
        options={{ headerShown: false, animation: 'fade' }}
      />

      {/* ── Add / edit a server — slide up from bottom (modal feel) ─────── */}
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
    </Stack.Navigator>
  );
}
