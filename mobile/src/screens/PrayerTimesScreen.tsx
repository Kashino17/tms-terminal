import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, RefreshControl, ActivityIndicator, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import {
  fetchPrayerTimes, getCurrentLocation, getNextPrayer, formatRemaining,
  getPrayerProgress, hasPassed, PRAYER_NAMES,
  type PrayerData, type LocationInfo, type PrayerTimes,
} from '../services/prayer.service';
import {
  ADHAN_OPTIONS, getSelectedAdhan, setSelectedAdhan,
  getAdhanEnabled, setAdhanEnabled, previewAdhan, stopAdhan,
  scheduleTestAdhan, setupAdhanNotificationChannel,
  getFajrWecker, setFajrWecker,
} from '../services/adhan.service';
import { AdhanAlert } from '../components/AdhanAlert';
import { playAdhan } from '../services/adhan.service';
import * as Notifications from 'expo-notifications';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

const PRAYER_ICONS: Partial<Record<keyof PrayerTimes, any>> = {
  Fajr: require('../../assets/icons/fajr.png'),
  Dhuhr: require('../../assets/icons/dhuhr.png'),
  Asr: require('../../assets/icons/asr.png'),
  Maghrib: require('../../assets/icons/maghrib.png'),
  Isha: require('../../assets/icons/isha.png'),
};

const METHODS: { id: number; label: string }[] = [
  { id: 3, label: 'MWL' },
  { id: 2, label: 'ISNA' },
  { id: 5, label: 'Egypt' },
  { id: 4, label: 'Makkah' },
  { id: 1, label: 'Karachi' },
];

// Simple cache so we don't re-fetch GPS every time
let cachedLocation: LocationInfo | null = null;
let cachedData: { data: PrayerData; method: number; dateKey: string } | null = null;

export function PrayerTimesScreen({ navigation }: Props) {
  const [data, setData] = useState<PrayerData | null>(cachedData?.data ?? null);
  const [location, setLocation] = useState<LocationInfo | null>(cachedLocation);
  const [loading, setLoading] = useState(!cachedData);
  const [methodLoading, setMethodLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [method, setMethod] = useState(cachedData?.method ?? 3);
  const [now, setNow] = useState(Date.now());
  const [adhanId, setAdhanId] = useState('mishary');
  const [adhanOn, setAdhanOn] = useState(true);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [testCountdown, setTestCountdown] = useState<number | null>(null);
  const [testAlert, setTestAlert] = useState<{ name: string; time: string; arabic: string; wecker?: boolean } | null>(null);
  const [fajrWeckerOn, setFajrWeckerOn] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // Load adhan settings + notification listener
  useEffect(() => {
    getSelectedAdhan().then(setAdhanId);
    getAdhanEnabled().then(setAdhanOn);
    getFajrWecker().then(setFajrWeckerOn);
    setupAdhanNotificationChannel();

    // Listen for foreground notifications (test trigger)
    const sub = Notifications.addNotificationReceivedListener(notification => {
      const d = notification.request.content.data;
      if (d?.type === 'adhan') {
        setTestAlert({ name: d.prayerName as string, time: d.prayerTime as string, arabic: d.prayerArabic as string, wecker: !!d.isWecker });
      }
    });

    return () => { stopAdhan(); sub.remove(); };
  }, []);

  const dateKey = new Date().toISOString().slice(0, 10);

  const load = useCallback(async (forceGps = false) => {
    // Use cached location if available
    let loc = cachedLocation;
    if (!loc || forceGps) {
      loc = await getCurrentLocation();
      if (loc) cachedLocation = loc;
    }
    if (!loc) { setLoading(false); return; }
    setLocation(loc);

    // Fetch prayer times
    const d = await fetchPrayerTimes(loc.latitude, loc.longitude, method);
    if (d) {
      setData(d);
      cachedData = { data: d, method, dateKey };
    }
    setLoading(false);
    setMethodLoading(false);
  }, [method, dateKey]);

  useEffect(() => {
    // Only full-load if no cache
    if (cachedData && cachedData.method === method && cachedData.dateKey === dateKey) {
      setData(cachedData.data);
      setLocation(cachedLocation);
      setLoading(false);
      return;
    }
    load();
  }, [method]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const changeMethod = useCallback((newMethod: number) => {
    if (newMethod === method) return;
    setMethod(newMethod);
    setMethodLoading(true);
    // Cache will be invalidated because method changed
    cachedData = null;
  }, [method]);

  const nextPrayer = data ? getNextPrayer(data.timings) : null;
  const progress = data ? getPrayerProgress(data.timings) : 0;
  const prayerKeys: (keyof PrayerTimes)[] = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

  if (loading && !data) {
    return (
      <View style={[s.container, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#10B981" />
        <Text style={{ color: '#64748B', fontSize: 12, marginTop: 12 }}>Standort wird ermittelt...</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />}
      >
        {/* Location */}
        {location && (
          <View style={s.location}>
            <View style={s.locIcon}>
              <Feather name="map-pin" size={16} color="#3B82F6" />
            </View>
            <View style={s.locInfo}>
              <Text style={s.locCity}>{location.city ?? 'Unbekannt'}</Text>
              <Text style={s.locDetail}>{location.country ?? ''} · GPS aktiv</Text>
            </View>
          </View>
        )}

        {/* Next Prayer Hero */}
        {nextPrayer && data && (
          <View style={s.hero}>
            <View style={s.heroLabel}><Text style={s.heroLabelText}>Nächstes Gebet</Text></View>
            <View style={s.heroRow}>
              <View style={s.heroIcon}>
                {PRAYER_ICONS[nextPrayer.name]
                  ? <Image source={PRAYER_ICONS[nextPrayer.name]} style={s.prayerIcon} resizeMode="cover" />
                  : <Text style={{ fontSize: 24 }}>{PRAYER_NAMES[nextPrayer.name]?.emoji ?? '☀️'}</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <View style={s.heroMain}>
                  <Text style={s.heroName}>{nextPrayer.name}</Text>
                  <Text style={s.heroTime}>{nextPrayer.time}</Text>
                </View>
                <Text style={s.heroArabic}>{PRAYER_NAMES[nextPrayer.name]?.ar ?? ''}</Text>
              </View>
              <View>
                <Text style={s.heroRemain}>In {formatRemaining(nextPrayer.remainingMs)}</Text>
              </View>
            </View>
            <View style={s.heroBar}><View style={[s.heroProgress, { width: `${Math.min(progress * 100, 100)}%` }]} /></View>
          </View>
        )}

        {/* Date */}
        {data && (
          <View style={s.dateRow}>
            <Text style={s.dateText}>
              {new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </Text>
            <Text style={s.dateHijri}>
              {data.date.hijri.day}. {data.date.hijri.month.en} {data.date.hijri.year}
            </Text>
          </View>
        )}

        {/* All Prayer Times */}
        {data && (
          <View style={s.list}>
            <Text style={s.listTitle}>Heute</Text>
            {methodLoading && (
              <View style={{ alignItems: 'center', padding: 20 }}>
                <ActivityIndicator size="small" color="#10B981" />
              </View>
            )}
            {!methodLoading && prayerKeys.map(key => {
              const time = data.timings[key].replace(/\s*\(.*\)/, '').trim();
              const passed = hasPassed(data.timings[key]);
              const isNext = nextPrayer?.name === key;
              const info = PRAYER_NAMES[key];
              return (
                <View key={key} style={[s.row, isNext && s.rowActive, passed && !isNext && s.rowPassed]}>
                  <View style={[s.rowIcon, { backgroundColor: isNext ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.03)' }]}>
                    {PRAYER_ICONS[key]
                      ? <Image source={PRAYER_ICONS[key]} style={s.prayerIconSmall} resizeMode="cover" />
                      : <Text style={{ fontSize: 16 }}>{info.emoji}</Text>}
                  </View>
                  <View style={s.rowInfo}>
                    <Text style={[s.rowName, isNext && { color: '#10B981' }]}>{info.de}</Text>
                    <Text style={s.rowArabic}>{info.ar}</Text>
                  </View>
                  <Text style={[s.rowTime, isNext && { color: '#10B981' }, passed && !isNext && { color: '#475569' }]}>{time}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Calculation Method */}
        <View style={s.methodSection}>
          <Text style={s.listTitle}>Berechnungsmethode</Text>
          <View style={s.methodRow}>
            {METHODS.map(m => (
              <TouchableOpacity
                key={m.id}
                style={[s.methodChip, method === m.id && s.methodActive]}
                onPress={() => changeMethod(m.id)}
              >
                <Text style={[s.methodText, method === m.id && s.methodTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Azān Settings */}
        <View style={s.adhanSection}>
          <Text style={s.listTitle}>Azān Gebetsruf</Text>

          {/* Enable/Disable toggle */}
          <View style={s.adhanToggleRow}>
            <Feather name="bell" size={16} color={adhanOn ? '#10B981' : '#475569'} />
            <View style={{ flex: 1 }}>
              <Text style={s.adhanToggleLabel}>Azān Benachrichtigung</Text>
              <Text style={s.adhanToggleSub}>Klingelt bei Gebetszeit wie ein Anruf</Text>
            </View>
            <TouchableOpacity
              style={[s.toggle, adhanOn && s.toggleOn]}
              onPress={() => {
                const next = !adhanOn;
                setAdhanOn(next);
                setAdhanEnabled(next);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              activeOpacity={0.7}
            >
              <View style={[s.toggleThumb, adhanOn && s.toggleThumbOn]} />
            </TouchableOpacity>
          </View>

          {/* Fajr Wecker toggle */}
          {adhanOn && (
            <View style={s.adhanToggleRow}>
              <Feather name="clock" size={16} color={fajrWeckerOn ? '#F59E0B' : '#475569'} />
              <View style={{ flex: 1 }}>
                <Text style={s.adhanToggleLabel}>Fajr Wecker</Text>
                <Text style={s.adhanToggleSub}>Morgengebet spielt automatisch laut</Text>
              </View>
              <TouchableOpacity
                style={[s.toggle, fajrWeckerOn && s.toggleOnWecker]}
                onPress={() => {
                  const next = !fajrWeckerOn;
                  setFajrWeckerOn(next);
                  setFajrWecker(next);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                activeOpacity={0.7}
              >
                <View style={[s.toggleThumb, fajrWeckerOn && s.toggleThumbOn]} />
              </TouchableOpacity>
            </View>
          )}

          {/* Adhan selector */}
          {adhanOn && (
            <View style={s.adhanList}>
              {ADHAN_OPTIONS.map(opt => {
                const selected = adhanId === opt.id;
                const isPlaying = previewing === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[s.adhanRow, selected && s.adhanRowSelected]}
                    onPress={() => {
                      setAdhanId(opt.id);
                      setSelectedAdhan(opt.id);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={[s.adhanRadio, selected && s.adhanRadioSelected]}>
                      {selected && <View style={s.adhanRadioDot} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.adhanName, selected && { color: '#10B981' }]}>{opt.name}</Text>
                      <Text style={s.adhanReciter}>{opt.reciter}</Text>
                    </View>
                    <TouchableOpacity
                      style={s.adhanPlayBtn}
                      onPress={async () => {
                        if (isPlaying) {
                          await stopAdhan();
                          setPreviewing(null);
                        } else {
                          setPreviewing(opt.id);
                          await previewAdhan(opt.id);
                          setTimeout(() => setPreviewing(null), 10000);
                        }
                      }}
                      hitSlop={8}
                    >
                      <Feather name={isPlaying ? 'pause' : 'play'} size={14} color={isPlaying ? '#10B981' : '#94A3B8'} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Test Button (Dev) */}
          {adhanOn && (
            <TouchableOpacity
              style={s.testBtn}
              onPress={async () => {
                if (testCountdown !== null) return;
                const next = nextPrayer;
                const pName = next?.name ? (PRAYER_NAMES[next.name]?.de ?? 'Asr') : 'Asr';
                const pTime = next?.time ?? '15:47';
                const pArabic = next?.name ? (PRAYER_NAMES[next.name]?.ar ?? 'العصر') : 'العصر';

                const testWecker = fajrWeckerOn && next?.name === 'Fajr';
                await scheduleTestAdhan(pName, pTime, pArabic, 10, testWecker);
                setTestCountdown(10);

                const timer = setInterval(() => {
                  setTestCountdown(prev => {
                    if (prev === null || prev <= 1) {
                      clearInterval(timer);
                      return null;
                    }
                    return prev - 1;
                  });
                }, 1000);
              }}
              activeOpacity={0.7}
              disabled={testCountdown !== null}
            >
              <Feather name="bell" size={14} color={testCountdown !== null ? '#475569' : '#F59E0B'} />
              <Text style={[s.testBtnText, testCountdown !== null && { color: '#475569' }]}>
                {testCountdown !== null ? `Azān in ${testCountdown}s...` : 'Test Azān (10s Countdown)'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Test Adhan Alert Modal */}
      <AdhanAlert
        visible={!!testAlert}
        prayerName={testAlert?.name ?? ''}
        prayerTime={testAlert?.time ?? ''}
        prayerArabic={testAlert?.arabic ?? ''}
        wecker={testAlert?.wecker}
        onLoud={async () => {
          if (!testAlert?.wecker) {
            setTestAlert(null);
            await playAdhan(adhanId);
          } else {
            await playAdhan(adhanId, () => setTestAlert(null));
          }
        }}
        onSilent={() => {
          setTestAlert(null);
          stopAdhan();
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  location: { marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 14, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', flexDirection: 'row', alignItems: 'center', gap: 10 },
  locIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(59,130,246,0.1)', alignItems: 'center', justifyContent: 'center' },
  locInfo: { flex: 1 },
  locCity: { fontSize: 13, fontWeight: '600', color: colors.text },
  locDetail: { fontSize: 10, color: '#64748B', marginTop: 1 },

  hero: { margin: 14, marginHorizontal: 16, padding: 16, borderRadius: 16, backgroundColor: 'rgba(16,185,129,0.04)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.12)' },
  heroLabel: { marginBottom: 8 },
  heroLabelText: { fontSize: 10, color: '#10B981', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700' },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroIcon: { width: 54, height: 54, borderRadius: 15, backgroundColor: 'rgba(16,185,129,0.1)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  prayerIcon: { width: 54, height: 54, borderRadius: 15 },
  prayerIconSmall: { width: 32, height: 32, borderRadius: 10 },
  heroMain: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  heroName: { fontSize: 24, fontWeight: '800', color: colors.text },
  heroTime: { fontSize: 24, fontWeight: '700', fontFamily: fonts.mono, color: '#10B981' },
  heroArabic: { fontSize: 12, color: '#64748B', marginTop: 2 },
  heroRemain: { fontSize: 11, color: '#64748B', textAlign: 'right' },
  heroBar: { height: 4, borderRadius: 2, backgroundColor: '#243044', marginTop: 12, overflow: 'hidden' },
  heroProgress: { height: '100%', borderRadius: 2, backgroundColor: '#10B981' },

  dateRow: { marginHorizontal: 16, padding: 10, borderRadius: 12, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateText: { fontSize: 11, color: '#94A3B8' },
  dateHijri: { fontSize: 11, color: '#10B981', fontWeight: '600' },

  list: { margin: 16 },
  listTitle: { fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700', marginBottom: 8, paddingLeft: 4 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 4, gap: 12 },
  rowActive: { backgroundColor: 'rgba(16,185,129,0.06)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)' },
  rowPassed: { opacity: 0.4 },
  rowIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 14, fontWeight: '600', color: colors.text },
  rowArabic: { fontSize: 10, color: '#64748B', marginTop: 1 },
  rowTime: { fontSize: 15, fontWeight: '700', fontFamily: fonts.mono, color: colors.text },

  methodSection: { margin: 16, marginTop: 4, marginBottom: 30 },
  methodRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  methodChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044' },
  methodActive: { borderColor: 'rgba(16,185,129,0.25)', backgroundColor: 'rgba(16,185,129,0.06)' },
  methodText: { fontSize: 11, color: '#64748B', fontWeight: '600' },
  methodTextActive: { color: '#10B981' },

  // Azān
  adhanSection: { margin: 16, marginTop: 4, marginBottom: 30 },
  adhanToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', marginBottom: 10 },
  adhanToggleLabel: { fontSize: 12, fontWeight: '600', color: colors.text },
  adhanToggleSub: { fontSize: 9, color: '#64748B', marginTop: 1 },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#243044', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#10B981' },
  toggleOnWecker: { backgroundColor: '#F59E0B' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#F8FAFC', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2, elevation: 2 },
  toggleThumbOn: { alignSelf: 'flex-end' },
  adhanList: { gap: 4 },
  adhanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044' },
  adhanRowSelected: { borderColor: 'rgba(16,185,129,0.2)', backgroundColor: 'rgba(16,185,129,0.03)' },
  adhanRadio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#334155', alignItems: 'center', justifyContent: 'center' },
  adhanRadioSelected: { borderColor: '#10B981' },
  adhanRadioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#10B981' },
  adhanName: { fontSize: 12, fontWeight: '600', color: colors.text },
  adhanReciter: { fontSize: 9, color: '#64748B', marginTop: 1 },
  adhanPlayBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#243044', alignItems: 'center', justifyContent: 'center' },

  // Test button
  testBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.15)' },
  testBtnText: { fontSize: 12, fontWeight: '600', color: '#F59E0B' },
});
