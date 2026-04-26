import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
  Modal,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../../theme';
import { useOrbLayoutStore } from '../../store/orbLayoutStore';
import {
  ORB_DEFS,
  filterSidebarOrbs,
  allSidebarOrbIds,
} from '../../constants/orbDefinitions';

export type SidebarState = 'collapsed' | 'expanded' | 'hidden';

/**
 * Special action orbs that need a flyout in the sidebar (rather than firing
 * directly). The parent renders the actual flyout body keyed off this id.
 */
export type FlyoutOrbId = 'tools' | 'dpad';

interface SidebarProps {
  state: SidebarState;
  /** Currently flyout-open orb (highlighted), or null. */
  activeOrb: string | null;
  /** Active pane's sessionId — drives whether direct-action orbs are enabled. */
  activeSessionId: string | null;
  /** Cycle the sidebar state (called by chevron at top). */
  onToggleState: () => void;
  /** User tapped an orb. Direct-action orbs fire immediately;
   *  flyout orbs ('tools', 'dpad') should be passed back to the parent. */
  onPickOrb: (orbId: string) => void;
}

/**
 * Manager-Chat left sidebar. Renders the user's persisted dock-order from
 * `orbLayoutStore` so the same orbs that appear on the terminal screen are
 * available here too — and add/remove/reorder is shared state.
 *
 * Three states: collapsed (44 px, icons only), expanded (160 px, icons +
 * labels), hidden (0 px). Long-press an orb to enter edit mode (X to remove);
 * the "+" at the bottom opens a picker to restore removed orbs.
 */
export const ToolSidebar: React.FC<SidebarProps> = ({
  state,
  activeOrb,
  activeSessionId,
  onToggleState,
  onPickOrb,
}) => {
  const dockOrder = useOrbLayoutStore((s) => s.dockOrder);
  const removedIds = useOrbLayoutStore((s) => s.removedOrbIds);
  const removeFromDock = useOrbLayoutStore((s) => s.removeFromDock);
  const addToDock = useOrbLayoutStore((s) => s.addToDock);
  const restoreOrb = useOrbLayoutStore((s) => s.restoreOrb);

  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const orbs = useMemo(() => filterSidebarOrbs(dockOrder), [dockOrder]);
  const addable = useMemo(() => {
    const visible = new Set(orbs);
    return allSidebarOrbIds().filter((id) => !visible.has(id));
  }, [orbs]);

  if (state === 'hidden') return null;
  const expanded = state === 'expanded';

  return (
    <>
      <View style={[s.bar, expanded && s.barExpanded]}>
        <View style={s.headRow}>
          <TouchableOpacity style={s.toggle} onPress={onToggleState} activeOpacity={0.7}>
            <Feather
              name={expanded ? 'chevrons-left' : 'chevrons-right'}
              size={12}
              color={colors.textMuted}
            />
          </TouchableOpacity>
          {expanded && (
            <TouchableOpacity
              style={[s.editBtn, editMode && s.editBtnActive]}
              onPress={() => setEditMode((v) => !v)}
              hitSlop={6}
            >
              <Feather name={editMode ? 'check' : 'edit-2'} size={11} color={editMode ? colors.primary : colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
          {orbs.map((orbId) => {
            const def = ORB_DEFS[orbId];
            if (!def) return null;
            const active = orbId === activeOrb;
            // Direct-action orbs grey out when no pane is selected; flyout orbs
            // (tools / dpad / mic) stay enabled because they don't strictly
            // require an active pane.
            const isFlyout = def.action === 'tools' || def.action === 'dpad' || def.action === 'mic';
            const disabled = !isFlyout && !activeSessionId;

            return (
              <View key={orbId} style={s.orbRow}>
                <Pressable
                  style={[s.orb, active && s.orbActive, disabled && s.orbDisabled]}
                  onPress={() => !disabled && onPickOrb(orbId)}
                  onLongPress={() => setEditMode(true)}
                  delayLongPress={350}
                >
                  <View style={s.iconBox}>
                    {def.icon(36, disabled ? colors.textDim : (active ? colors.primary : def.color))}
                  </View>
                  {expanded && (
                    <Text
                      style={[s.label, active && s.labelActive, disabled && { color: colors.textDim }]}
                      numberOfLines={1}
                    >
                      {def.label}
                    </Text>
                  )}
                </Pressable>
                {editMode && (
                  <TouchableOpacity
                    style={s.removeBtn}
                    onPress={() => removeFromDock(orbId)}
                    hitSlop={6}
                  >
                    <Feather name="x" size={11} color="#fff" />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </ScrollView>

        <TouchableOpacity style={s.addBtn} onPress={() => setPickerOpen(true)}>
          <View style={s.iconBox}>
            <Feather name="plus" size={13} color={colors.textDim} />
          </View>
          {expanded && <Text style={s.addLabel}>Hinzufügen</Text>}
        </TouchableOpacity>
      </View>

      {/* Picker — restore removed or hidden orbs */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable style={s.pickerPanel} onPress={(e) => e.stopPropagation()}>
            <Text style={s.pickerTitle}>Orbs hinzufügen</Text>
            {addable.length === 0 ? (
              <Text style={s.pickerEmpty}>Alle verfügbaren Orbs sind bereits in der Sidebar.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 340 }}>
                {addable.map((orbId) => {
                  const def = ORB_DEFS[orbId];
                  if (!def) return null;
                  return (
                    <TouchableOpacity
                      key={orbId}
                      style={s.pickerRow}
                      onPress={() => {
                        // If the orb was previously removed (in removedOrbIds),
                        // restore it to the free orbs as well so the terminal
                        // screen also shows it again.
                        if (removedIds.includes(orbId)) {
                          restoreOrb(orbId, { xPct: 0.15, yPct: 0.78 });
                        }
                        addToDock(orbId);
                        setPickerOpen(false);
                      }}
                    >
                      <View style={s.pickerIconBox}>{def.icon(36, def.color)}</View>
                      <Text style={s.pickerRowLabel}>{def.label}</Text>
                      <Feather name="plus" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity style={s.pickerClose} onPress={() => setPickerOpen(false)}>
              <Text style={s.pickerCloseText}>Schließen</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

// ── Flyout Panel ─────────────────────────────────────────────────────────────

interface FlyoutProps {
  /** Currently open orb id (null = hidden). */
  orbId: string | null;
  /** Active pane label shown as context (`@<sid>`). */
  contextLabel?: string;
  /** Sidebar state — controls the flyout's left offset. */
  sidebarState: SidebarState;
  onClose: () => void;
  /** Body content (render-prop pattern: caller passes rendered JSX). */
  children: React.ReactNode;
}

/**
 * Flyout panel anchored to the right edge of the ToolSidebar. Caller controls
 * the body content via `children`.
 */
export const ToolFlyout: React.FC<FlyoutProps> = ({
  orbId,
  contextLabel,
  sidebarState,
  onClose,
  children,
}) => {
  if (!orbId || sidebarState === 'hidden') return null;
  const def = ORB_DEFS[orbId];
  // Mirror the sidebar's width so the flyout sits flush against it.
  const left = sidebarState === 'expanded' ? 168 : 50;
  return (
    <View style={[s.flyout, { left }]} pointerEvents="box-none">
      <View style={s.flyoutInner}>
        <View style={s.flyoutHead}>
          <View style={s.flyoutToolIcon}>
            {def && def.icon(28, colors.primary)}
          </View>
          <Text style={s.flyoutTitle}>{def?.label ?? orbId}</Text>
          {contextLabel && (
            <View style={s.flyoutContext}>
              <Text style={s.flyoutContextText}>{contextLabel}</Text>
            </View>
          )}
          <TouchableOpacity style={s.flyoutClose} onPress={onClose}>
            <Feather name="x" size={12} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
        <View style={s.flyoutBody}>{children}</View>
      </View>
    </View>
  );
};

// ── Generic Tool Item (helper for body content) ──────────────────────────────

interface ToolItemProps {
  icon?: string;
  emoji?: string;
  label?: string;
  /** Mono-font command shown in code style. */
  cmd?: string;
  variant?: 'default' | 'warn' | 'danger';
  onPress?: () => void;
}

/** Generic row for tool flyout bodies. Shows icon/emoji + label or command. */
export const ToolItem: React.FC<ToolItemProps> = ({ icon, emoji, label, cmd, variant = 'default', onPress }) => {
  const variantStyle =
    variant === 'warn' ? s.itemWarn :
    variant === 'danger' ? s.itemDanger : null;
  return (
    <TouchableOpacity style={[s.item, variantStyle]} onPress={onPress} activeOpacity={0.6}>
      {icon && (
        <View style={s.itemIconBox}>
          <Feather name={icon as any} size={12} color={colors.textMuted} />
        </View>
      )}
      {emoji && <Text style={s.itemEmoji}>{emoji}</Text>}
      {cmd ? (
        <Text style={s.itemCmd} numberOfLines={1}>{cmd}</Text>
      ) : (
        <Text style={[s.itemLabel, variant !== 'default' && { color: variantColor(variant) }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
};

function variantColor(v: 'warn' | 'danger') {
  return v === 'warn' ? colors.warning : colors.destructive;
}

/** Section header for tool flyouts. */
export const ToolSection: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text style={s.section}>{children}</Text>
);

// ── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  bar: {
    width: 44,
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 4,
  },
  barExpanded: {
    width: 160,
    paddingHorizontal: 6,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  toggle: {
    flex: 1,
    height: 22,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtn: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtnActive: {
    backgroundColor: colors.primary + '26',
  },
  orbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
    marginBottom: 4,
  },
  orb: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  orbActive: {
    backgroundColor: colors.primary + '26',
    borderColor: colors.primary + '4D',
  },
  orbDisabled: {
    opacity: 0.4,
  },
  iconBox: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  labelActive: {
    color: colors.primary,
  },
  removeBtn: {
    position: 'absolute',
    top: 2, right: 2,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
    marginTop: 4,
  },
  addLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textDim,
  },

  // Picker modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  pickerPanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
  },
  pickerEmpty: {
    color: colors.textMuted,
    fontSize: 12,
    paddingVertical: 12,
    textAlign: 'center',
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  pickerIconBox: {
    width: 28, height: 28,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerRowLabel: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  pickerClose: {
    marginTop: 12,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
  },
  pickerCloseText: { color: colors.text, fontSize: 12, fontWeight: '600' },

  // Flyout — zIndex must beat the focused-pane overlay (zIndex 99) so the
  // flyout stays visible when an orb is opened from focus mode.
  flyout: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    width: 230,
    zIndex: 200,
  },
  flyoutInner: {
    flex: 1,
    maxHeight: 320,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.55,
    shadowRadius: 40,
    elevation: 24,
  },
  flyoutHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  flyoutToolIcon: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: colors.primary + '26',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flyoutTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  flyoutContext: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  flyoutContextText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
  },
  flyoutClose: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flyoutBody: {
    flex: 1,
    padding: 6,
  },

  // ToolItem helper
  section: {
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.textDim,
    textTransform: 'uppercase',
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 4,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 7,
  },
  itemWarn: {
    backgroundColor: 'rgba(245,158,11,0.06)',
  },
  itemDanger: {
    backgroundColor: 'rgba(239,68,68,0.06)',
  },
  itemIconBox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemEmoji: {
    fontSize: 14,
    width: 22,
    textAlign: 'center',
  },
  itemLabel: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.text,
  },
  itemCmd: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.info,
  },
});
