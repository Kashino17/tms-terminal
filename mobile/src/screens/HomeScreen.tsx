import React, { useEffect, useCallback, useState, useRef } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, Animated, RefreshControl } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useServerStore } from '../store/serverStore';
import { useHydraStore, BAD_DRINK_INFO, WATER_IMAGE, type BadDrinkType } from '../store/hydraStore';
import { colors, fonts } from '../theme';
import {
  fetchPrayerTimes, getCurrentLocation, getNextPrayer, formatRemaining,
  getPrayerProgress, hasPassed, PRAYER_NAMES,
  type PrayerData, type LocationInfo, type PrayerTimes,
} from '../services/prayer.service';
import {
  getAdhanEnabled, scheduleAdhanForPrayer, cancelAllAdhanNotifications,
} from '../services/adhan.service';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

const PRAYER_ICONS: Partial<Record<keyof PrayerTimes, any>> = {
  Fajr: require('../../assets/icons/fajr.png'),
  Dhuhr: require('../../assets/icons/dhuhr.png'),
  Asr: require('../../assets/icons/asr.png'),
  Maghrib: require('../../assets/icons/maghrib.png'),
  Isha: require('../../assets/icons/isha.png'),
};

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

export function HomeScreen({ navigation }: Props) {
  const { servers, statuses, loadServers, setStatus } = useServerStore();
  const [prayerData, setPrayerData] = useState<PrayerData | null>(null);
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Adhan alert is now global in App.tsx

  // Tick every 30s for countdown + prayer time check
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // Adhan notifications are now handled globally in App.tsx

  // Schedule adhan notifications for today's remaining prayers
  useEffect(() => {
    if (!prayerData) return;
    const schedulePrayers = async () => {
      const enabled = await getAdhanEnabled();
      if (!enabled) return;

      await cancelAllAdhanNotifications();
      const prayers: (keyof PrayerTimes)[] = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
      for (const name of prayers) {
        const timeStr = prayerData.timings[name].replace(/\s*\(.*\)/, '').trim();
        const info = PRAYER_NAMES[name];
        await scheduleAdhanForPrayer(info.de, timeStr, info.ar);
      }
    };
    schedulePrayers();
  }, [prayerData]);

  const loadAll = useCallback(async () => {
    loadServers();
    // Ping servers
    const currentServers = useServerStore.getState().servers;
    await Promise.all(
      currentServers.map(async (server) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const start = Date.now();
        try {
          const res = await fetch(`http://${server.host}:${server.port}/health`, { signal: controller.signal });
          clearTimeout(timeout);
          if (res.ok) setStatus(server.id, { connected: true, latency: Date.now() - start });
          else setStatus(server.id, { connected: false });
        } catch { clearTimeout(timeout); setStatus(server.id, { connected: false }); }
      }),
    );
    // Prayer times
    const loc = await getCurrentLocation();
    if (loc) {
      setLocation(loc);
      const data = await fetchPrayerTimes(loc.latitude, loc.longitude);
      if (data) setPrayerData(data);
    }
  }, [loadServers, setStatus]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', loadAll);
    return unsub;
  }, [navigation, loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const onlineCount = servers.filter(s => statuses[s.id]?.connected).length;
  const nextPrayer = prayerData ? getNextPrayer(prayerData.timings) : null;
  const progress = prayerData ? getPrayerProgress(prayerData.timings) : 0;

  // Date formatting
  const dateStr = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hijriStr = prayerData
    ? `${prayerData.date.hijri.day}. ${prayerData.date.hijri.month.en} ${prayerData.date.hijri.year}`
    : '';

  // App icon press animation
  const AppIcon = ({ gradient, icon, label, badge, onPress }: {
    gradient: string[]; icon: React.ReactNode; label: string; badge?: string; onPress: () => void;
  }) => {
    const scale = useRef(new Animated.Value(1)).current;
    return (
      <TouchableOpacity
        activeOpacity={1}
        onPressIn={() => Animated.spring(scale, { toValue: 0.85, tension: 200, friction: 10, useNativeDriver: true }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, tension: 150, friction: 6, useNativeDriver: true }).start()}
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress(); }}
        style={s.appWrap}
      >
        <Animated.View style={[s.appIcon, { backgroundColor: gradient[0], transform: [{ scale }] }]}>
          {icon}
          {badge && <View style={s.appBadge}><Text style={s.appBadgeText}>{badge}</Text></View>}
        </Animated.View>
        <Text style={s.appLabel}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const prayerKeys: (keyof PrayerTimes)[] = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>TMS Terminal</Text>
          <View style={s.headerRight}>
            {hijriStr !== '' && (
              <View style={s.hijriBadge}><Text style={s.hijriText}>{hijriStr}</Text></View>
            )}
            <TouchableOpacity style={s.gear} onPress={() => navigation.navigate('Settings')}>
              <Feather name="settings" size={17} color="#64748B" />
            </TouchableOpacity>
          </View>
        </View>
        <Text style={s.date}>{dateStr}</Text>

        {/* App Grid */}
        <View style={s.appGrid}>
          <AppIcon
            gradient={['transparent']}
            icon={<Image source={require('../../assets/icons/connection.png')} style={s.appIconImg} resizeMode="cover" />}
            label="Connections"
            badge={onlineCount > 0 ? String(onlineCount) : undefined}
            onPress={() => navigation.navigate('ServerList')}
          />
          <AppIcon
            gradient={['transparent']}
            icon={<Image source={require('../../assets/icons/gebetszeit.png')} style={s.appIconImg} resizeMode="cover" />}
            label="Gebetszeiten"
            onPress={() => navigation.navigate('PrayerTimes' as any)}
          />
          <AppIcon
            gradient={['transparent']}
            icon={<Image source={require('../../assets/icons/hydra.png')} style={s.appIconImg} resizeMode="cover" />}
            label="Hydra"
            onPress={() => navigation.navigate('Hydra' as any)}
          />
        </View>

        {/* Prayer Widget */}
        {prayerData && nextPrayer && (
          <TouchableOpacity
            style={s.prayerWidget}
            onPress={() => navigation.navigate('PrayerTimes' as any)}
            activeOpacity={0.7}
          >
            <View style={s.pwTop}>
              <View style={s.pwIcon}>
                {PRAYER_ICONS[nextPrayer.name]
                  ? <Image source={PRAYER_ICONS[nextPrayer.name]} style={s.pwIconImg} resizeMode="cover" />
                  : <Text style={{ fontSize: 20 }}>{PRAYER_NAMES[nextPrayer.name]?.emoji ?? '☀️'}</Text>}
              </View>
              <View style={s.pwInfo}>
                <Text style={s.pwLabel}>Nächstes Gebet</Text>
                <View style={s.pwMain}>
                  <Text style={s.pwName}>{nextPrayer.name}</Text>
                  <Text style={s.pwTime}>{nextPrayer.time}</Text>
                </View>
              </View>
              <View>
                <Text style={s.pwRemain}>In {formatRemaining(nextPrayer.remainingMs)}</Text>
                <Text style={s.pwCity}>{location?.city ?? ''}</Text>
              </View>
            </View>
            <View style={s.pwBar}><View style={[s.pwProgress, { width: `${Math.min(progress * 100, 100)}%` }]} /></View>
            <View style={s.pwTimes}>
              {prayerKeys.map(key => {
                const time = prayerData.timings[key].replace(/\s*\(.*\)/, '').trim();
                const passed = hasPassed(prayerData.timings[key]);
                const isNext = nextPrayer.name === key;
                return (
                  <View key={key} style={[s.pwT, isNext && s.pwTActive, passed && !isNext && s.pwTPassed]}>
                    <Text style={[s.pwTName, isNext && s.pwTNameActive]}>{key}</Text>
                    <Text style={[s.pwTVal, isNext && s.pwTValActive]}>{time}</Text>
                  </View>
                );
              })}
            </View>
          </TouchableOpacity>
        )}

        {/* Hydra Widget */}
        {(() => {
          const hydra = useHydraStore.getState();
          const ht = hydra.getToday();
          const liters = ht.waterCount * 0.5;
          return (
            <TouchableOpacity
              style={s.hydraWidget}
              onPress={() => navigation.navigate('Hydra' as any)}
              activeOpacity={0.7}
            >
              <View style={s.hydraTop}>
                <View style={s.hydraIcon}>
                  <Feather name="droplet" size={20} color="#06B6D4" />
                </View>
                <View style={s.hydraInfo}>
                  <Text style={s.hydraTitle}>Hydra</Text>
                  <Text style={s.hydraSub}>{liters}L / 3L heute</Text>
                </View>
                <View style={s.hydraHP}>
                  <Text style={s.hydraHPVal}>❤️ {hydra.totalHP}</Text>
                  <Text style={s.hydraHPLabel}>HP</Text>
                </View>
              </View>
              <View style={s.hydraBottles}>
                {Array.from({ length: 6 }, (_, i) => (
                  <View key={i} style={[s.hydraMiniBottle, i >= ht.waterCount && s.hydraMiniEmpty]}>
                    <Image source={WATER_IMAGE} style={[s.hydraMiniImg, i >= ht.waterCount && { opacity: 0.2 }]} resizeMode="contain" />
                  </View>
                ))}
              </View>
            </TouchableOpacity>
          );
        })()}

        {/* Server Quick Cards + Manager Agent */}
        {servers.length > 0 && (
          <View style={s.serverRow}>
            {servers.slice(0, 4).map(sv => {
              const st = statuses[sv.id];
              const online = st?.connected ?? false;
              return (
                <TouchableOpacity
                  key={sv.id}
                  style={[s.serverCard, !online && s.serverOffline]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    navigation.navigate('Terminal', {
                      serverId: sv.id, serverName: sv.name, serverHost: sv.host,
                      serverPort: sv.port, token: sv.token ?? '',
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <View style={s.scRow}>
                    <View style={[s.scDot, { backgroundColor: online ? '#22C55E' : '#475569' }]} />
                    <Text style={s.scName} numberOfLines={1}>{sv.name}</Text>
                    <Text style={[s.scMs, { color: online ? '#22C55E' : '#475569' }]}>
                      {online && st?.latency ? `${st.latency}ms` : '—'}
                    </Text>
                  </View>
                  <Text style={s.scSub}>{online ? 'Verbunden' : 'Offline'}</Text>
                </TouchableOpacity>
              );
            })}
            {/* Manager Agent Button — square, same height as server cards */}
            {(() => {
              const onlineSv = servers.find(sv => statuses[sv.id]?.connected);
              if (!onlineSv) return null;
              return (
                <TouchableOpacity
                  style={s.agentSquare}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    navigation.navigate('Terminal', {
                      serverId: onlineSv.id, serverName: onlineSv.name,
                      serverHost: onlineSv.host, serverPort: onlineSv.port,
                      token: onlineSv.token ?? '', openManager: true,
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <View style={s.agentIconWrap}>
                    <Feather name="cpu" size={22} color="#A78BFA" />
                  </View>
                </TouchableOpacity>
              );
            })()}
          </View>
        )}
      </ScrollView>

    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: 30 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hijriBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: 'rgba(16,185,129,0.06)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)' },
  hijriText: { fontSize: 10, color: '#10B981', fontWeight: '600' },
  gear: { padding: 4, borderRadius: 8 },
  date: { fontSize: 11, color: '#475569', paddingHorizontal: 20, paddingTop: 2, paddingBottom: 14 },

  // App Grid
  appGrid: { flexDirection: 'row', paddingHorizontal: 20, gap: 20, paddingBottom: 16 },
  appWrap: { alignItems: 'center' },
  appIcon: { width: 54, height: 54, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  appIconImg: { width: 54, height: 54, borderRadius: 15 },
  appBadge: { position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 2, borderColor: '#0F172A' },
  appBadgeText: { fontSize: 8, fontWeight: '700', color: '#fff' },
  appLabel: { fontSize: 10, color: '#94A3B8', fontWeight: '500', marginTop: 5 },

  // Prayer Widget
  prayerWidget: { marginHorizontal: 16, borderRadius: 16, backgroundColor: '#1B2336', borderWidth: 1, borderColor: 'rgba(16,185,129,0.12)', overflow: 'hidden', marginBottom: 12 },
  pwTop: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pwIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(16,185,129,0.1)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  pwIconImg: { width: 42, height: 42, borderRadius: 12 },
  pwInfo: { flex: 1 },
  pwLabel: { fontSize: 10, color: '#10B981', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700' },
  pwMain: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  pwName: { fontSize: 18, fontWeight: '800', color: colors.text },
  pwTime: { fontSize: 18, fontWeight: '700', fontFamily: fonts.mono, color: '#10B981' },
  pwRemain: { fontSize: 10, color: '#64748B', textAlign: 'right' },
  pwCity: { fontSize: 9, color: '#10B981', textAlign: 'right', marginTop: 1 },
  pwBar: { height: 3, backgroundColor: '#243044', marginHorizontal: 14 },
  pwProgress: { height: '100%', borderRadius: 2, backgroundColor: '#10B981' },
  pwTimes: { flexDirection: 'row', padding: 8, paddingHorizontal: 10, gap: 2 },
  pwT: { flex: 1, alignItems: 'center', paddingVertical: 5, borderRadius: 8 },
  pwTActive: { backgroundColor: 'rgba(16,185,129,0.08)' },
  pwTPassed: { opacity: 0.35 },
  pwTName: { fontSize: 9, color: '#64748B' },
  pwTNameActive: { color: '#10B981' },
  pwTVal: { fontSize: 10, fontFamily: fonts.mono, fontWeight: '600', marginTop: 2, color: colors.text },
  pwTValActive: { color: '#10B981' },

  // Server Cards
  // Hydra Widget
  hydraWidget: { marginHorizontal: 16, borderRadius: 16, backgroundColor: '#1B2336', borderWidth: 1, borderColor: 'rgba(6,182,212,0.12)', overflow: 'hidden', marginBottom: 12, padding: 14 },
  hydraTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  hydraIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(6,182,212,0.1)', alignItems: 'center', justifyContent: 'center' },
  hydraInfo: { flex: 1 },
  hydraTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  hydraSub: { fontSize: 10, color: '#06B6D4', marginTop: 1 },
  hydraHP: { alignItems: 'flex-end' },
  hydraHPVal: { fontSize: 14, fontWeight: '800', color: '#EF4444', fontFamily: fonts.mono },
  hydraHPLabel: { fontSize: 8, color: '#64748B' },
  hydraBottles: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  hydraMiniBottle: { width: 36, height: 50, borderRadius: 8, backgroundColor: 'rgba(6,182,212,0.06)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(6,182,212,0.1)' },
  hydraMiniEmpty: { borderColor: '#243044', backgroundColor: '#243044' },
  hydraMiniImg: { width: 22, height: 36 },

  serverRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  serverCard: { flex: 1, minWidth: '45%', padding: 10, borderRadius: 12, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044' },
  serverOffline: { opacity: 0.35 },
  scRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scDot: { width: 6, height: 6, borderRadius: 3 },
  scName: { flex: 1, fontSize: 10, fontWeight: '600', color: colors.text },
  scMs: { fontSize: 9, fontFamily: fonts.mono, fontWeight: '600' },
  scSub: { fontSize: 8, color: '#475569', marginTop: 3 },
  agentSquare: { width: 52, alignSelf: 'stretch', borderRadius: 12, backgroundColor: '#1B2336', borderWidth: 1, borderColor: 'rgba(167,139,250,0.2)', alignItems: 'center', justifyContent: 'center' },
  agentIconWrap: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(167,139,250,0.1)', alignItems: 'center', justifyContent: 'center' },
  agentLabel: { fontSize: 8, color: '#A78BFA', fontWeight: '700', letterSpacing: 0.3 },
});
