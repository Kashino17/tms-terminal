import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Animated,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme';
import type { ToolSection } from '../store/orbLayoutStore';

// ── Tool icon definitions ──────────────────────────────────────────────────────
const TOOL_ICON_MAP: Record<string, { icon: string; color: string; label: string }> = {
  ports:        { icon: 'share-2',      color: '#10B981', label: 'Ports' },
  processes:    { icon: 'activity',     color: '#06B6D4', label: 'Prozesse' },
  sql:          { icon: 'database',     color: '#3B82F6', label: 'SQL' },
  render:       { icon: 'box',          color: '#6366F1', label: 'Render' },
  vercel:       { icon: 'triangle',     color: '#F8FAFC', label: 'Vercel' },
  supabase:     { icon: 'layers',       color: '#3ECF8E', label: 'Supabase' },
  autoApprove:  { icon: 'check-circle', color: '#22C55E', label: 'Approve' },
  snippets:     { icon: 'zap',          color: '#F59E0B', label: 'Snippets' },
  autopilot:    { icon: 'play-circle',  color: '#A78BFA', label: 'Autopilot' },
  watchers:     { icon: 'bell',         color: '#F59E0B', label: 'Watchers' },
  files:        { icon: 'folder',       color: '#F59E0B', label: 'Dateien' },
  screenshots:  { icon: 'camera',       color: '#06B6D4', label: 'Shots' },
  drawing:      { icon: 'edit-2',       color: '#F59E0B', label: 'Zeichnen' },
  browser:      { icon: 'globe',        color: '#22C55E', label: 'Browser' },
};

// ── Props ──────────────────────────────────────────────────────────────────────
interface ToolMenuProps {
  visible: boolean;
  anchorPosition: { x: number; y: number };
  sections: ToolSection[];
  onSelectTool: (toolId: string) => void;
  onClose: () => void;
  onSectionsChange: (sections: ToolSection[]) => void;
}

const MAX_SECTIONS = 5;
const MENU_WIDTH = 300;
const MENU_MAX_HEIGHT = 480;

export function ToolMenu({
  visible,
  anchorPosition,
  sections,
  onSelectTool,
  onClose,
  onSectionsChange,
}: ToolMenuProps) {
  const [editMode, setEditMode] = useState(false);
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const scaleAnim = useRef(new Animated.Value(0.94)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  // Wobble animation for edit mode
  const wobbleAnim = useRef(new Animated.Value(0)).current;
  const wobbleLoop = useRef<Animated.CompositeAnimation | null>(null);

  // ── Entry animation ────────────────────────────────────────────────────────
  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0.94);
      opacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          stiffness: 300,
          damping: 22,
          mass: 0.8,
          useNativeDriver: true,
        }),
        Animated.spring(opacityAnim, {
          toValue: 1,
          stiffness: 300,
          damping: 22,
          mass: 0.8,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Reset on close
      setEditMode(false);
      setRenamingSectionId(null);
      wobbleAnim.setValue(0);
      if (wobbleLoop.current) {
        wobbleLoop.current.stop();
        wobbleLoop.current = null;
      }
    }
  }, [visible, scaleAnim, opacityAnim, wobbleAnim]);

  // ── Wobble loop for edit mode ──────────────────────────────────────────────
  useEffect(() => {
    if (editMode) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(wobbleAnim, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }),
          Animated.timing(wobbleAnim, {
            toValue: -1,
            duration: 240,
            useNativeDriver: true,
          }),
          Animated.timing(wobbleAnim, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
          }),
        ]),
      );
      wobbleLoop.current = loop;
      loop.start();
      return () => {
        loop.stop();
        wobbleAnim.setValue(0);
      };
    }
    wobbleAnim.setValue(0);
  }, [editMode, wobbleAnim]);

  // ── Edit mode handlers ─────────────────────────────────────────────────────
  const enterEditMode = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setEditMode(true);
  }, []);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setRenamingSectionId(null);
  }, []);

  const handleRemoveTool = useCallback(
    (sectionId: string, toolId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const updated = sections.map((s) =>
        s.id === sectionId
          ? { ...s, toolIds: s.toolIds.filter((t) => t !== toolId) }
          : s,
      );
      onSectionsChange(updated);
    },
    [sections, onSectionsChange],
  );

  const handleRemoveSection = useCallback(
    (sectionId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onSectionsChange(sections.filter((s) => s.id !== sectionId));
    },
    [sections, onSectionsChange],
  );

  const handleAddSection = useCallback(() => {
    if (sections.length >= MAX_SECTIONS) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const newSection: ToolSection = {
      id: 'sec_' + Date.now(),
      title: 'Neue Kategorie',
      toolIds: [],
    };
    onSectionsChange([...sections, newSection]);
  }, [sections, onSectionsChange]);

  const startRename = useCallback((sectionId: string, currentTitle: string) => {
    setRenamingSectionId(sectionId);
    setRenameValue(currentTitle);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingSectionId == null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0) {
      const updated = sections.map((s) =>
        s.id === renamingSectionId ? { ...s, title: trimmed } : s,
      );
      onSectionsChange(updated);
    }
    setRenamingSectionId(null);
    setRenameValue('');
  }, [renamingSectionId, renameValue, sections, onSectionsChange]);

  const handleToolPress = useCallback(
    (toolId: string) => {
      if (editMode) return; // taps do nothing in edit mode
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onSelectTool(toolId);
    },
    [editMode, onSelectTool],
  );

  // ── Wobble interpolation ───────────────────────────────────────────────────
  const wobbleRotate = wobbleAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['-1.5deg', '0deg', '1.5deg'],
  });

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      {/* Overlay — tap to close */}
      <Pressable style={styles.overlay} onPress={onClose}>
        {/* Menu container — prevent tap-through */}
        <Animated.View
          style={[
            styles.menu,
            {
              right: 12,
              bottom: 80,
              opacity: opacityAnim,
              transform: [{ scale: scaleAnim }],
            },
          ]}
        >
          <Pressable>
            {/* ── Edit bar ──────────────────────────────────────────── */}
            {editMode && (
              <View style={styles.editBar}>
                <Text style={styles.editBarText}>Tools bearbeiten</Text>
                <TouchableOpacity
                  onPress={exitEditMode}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.editBarDone}>Fertig</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Scrollable sections ───────────────────────────────── */}
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {sections.map((section) => (
                <View key={section.id} style={styles.section}>
                  {/* Section header */}
                  <View style={styles.sectionHeader}>
                    {renamingSectionId === section.id ? (
                      <TextInput
                        style={styles.sectionTitleInput}
                        value={renameValue}
                        onChangeText={setRenameValue}
                        onBlur={commitRename}
                        onSubmitEditing={commitRename}
                        autoFocus
                        selectTextOnFocus
                        returnKeyType="done"
                        blurOnSubmit
                      />
                    ) : (
                      <TouchableOpacity
                        onPress={
                          editMode
                            ? () => startRename(section.id, section.title)
                            : undefined
                        }
                        activeOpacity={editMode ? 0.6 : 1}
                        disabled={!editMode}
                      >
                        <Text style={styles.sectionTitle}>{section.title}</Text>
                      </TouchableOpacity>
                    )}
                    {editMode && (
                      <TouchableOpacity
                        onPress={() => handleRemoveSection(section.id)}
                        activeOpacity={0.6}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Feather name="x" size={14} color={colors.destructive} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Tool grid */}
                  <View style={styles.toolGrid}>
                    {section.toolIds.map((toolId) => {
                      const def = TOOL_ICON_MAP[toolId];
                      if (!def) return null;

                      return (
                        <Animated.View
                          key={toolId}
                          style={[
                            styles.toolItem,
                            editMode && { transform: [{ rotate: wobbleRotate }] },
                          ]}
                        >
                          <TouchableOpacity
                            style={styles.toolItemInner}
                            onPress={() => handleToolPress(toolId)}
                            onLongPress={enterEditMode}
                            delayLongPress={600}
                            activeOpacity={0.7}
                            accessibilityLabel={def.label}
                            accessibilityRole="button"
                          >
                            <Feather
                              name={def.icon as any}
                              size={20}
                              color={def.color}
                            />
                            <Text style={styles.toolLabel} numberOfLines={1}>
                              {def.label}
                            </Text>
                          </TouchableOpacity>
                          {/* Remove badge in edit mode */}
                          {editMode && (
                            <TouchableOpacity
                              style={styles.removeBadge}
                              onPress={() => handleRemoveTool(section.id, toolId)}
                              activeOpacity={0.6}
                              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                            >
                              <Feather name="x" size={10} color="#fff" />
                            </TouchableOpacity>
                          )}
                        </Animated.View>
                      );
                    })}
                  </View>
                </View>
              ))}

              {/* ── Add section button ─────────────────────────────── */}
              {editMode && sections.length < MAX_SECTIONS && (
                <TouchableOpacity
                  style={styles.addSectionBtn}
                  onPress={handleAddSection}
                  activeOpacity={0.7}
                >
                  <Text style={styles.addSectionText}>+ Neue Kategorie</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    maxHeight: MENU_MAX_HEIGHT,
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    // Shadow for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 20,
  },

  // ── Edit bar ───────────────────────────────────────────────────────────────
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  editBarText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  editBarDone: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },

  // ── Scroll ─────────────────────────────────────────────────────────────────
  scrollArea: {
    maxHeight: MENU_MAX_HEIGHT - 44, // leave room for edit bar
  },
  scrollContent: {
    padding: 12,
    paddingTop: 8,
  },

  // ── Section ────────────────────────────────────────────────────────────────
  section: {
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: '700',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionTitleInput: {
    flex: 1,
    fontSize: 9,
    fontWeight: '700',
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary,
    paddingVertical: 2,
    paddingHorizontal: 0,
    marginRight: 8,
  },

  // ── Tool grid ──────────────────────────────────────────────────────────────
  toolGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },

  // ── Tool item ──────────────────────────────────────────────────────────────
  toolItem: {
    width: 56,
    position: 'relative',
  },
  toolItemInner: {
    width: 56,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  toolLabel: {
    fontSize: 8,
    color: colors.textMuted,
    textAlign: 'center',
    fontWeight: '500',
  },

  // ── Remove badge ──────────────────────────────────────────────────────────
  removeBadge: {
    position: 'absolute',
    top: -4,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },

  // ── Add section ───────────────────────────────────────────────────────────
  addSectionBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderStyle: 'dashed',
  },
  addSectionText: {
    fontSize: 11,
    color: colors.textDim,
    fontWeight: '600',
  },
});
