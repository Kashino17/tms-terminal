import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, fonts, spacing } from '../../theme';
import { colorForSession } from '../../utils/terminalColors';
import type { PaneGroup } from '../../store/paneGroupsStore';

interface Props {
  groups: PaneGroup[];
  activeId: string | null;
  /** Called when user taps a group tab. */
  onLoad: (groupId: string) => void;
  /** Called when user taps the × on a group tab. */
  onDelete: (groupId: string) => void;
  /** Called when user types a name + submits the inline editor. */
  onSave: (name: string) => void;
}

/**
 * Horizontal tab strip for saved pane configurations.
 *
 * Layout:
 *   [SETS]  [Default · 4]  [Debug · 3]  [Deploy · 2]  [+]
 *
 * The "+" button transforms inline into a text input — typing + submit saves
 * the current pane layout as a new group. Each tab shows colored dots for the
 * terminals it contains.
 */
export const GroupTabsBar: React.FC<Props> = ({
  groups,
  activeId,
  onLoad,
  onDelete,
  onSave,
}) => {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  function startEdit() {
    setEditName('');
    setEditing(true);
    // Focus + scroll to end on next frame
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      scrollRef.current?.scrollToEnd({ animated: true });
    });
  }

  function commitEdit() {
    const name = editName.trim();
    if (name) onSave(name);
    setEditing(false);
    setEditName('');
  }

  function cancelEdit() {
    setEditing(false);
    setEditName('');
  }

  return (
    <View style={s.bar}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.scroll}
      >
        {/* Section label */}
        <View style={s.label}>
          <Feather name="grid" size={11} color={colors.textDim} />
          <Text style={s.labelText}>SETS</Text>
        </View>

        {groups.map((g) => {
          const active = g.id === activeId;
          const filledTerminals = g.terminals.filter((t): t is string => !!t);
          return (
            <View key={g.id} style={[s.tab, active && s.tabActive]}>
              <TouchableOpacity
                style={s.tabBody}
                onPress={() => onLoad(g.id)}
                activeOpacity={0.7}
              >
                <View style={s.dots}>
                  {filledTerminals.slice(0, 6).map((sid, i) => (
                    <View
                      key={`${sid}-${i}`}
                      style={[s.dot, { backgroundColor: colorForSession(sid) }]}
                    />
                  ))}
                </View>
                <Text style={[s.name, active && s.nameActive]}>{g.name}</Text>
                <Text style={[s.count, active && s.countActive]}>
                  {filledTerminals.length}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.close}
                onPress={() => onDelete(g.id)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Feather name="x" size={9} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          );
        })}

        {/* Inline editor or "+" button */}
        {editing ? (
          <View style={[s.tab, s.tabActive, s.tabEditing]}>
            <TextInput
              ref={inputRef}
              style={s.input}
              value={editName}
              onChangeText={setEditName}
              placeholder="Name…"
              placeholderTextColor={colors.textDim}
              onSubmitEditing={commitEdit}
              onBlur={commitEdit}
              returnKeyType="done"
              maxLength={20}
              autoCorrect={false}
              autoCapitalize="none"
            />
            <TouchableOpacity onPress={cancelEdit} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Feather name="x" size={11} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={s.addBtn}
            onPress={startEdit}
            activeOpacity={0.7}
          >
            <Feather name="plus" size={12} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
};

const s = StyleSheet.create({
  bar: {
    height: 32,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  scroll: {
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    gap: 4,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  labelText: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.textDim,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.border,
    gap: 5,
  },
  tabActive: {
    backgroundColor: colors.primary + '24',  // ~14% opacity
    borderColor: colors.primary + '66',      // ~40% opacity
  },
  tabEditing: {
    paddingRight: 8,
  },
  tabBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  name: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.mono,
    color: colors.text,
  },
  nameActive: {
    color: colors.primary,
  },
  count: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: fonts.mono,
    color: colors.textDim,
    paddingLeft: 1,
  },
  countActive: {
    color: colors.primary,
    opacity: 0.75,
  },
  close: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 1,
  },
  addBtn: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
    minWidth: 80,
    padding: 0,
  },
});
