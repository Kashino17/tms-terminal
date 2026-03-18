import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../types/navigation.types';
import { ProcessMonitorPanel } from '../components/ProcessMonitorPanel';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Processes'>;
  route: RouteProp<RootStackParamList, 'Processes'>;
};

export function ProcessMonitorScreen({ route }: Props) {
  const { wsService } = route.params;
  const responsive = useResponsive();

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <View style={styles.content}>
        <ProcessMonitorPanel wsService={wsService} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
  },
});
