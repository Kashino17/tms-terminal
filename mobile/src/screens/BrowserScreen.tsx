import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import { BrowserPanel } from '../components/BrowserPanel';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Browser'>;
  route: RouteProp<RootStackParamList, 'Browser'>;
};

export function BrowserScreen({ route }: Props) {
  const { serverHost, serverId } = route.params;
  const responsive = useResponsive();

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <BrowserPanel
        serverHost={serverHost}
        serverId={serverId}
        screenWidth={responsive.width}
        isFullScreen
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
