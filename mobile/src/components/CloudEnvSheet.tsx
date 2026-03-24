import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  StyleSheet,
  Platform,
  Animated,
  Pressable,
  ScrollView,
} from 'react-native';
import { colors } from '../theme';
import { useResponsive } from '../hooks/useResponsive';
import type { CloudProvider, EnvVar, NewEnvVar } from '../services/cloud.types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  platform: 'render' | 'vercel';
  service: CloudProvider;
  projectId: string;
  envVar?: EnvVar;   // undefined = create mode
  onSaved: () => void;
}

type VercelScope = 'production' | 'preview' | 'development';

const VERCEL_SCOPES: { id: VercelScope; label: string }[] = [
  { id: 'production',  label: 'Production' },
  { id: 'preview',     label: 'Preview' },
  { id: 'development', label: 'Development' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function CloudEnvSheet({ visible, onClose, platform, service, projectId, envVar, onSaved }: Props) {
  const { rf, rs, ri } = useResponsive();

  // Animation
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  // Form state
  const [key,   setKey]   = useState('');
  const [value, setValue] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<VercelScope[]>(['production', 'preview', 'development']);
  const [loading, setLoading] = useState(false);

  const isEditMode = envVar !== undefined;

  // ── Populate on open ───────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      // Reset / populate form
      if (envVar) {
        setKey(envVar.key);
        setValue(envVar.value);
        if (platform === 'vercel') {
          const validScopes = envVar.scope.filter((s): s is VercelScope =>
            ['production', 'preview', 'development'].includes(s),
          );
          setSelectedScopes(validScopes.length > 0 ? validScopes : ['production', 'preview', 'development']);
        }
      } else {
        setKey('');
        setValue('');
        setSelectedScopes(['production', 'preview', 'development']);
      }

      // Slide-up animation
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 120, friction: 14 }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      slideAnim.setValue(0);
      fadeAnim.setValue(0);
    }
  }, [visible, envVar]);

  // ── Dismiss helper ─────────────────────────────────────────────────────────

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  // ── Scope toggle (Vercel only) ─────────────────────────────────────────────

  const toggleScope = (scope: VercelScope) => {
    setSelectedScopes(prev =>
      prev.includes(scope)
        ? prev.filter(s => s !== scope)
        : [...prev, scope],
    );
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const trimmedKey   = key.trim();
    const trimmedValue = value.trim();

    if (!trimmedKey) {
      Alert.alert('Fehler', 'Der Schlüssel darf nicht leer sein.');
      return;
    }
    if (!trimmedValue) {
      Alert.alert('Fehler', 'Der Wert darf nicht leer sein.');
      return;
    }
    if (platform === 'vercel' && selectedScopes.length === 0) {
      Alert.alert('Fehler', 'Mindestens eine Umgebung muss ausgewählt sein.');
      return;
    }

    const envData: NewEnvVar = {
      key:   trimmedKey,
      value: trimmedValue,
      scope: platform === 'render' ? ['all'] : selectedScopes,
    };

    setLoading(true);
    try {
      if (isEditMode && envVar) {
        await service.updateEnvVar(projectId, envVar.id, envData);
      } else {
        await service.createEnvVar(projectId, envData);
      }
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(() => {
        onClose();
        onSaved();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      Alert.alert('Fehler beim Speichern', message);
    } finally {
      setLoading(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = () => {
    if (!envVar) return;
    Alert.alert(
      'Variable löschen',
      `Soll „${envVar.key}" wirklich gelöscht werden?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await service.deleteEnvVar(projectId, envVar.id);
              Animated.parallel([
                Animated.timing(slideAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
                Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
              ]).start(() => {
                onClose();
                onSaved();
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
              Alert.alert('Fehler beim Löschen', message);
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  // ── translateY interpolation ───────────────────────────────────────────────

  const translateY = slideAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [500, 0],
  });

  if (!visible) return null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={loading ? undefined : dismiss}>
        <Animated.View style={[styles.backdropFill, { opacity: fadeAnim }]} />
      </Pressable>

      {/* Sheet */}
      <KeyboardAvoidingView
        style={styles.kavContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <Animated.View
          style={[
            styles.sheet,
            {
              transform: [{ translateY }],
              paddingBottom: rs(Platform.OS === 'ios' ? 34 : 20),
              paddingHorizontal: rs(16),
            },
          ]}
        >
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={[styles.header, { paddingBottom: rs(12) }]}>
            <Text style={[styles.title, { fontSize: rf(16) }]}>
              {isEditMode ? 'Variable bearbeiten' : 'Variable erstellen'}
            </Text>
            <TouchableOpacity onPress={loading ? undefined : dismiss} hitSlop={12} activeOpacity={0.6}>
              <Text style={[styles.closeBtn, { fontSize: rf(13) }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.body}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Key input */}
            <Text style={[styles.label, { fontSize: rf(12), marginBottom: rs(6) }]}>
              SCHLÜSSEL
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  fontSize: rf(13),
                  paddingHorizontal: rs(12),
                  paddingVertical: rs(10),
                  opacity: isEditMode ? 0.5 : 1,
                },
              ]}
              value={key}
              onChangeText={setKey}
              placeholder="z. B. DATABASE_URL"
              placeholderTextColor={colors.textDim}
              editable={!isEditMode && !loading}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="next"
            />

            {/* Value input */}
            <Text style={[styles.label, { fontSize: rf(12), marginTop: rs(14), marginBottom: rs(6) }]}>
              WERT
            </Text>
            <TextInput
              style={[
                styles.input,
                styles.valueInput,
                {
                  fontSize: rf(13),
                  paddingHorizontal: rs(12),
                  paddingVertical: rs(10),
                  minHeight: rs(100),
                },
              ]}
              value={value}
              onChangeText={setValue}
              placeholder="Wert eingeben (auch JSON möglich)"
              placeholderTextColor={colors.textDim}
              editable={!loading}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
            />

            {/* Scope selector */}
            <Text style={[styles.label, { fontSize: rf(12), marginTop: rs(14), marginBottom: rs(8) }]}>
              UMGEBUNGEN
            </Text>

            {platform === 'render' ? (
              // Render: fixed scope, no selection needed
              <View style={[styles.scopeFixed, { paddingHorizontal: rs(12), paddingVertical: rs(10) }]}>
                <Text style={[styles.scopeFixedText, { fontSize: rf(13) }]}>
                  Alle Umgebungen
                </Text>
              </View>
            ) : (
              // Vercel: multi-select checkboxes
              <View style={[styles.scopeRow, { gap: rs(8) }]}>
                {VERCEL_SCOPES.map(({ id, label }) => {
                  const active = selectedScopes.includes(id);
                  return (
                    <TouchableOpacity
                      key={id}
                      style={[
                        styles.scopeChip,
                        {
                          paddingHorizontal: rs(12),
                          paddingVertical: rs(8),
                          borderColor: active ? colors.primary : colors.border,
                          backgroundColor: active ? `${colors.primary}22` : colors.surfaceAlt,
                        },
                      ]}
                      onPress={() => !loading && toggleScope(id)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.scopeChipText,
                          { fontSize: rf(12), color: active ? colors.primary : colors.textMuted },
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Bottom spacing so buttons don't clip content */}
            <View style={{ height: rs(24) }} />
          </ScrollView>

          {/* Action buttons */}
          <View style={[styles.actions, { gap: rs(10), marginTop: rs(12) }]}>
            {isEditMode && (
              <TouchableOpacity
                style={[
                  styles.deleteBtn,
                  { paddingVertical: rs(13), opacity: loading ? 0.5 : 1 },
                ]}
                onPress={handleDelete}
                activeOpacity={0.7}
                disabled={loading}
              >
                <Text style={[styles.deleteBtnText, { fontSize: rf(14) }]}>Löschen</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[
                styles.saveBtn,
                { paddingVertical: rs(13), opacity: loading ? 0.7 : 1 },
              ]}
              onPress={handleSave}
              activeOpacity={0.7}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[styles.saveBtnText, { fontSize: rf(14) }]}>Speichern</Text>
              )}
            </TouchableOpacity>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  kavContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 8,
    maxHeight: '90%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontWeight: '700',
  },
  closeBtn: {
    color: colors.textDim,
    fontWeight: '600',
  },
  body: {
    flexGrow: 0,
  },
  label: {
    color: colors.textDim,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  valueInput: {
    minHeight: 100,
  },
  scopeFixed: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
  },
  scopeFixedText: {
    color: colors.textMuted,
  },
  scopeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  scopeChip: {
    borderWidth: 1,
    borderRadius: 8,
  },
  scopeChipText: {
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
  },
  deleteBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.destructive,
    backgroundColor: `${colors.destructive}18`,
  },
  deleteBtnText: {
    color: colors.destructive,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.primary,
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
});
