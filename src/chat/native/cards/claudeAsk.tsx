/**
 * The question card's pieces in the Claude look (`sessionChatClaudeLook`, on by default): Claude
 * Code's AskUserQuestion card. Option rows separated by hairlines, a radio (a checkbox for
 * many-of-N) before the label and its description, secondary and primary footer buttons, and the
 * amber "Needs your input" pill under a card that waits. The phone has no owner pack, so the
 * colours are Claude's shipped values over the phone theme's own inks.
 *
 * CDXC:SessionChat 2026-10-28 DECISION: Elias, shown Claude Code desktop's question card: "Yes, Claude's card", phone too. The phone's question card and its ```questions forms' rows and buttons take the same layout as the desktop's Claude look (apps/desktop/src/app/native_chat/claude_question_card.rs, where the full decision and what it keeps from the older ones is written). Off, the 2026-10-11 "Clear ask, clear answer" look stays.
 */

import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useSettingsStore } from '../../../settings/store';
import { Glyph } from './icons';
import { themedStyles, useTranscriptTheme, type TranscriptTheme } from '../transcript/theme';

/** Whether the question cards take the Claude look (`sessionChatClaudeLook`). */
export function useClaudeLook(): boolean {
  return useSettingsStore((store) => store.settings.sessionChatClaudeLook) !== false;
}

/** Claude's colours for the card (`--cds-*`, dark / light), as the desktop falls back to them. */
export function claudeAskColors(P: TranscriptTheme) {
  const dark = !P.light;
  return {
    /** `--cds-fill-accent`: the radio's ring and dot, a checked box. */
    accent: '#2a78d6',
    onAccent: '#ffffff',
    /** Submit (`--cds-fill-primary`, `--cds-on-primary`). */
    primary: dark ? '#ffffff' : '#0b0b0b',
    primaryPressed: dark ? '#e1e0d9' : '#2c2c2a',
    onPrimary: dark ? '#0b0b0b' : '#ffffff',
    /** Skip, Cancel, Skip all (`--cds-fill-secondary`). */
    secondary: dark ? 'rgba(255,255,255,0.1)' : 'rgba(11,11,11,0.05)',
    secondaryPressed: dark ? 'rgba(255,255,255,0.14)' : 'rgba(11,11,11,0.09)',
    /** The waiting pill (`--cds-text-warning` on `--cds-bg-warning-chip`). */
    warning: dark ? '#db9300' : '#734500',
    warningChip: dark ? '#311a00' : '#f9dca4',
    /** A pressed row (`--cds-alpha-1`) and the hairlines (`--cds-alpha-2`). */
    rowFill: P.ink(0.05),
    hairline: P.ink(0.1),
    /** The header strip, a step darker than the card's body. */
    head: dark ? 'rgba(0,0,0,0.2)' : 'rgba(11,11,11,0.025)',
  };
}

/** The round radio, or the square checkbox, at a row's start. */
export function ClaudeMark({ picked, multiple }: { picked: boolean; multiple: boolean }) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const colors = claudeAskColors(P);
  return (
    <View
      style={[
        styles.mark,
        multiple ? styles.checkbox : styles.radio,
        { borderColor: picked ? colors.accent : P.mutedInk(0.8) },
        picked && multiple && { backgroundColor: colors.accent },
      ]}
    >
      {picked && multiple ? <Glyph name="check" size={11} color={colors.onAccent} /> : null}
      {picked && !multiple ? <View style={[styles.radioDot, { backgroundColor: colors.accent }]} /> : null}
    </View>
  );
}

/** One option row: the mark, the label over its description, an optional key cap at the end. */
export function ClaudeOptionRow({
  label,
  detail,
  picked,
  multiple,
  keyLabel,
  recommended,
  other,
  enabled,
  onPress,
  children,
}: {
  label: string;
  detail?: string;
  picked: boolean;
  multiple: boolean;
  keyLabel?: string;
  recommended?: boolean;
  /** "Other": its label stays secondary until it is picked. */
  other?: boolean;
  enabled: boolean;
  onPress: () => void;
  /** Drawn in place of the label (the Other row's text field). */
  children?: ReactNode;
}) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const colors = claudeAskColors(P);
  const showDetail = detail !== undefined && detail.length > 0 && detail !== label;
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityLabel={label}
      accessibilityState={{ checked: picked, disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.rowFill },
        !enabled && !picked && styles.dimmed,
      ]}
    >
      <ClaudeMark picked={picked} multiple={multiple} />
      {children ?? (
        <View style={styles.rowBody}>
          <View style={styles.rowLine}>
            <Text style={[styles.label, { color: other === true && !picked ? P.cardMuted : P.foreground }]}>
              {label}
            </Text>
            {recommended === true ? <Text style={[styles.recommended, { color: P.accent }]}>Recommended</Text> : null}
          </View>
          {showDetail ? <Text style={styles.detail}>{detail}</Text> : null}
        </View>
      )}
      {keyLabel !== undefined ? <Text style={styles.keycap}>{keyLabel}</Text> : null}
    </Pressable>
  );
}

/** The 0.5pt rule between two option rows, inset 12pt. */
export function ClaudeHairline() {
  const styles = useStyles();
  const P = useTranscriptTheme();
  return <View style={[styles.hairline, { backgroundColor: claudeAskColors(P).hairline }]} />;
}

/** A footer button: Submit / Next (`primary`) or Skip, Cancel, Skip all. */
export function ClaudeButton({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const colors = claudeAskColors(P);
  const isPrimary = primary === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled === true}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isPrimary
            ? pressed
              ? colors.primaryPressed
              : colors.primary
            : pressed
              ? colors.secondaryPressed
              : colors.secondary,
        },
        disabled === true && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonLabel, { color: isPrimary ? colors.onPrimary : P.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** The amber pill under a card that waits on the reader. */
export function NeedsInputPill() {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const colors = claudeAskColors(P);
  return (
    <View style={[styles.pill, { backgroundColor: colors.warningChip }]}>
      <View style={[styles.pillDot, { borderColor: colors.warning }]} />
      <Text style={[styles.pillLabel, { color: colors.warning }]}>Needs your input</Text>
    </View>
  );
}

const useStyles = themedStyles((P) => ({
  mark: {
    width: 16,
    height: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radio: { borderRadius: 8 },
  checkbox: { borderRadius: 4 },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 12,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  label: { fontSize: 14, lineHeight: 20 },
  detail: { color: P.muted, fontSize: 12, lineHeight: 15 },
  recommended: { fontSize: 12, lineHeight: 15 },
  keycap: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderWidth: 1,
    borderBottomWidth: 2,
    borderRadius: 4,
    borderColor: P.ink(0.1),
    backgroundColor: P.ink(0.05),
    color: P.muted,
    fontSize: 11,
    lineHeight: 13,
    textAlign: 'center',
    overflow: 'hidden',
  },
  dimmed: { opacity: 0.55 },
  hairline: { height: 0.5, marginHorizontal: 12 },
  button: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 13.5, fontWeight: '500' },
  disabled: { opacity: 0.4 },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  pillLabel: { fontSize: 12, lineHeight: 15, fontWeight: '500' },
}));
