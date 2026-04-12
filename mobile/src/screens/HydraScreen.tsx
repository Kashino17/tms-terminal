import React, { useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, StyleSheet, Animated, Easing, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../theme';
import { useHydraStore, BAD_DRINK_INFO, WATER_IMAGE, type BadDrinkType, type DayLog } from '../store/hydraStore';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation.types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList> };

// ── Feedback Overlay ─────────────────────────────────────────────────────────
function FeedbackOverlay({ type, amount, visible }: { type: 'gain' | 'loss'; amount: number; visible: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.8)).current;

  React.useEffect(() => {
    if (visible) {
      opacity.setValue(1);
      scale.setValue(0.8);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 1500, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1.2, tension: 80, friction: 6, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <Animated.View style={[
      s.feedbackOverlay,
      { opacity, transform: [{ scale }], backgroundColor: type === 'gain' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)' },
    ]} pointerEvents="none">
      <Text style={[s.feedbackText, { color: type === 'gain' ? '#10B981' : '#EF4444' }]}>
        {type === 'gain' ? `+${amount} ❤️` : `-${amount} 💔`}
      </Text>
      <Text style={[s.feedbackSub, { color: type === 'gain' ? '#10B981' : '#EF4444' }]}>
        {type === 'gain' ? 'Lebenspunkt!' : 'Lebenspunkte verloren!'}
      </Text>
    </Animated.View>
  );
}

// ── Calendar View ────────────────────────────────────────────────────────────
function CalendarView({ year, month, logs }: { year: number; month: number; logs: DayLog[] }) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1; // Monday first

  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  const cells: (DayLog | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const log = logs.find(l => l.date === dateKey);
    cells.push(log ?? { date: dateKey, waterCount: 0, badDrinks: [], hpGained: 0, hpLost: 0 });
  }

  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();

  return (
    <View style={s.calendar}>
      <Text style={s.calendarTitle}>{monthNames[month - 1]} {year}</Text>
      <View style={s.calendarDayNames}>
        {dayNames.map(d => <Text key={d} style={s.calendarDayName}>{d}</Text>)}
      </View>
      <View style={s.calendarGrid}>
        {cells.map((cell, i) => {
          if (!cell) return <View key={`e${i}`} style={s.calendarCell} />;
          const day = parseInt(cell.date.split('-')[2]);
          const isToday = cell.date === todayKey;
          const net = cell.hpGained - cell.hpLost;
          const hasData = cell.waterCount > 0 || cell.badDrinks.length > 0;
          return (
            <View key={cell.date} style={[s.calendarCell, isToday && s.calendarCellToday]}>
              <Text style={[s.calendarDay, isToday && { color: '#10B981' }]}>{day}</Text>
              {hasData && (
                <Text style={[s.calendarHP, { color: net >= 0 ? '#10B981' : '#EF4444' }]}>
                  {net >= 0 ? `+${net}` : net}
                </Text>
              )}
              {hasData && (
                <Text style={s.calendarWater}>💧{cell.waterCount}</Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Main Screen ──────────────────────────────────────────────────────────────
export function HydraScreen({ navigation }: Props) {
  const { totalHP, drinkWater, undoWater, drinkBad, getToday, getMonthLogs } = useHydraStore();
  const today = getToday();

  const [feedback, setFeedback] = useState<{ type: 'gain' | 'loss'; amount: number; key: number } | null>(null);
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [showCalendar, setShowCalendar] = useState(false);

  const shakeAnim = useRef(new Animated.Value(0)).current;

  const showFeedback = useCallback((type: 'gain' | 'loss', amount: number) => {
    setFeedback({ type, amount, key: Date.now() });
    if (type === 'loss') {
      // Shake animation
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setTimeout(() => setFeedback(null), 1500);
  }, []);

  const handleDrinkWater = useCallback(() => {
    if (today.waterCount >= 6) return;
    const wasOnBoundary = (today.waterCount + 1) % 2 === 0;
    drinkWater();
    if (wasOnBoundary) showFeedback('gain', 1);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [today.waterCount, drinkWater, showFeedback]);

  const handleDrinkBad = useCallback((type: BadDrinkType) => {
    const info = BAD_DRINK_INFO[type];
    const hpLoss = Math.max(1, Math.floor(totalHP * info.penalty));
    Alert.alert(
      `${info.label} trinken?`,
      `Du verlierst ${hpLoss} Lebenspunkt${hpLoss !== 1 ? 'e' : ''} (-${info.penalty * 100}% HP).\n\nDas kann nicht rückgängig gemacht werden!`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: `Ja, -${hpLoss} HP`,
          style: 'destructive',
          onPress: () => {
            drinkBad(type);
            showFeedback('loss', hpLoss);
          },
        },
      ],
    );
  }, [totalHP, drinkBad, showFeedback]);

  const bottles = Array.from({ length: 6 }, (_, i) => i < today.waterCount);
  const liters = today.waterCount * 0.5;
  const monthLogs = getMonthLogs(calYear, calMonth);

  return (
    <Animated.View style={[s.container, { transform: [{ translateX: shakeAnim }] }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 30 }}>
        {/* HP Display */}
        <View style={s.hpSection}>
          <Text style={s.hpLabel}>Lebenspunkte</Text>
          <View style={s.hpRow}>
            <Text style={s.hpEmoji}>❤️</Text>
            <Text style={s.hpValue}>{totalHP}</Text>
            <Text style={s.hpUnit}>HP</Text>
          </View>
        </View>

        {/* Water Section */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Wasser · {liters}L / 3L</Text>
            <Text style={s.sectionSub}>+1 ❤️ pro Liter</Text>
          </View>

          {/* Required 2L (4 bottles) */}
          <View style={s.bottleRow}>
            {bottles.slice(0, 4).map((filled, i) => (
              <TouchableOpacity
                key={i}
                style={[s.bottle, filled && s.bottleFilled]}
                onPress={filled ? undoWater : handleDrinkWater}
                activeOpacity={0.7}
              >
                <Image source={WATER_IMAGE} style={[s.bottleImg, !filled && s.bottleImgEmpty]} resizeMode="contain" />
                <Text style={s.bottleLabel}>500ml</Text>
                {filled && <View style={s.bottleCheck}><Text style={{ fontSize: 10 }}>✓</Text></View>}
              </TouchableOpacity>
            ))}
          </View>

          {/* Optional 1L (2 bottles) */}
          <View style={s.optionalRow}>
            <Text style={s.optionalLabel}>Optional +1L</Text>
            <View style={s.bottleRow}>
              {bottles.slice(4, 6).map((filled, i) => (
                <TouchableOpacity
                  key={i + 4}
                  style={[s.bottle, s.bottleSmall, filled && s.bottleFilled]}
                  onPress={filled ? undoWater : handleDrinkWater}
                  activeOpacity={0.7}
                >
                  <Image source={WATER_IMAGE} style={[s.bottleImgSmall, !filled && s.bottleImgEmpty]} resizeMode="contain" />
                  <Text style={s.bottleLabel}>500ml</Text>
                  {filled && <View style={s.bottleCheck}><Text style={{ fontSize: 10 }}>✓</Text></View>}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Bad Drinks Section */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={[s.sectionTitle, { color: '#EF4444' }]}>Ungesunde Getränke</Text>
            <Text style={[s.sectionSub, { color: '#EF4444' }]}>Ziehen % der HP ab</Text>
          </View>

          <View style={s.badGrid}>
            {(Object.keys(BAD_DRINK_INFO) as BadDrinkType[]).map(type => {
              const info = BAD_DRINK_INFO[type];
              const todayCount = today.badDrinks.find(d => d.type === type)?.count ?? 0;
              return (
                <TouchableOpacity
                  key={type}
                  style={s.badCard}
                  onPress={() => handleDrinkBad(type)}
                  activeOpacity={0.7}
                >
                  <Image source={info.image} style={s.badImg} resizeMode="contain" />
                  <Text style={s.badName}>{info.label}</Text>
                  <Text style={s.badPenalty}>-{info.penalty * 100}% HP</Text>
                  {todayCount > 0 && (
                    <View style={s.badBadge}><Text style={s.badBadgeText}>{todayCount}</Text></View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Today Summary */}
        <View style={s.summary}>
          <Text style={s.summaryTitle}>Heute</Text>
          <View style={s.summaryRow}>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#10B981' }]}>+{today.hpGained}</Text>
              <Text style={s.summaryLabel}>gewonnen</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#EF4444' }]}>-{today.hpLost}</Text>
              <Text style={s.summaryLabel}>verloren</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: today.hpGained - today.hpLost >= 0 ? '#10B981' : '#EF4444' }]}>
                {today.hpGained - today.hpLost >= 0 ? '+' : ''}{today.hpGained - today.hpLost}
              </Text>
              <Text style={s.summaryLabel}>netto</Text>
            </View>
          </View>
        </View>

        {/* Calendar Toggle */}
        <TouchableOpacity
          style={s.calToggle}
          onPress={() => setShowCalendar(v => !v)}
          activeOpacity={0.7}
        >
          <Feather name="calendar" size={16} color="#3B82F6" />
          <Text style={s.calToggleText}>{showCalendar ? 'Kalender schließen' : 'Historie anzeigen'}</Text>
          <Feather name={showCalendar ? 'chevron-up' : 'chevron-down'} size={14} color="#475569" />
        </TouchableOpacity>

        {/* Calendar */}
        {showCalendar && (
          <View>
            <View style={s.calNav}>
              <TouchableOpacity onPress={() => {
                if (calMonth === 1) { setCalMonth(12); setCalYear(y => y - 1); }
                else setCalMonth(m => m - 1);
              }}>
                <Feather name="chevron-left" size={20} color="#94A3B8" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => {
                if (calMonth === 12) { setCalMonth(1); setCalYear(y => y + 1); }
                else setCalMonth(m => m + 1);
              }}>
                <Feather name="chevron-right" size={20} color="#94A3B8" />
              </TouchableOpacity>
            </View>
            <CalendarView year={calYear} month={calMonth} logs={monthLogs} />
          </View>
        )}
      </ScrollView>

      {/* Feedback Overlay */}
      {feedback && (
        <FeedbackOverlay type={feedback.type} amount={feedback.amount} visible={true} key={feedback.key} />
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // HP
  hpSection: { alignItems: 'center', paddingTop: 12, paddingBottom: 16 },
  hpLabel: { fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700' },
  hpRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  hpEmoji: { fontSize: 24 },
  hpValue: { fontSize: 36, fontWeight: '800', color: '#EF4444', fontFamily: fonts.mono },
  hpUnit: { fontSize: 14, color: '#64748B', fontWeight: '600', marginTop: 8 },

  // Sections
  section: { marginHorizontal: 16, marginBottom: 16, padding: 14, borderRadius: 16, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  sectionSub: { fontSize: 10, color: '#10B981', fontWeight: '600' },

  // Bottles
  bottleRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  bottle: { width: 70, alignItems: 'center', padding: 8, borderRadius: 12, backgroundColor: '#243044', borderWidth: 1, borderColor: '#334155', position: 'relative' },
  bottleSmall: { width: 65 },
  bottleFilled: { borderColor: '#10B981', backgroundColor: 'rgba(16,185,129,0.06)' },
  bottleImg: { width: 40, height: 60 },
  bottleImgSmall: { width: 35, height: 52 },
  bottleImgEmpty: { opacity: 0.3 },
  bottleLabel: { fontSize: 9, color: '#64748B', marginTop: 4, fontWeight: '600' },
  bottleCheck: { position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 9, backgroundColor: '#10B981', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#1B2336' },

  optionalRow: { marginTop: 12, alignItems: 'center' },
  optionalLabel: { fontSize: 10, color: '#475569', marginBottom: 6, fontWeight: '600' },

  // Bad drinks
  badGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  badCard: { width: '30%', alignItems: 'center', padding: 8, borderRadius: 12, backgroundColor: '#243044', borderWidth: 1, borderColor: '#334155', position: 'relative' },
  badImg: { width: 36, height: 54 },
  badName: { fontSize: 9, color: '#94A3B8', marginTop: 4, fontWeight: '600', textAlign: 'center' },
  badPenalty: { fontSize: 9, color: '#EF4444', fontWeight: '700', marginTop: 2 },
  badBadge: { position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 2, borderColor: '#1B2336' },
  badBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff' },

  // Summary
  summary: { marginHorizontal: 16, padding: 14, borderRadius: 14, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', marginBottom: 12 },
  summaryTitle: { fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700', marginBottom: 8 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-around' },
  summaryItem: { alignItems: 'center' },
  summaryVal: { fontSize: 18, fontWeight: '800', fontFamily: fonts.mono },
  summaryLabel: { fontSize: 9, color: '#64748B', marginTop: 2 },

  // Calendar toggle
  calToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 16, padding: 10, borderRadius: 12, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', marginBottom: 12 },
  calToggleText: { fontSize: 12, color: '#3B82F6', fontWeight: '600' },

  // Calendar nav
  calNav: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 4 },

  // Calendar
  calendar: { marginHorizontal: 16, padding: 12, borderRadius: 14, backgroundColor: '#1B2336', borderWidth: 1, borderColor: '#243044', marginBottom: 16 },
  calendarTitle: { fontSize: 14, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 8 },
  calendarDayNames: { flexDirection: 'row', marginBottom: 4 },
  calendarDayName: { flex: 1, textAlign: 'center', fontSize: 10, color: '#475569', fontWeight: '600' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarCell: { width: '14.28%', alignItems: 'center', paddingVertical: 6, borderRadius: 8 },
  calendarCellToday: { backgroundColor: 'rgba(16,185,129,0.08)' },
  calendarDay: { fontSize: 12, fontWeight: '600', color: '#94A3B8' },
  calendarHP: { fontSize: 8, fontWeight: '700', marginTop: 1 },
  calendarWater: { fontSize: 7, color: '#3B82F6', marginTop: 1 },

  // Feedback overlay
  feedbackOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  feedbackText: { fontSize: 48, fontWeight: '800' },
  feedbackSub: { fontSize: 16, fontWeight: '700', marginTop: 4 },
});
