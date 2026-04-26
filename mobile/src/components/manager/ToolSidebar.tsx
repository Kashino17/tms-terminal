import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts } from '../../theme';

export type ToolId = 'wrench' | 'quick' | 'snippets' | 'files' | 'search' | 'ai';
export type SidebarState = 'collapsed' | 'expanded' | 'hidden';

export interface ToolDef {
  id: ToolId;
  /** Feather icon name. */
  icon: string;
  /** Label shown when sidebar is expanded. */
  label: string;
}

export const DEFAULT_TOOLS: ToolDef[] = [
  { id: 'wrench',   icon: 'tool',   label: 'Werkzeuge' },
  { id: 'quick',    icon: 'zap',    label: 'Quick' },
  { id: 'snippets', icon: 'code',   label: 'Snippets' },
  { id: 'files',    icon: 'folder', label: 'Files' },
  { id: 'search',   icon: 'search', label: 'Suche' },
  { id: 'ai',       icon: 'cpu',    label: 'AI' },
];

interface SidebarProps {
  state: SidebarState;
  /** Currently open tool (highlighted), or null. */
  activeTool: ToolId | null;
  /** Cycle the sidebar state (called by chevron at top). */
  onToggleState: () => void;
  /** User tapped a tool. */
  onPickTool: (tool: ToolId) => void;
  /** User tapped the "+" to add a custom tool slot (placeholder). */
  onAddCustom?: () => void;
  /** Override the default tool list. */
  tools?: ToolDef[];
}

/**
 * Manager-Chat left sidebar. Replaces the previous "Stage Manager" rail since
 * the bottom chip-bar already lists all open terminals.
 *
 * Three states: collapsed (44 px, icons only), expanded (144 px, icons +
 * labels), hidden (0 px). Tools are tapped to open a flyout panel rendered
 * separately by the parent (see `<ToolFlyout>`).
 */
export const ToolSidebar: React.FC<SidebarProps> = ({
  state,
  activeTool,
  onToggleState,
  onPickTool,
  onAddCustom,
  tools = DEFAULT_TOOLS,
}) => {
  if (state === 'hidden') return null;
  const expanded = state === 'expanded';

  return (
    <View style={[s.bar, expanded && s.barExpanded]}>
      <TouchableOpacity style={s.toggle} onPress={onToggleState} activeOpacity={0.7}>
        <Feather
          name={expanded ? 'chevrons-left' : 'chevrons-right'}
          size={12}
          color={colors.textMuted}
        />
      </TouchableOpacity>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
        {tools.map((t) => {
          const active = t.id === activeTool;
          return (
            <Pressable
              key={t.id}
              style={[s.tool, active && s.toolActive]}
              onPress={() => onPickTool(t.id)}
            >
              <View style={s.iconBox}>
                <Feather
                  name={t.icon as any}
                  size={16}
                  color={active ? colors.primary : colors.textMuted}
                />
              </View>
              {expanded && (
                <Text style={[s.label, active && s.labelActive]} numberOfLines={1}>
                  {t.label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <TouchableOpacity style={s.addBtn} onPress={onAddCustom}>
        <View style={s.iconBox}>
          <Feather name="plus" size={13} color={colors.textDim} />
        </View>
        {expanded && <Text style={s.addLabel}>Eigenes</Text>}
      </TouchableOpacity>
    </View>
  );
};

// ── Flyout Panel ─────────────────────────────────────────────────────────────

interface FlyoutProps {
  /** Currently open tool (null = hidden). */
  tool: ToolId | null;
  /** Display title (defaults to the matching ToolDef.label). */
  title?: string;
  /** Active pane label shown as context (`@<sid>`). */
  contextLabel?: string;
  /** Sidebar state — controls the flyout's left offset. */
  sidebarState: SidebarState;
  onClose: () => void;
  /** Body content (render-prop pattern: caller passes rendered JSX). */
  children: React.ReactNode;
}

/**
 * Flyout panel anchored to the right edge of the ToolSidebar.
 * Caller controls the body content via `children`.
 */
export const ToolFlyout: React.FC<FlyoutProps> = ({
  tool,
  title,
  contextLabel,
  sidebarState,
  onClose,
  children,
}) => {
  if (!tool || sidebarState === 'hidden') return null;

  // Mirror the sidebar's width so the flyout sits flush against it.
  const left = sidebarState === 'expanded' ? 150 : 50;
  const def = DEFAULT_TOOLS.find((t) => t.id === tool);

  return (
    <View style={[s.flyout, { left }]} pointerEvents="box-none">
      <View style={s.flyoutInner}>
        <View style={s.flyoutHead}>
          <View style={s.flyoutToolIcon}>
            {def && <Feather name={def.icon as any} size={13} color={colors.primary} />}
          </View>
          <Text style={s.flyoutTitle}>{title ?? def?.label ?? tool}</Text>
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
    width: 144,
    paddingHorizontal: 6,
  },
  toggle: {
    height: 22,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 4,
  },
  toolActive: {
    backgroundColor: colors.primary + '26',  // ~15%
    borderColor: colors.primary + '4D',       // ~30%
  },
  iconBox: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  labelActive: {
    color: colors.primary,
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

  // Flyout
  flyout: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    width: 230,
    zIndex: 30,
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
    elevation: 16,
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
