import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
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

export function BrowserScreen({ navigation, route }: Props) {
  const { serverHost, serverId, openDirect } = route.params;
  const responsive = useResponsive();

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      <BrowserPanel
        serverHost={serverHost}
        serverId={serverId}
        screenWidth={responsive.width}
        isFullScreen
        openDirect={!!openDirect}
        onBackToTerminal={handleBack}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
