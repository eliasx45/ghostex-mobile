/**
 * The working card (`workingCard`, decided in packages/gx-chat-core/src/extras/working_card.rs). Port
 * of desktop `working_card.rs`: one line with the spark, the label and the pills, in its own row right
 * above the cards and the composer, so the transcript's visible area ends above it and nothing scrolls
 * under it. It never opens; while the scroll-to-bottom pill shows, a tap anywhere on the card
 * scrolls to the bottom (otherwise a tap does nothing); each pill opens its own sheet
 * (`ChatPills.tsx`). The inverted transcript already keeps a short conversation at its bottom, right
 * above this row.
 *
 * The label stays on one line, cut with an ellipsis at its end so the pills keep their full width;
 * pressing and holding the card shows the whole label in a bubble above it, as hovering does on the
 * desktop, without changing the card's height. The armed Delayed Send / Close After Done timers come
 * from the app shell, not the document (desktop's `armed_actions`); a tap opens Delayed Actions.
 *
 * CDXC:SessionChat 2026-10-29 DECISION (gx-chat-core extras/working_card.rs): Elias, of the capsule:
 * "i dont like the fact that this is big here, lets make it like the actual claude code desktop app
 * has". The card is Claude Code desktop's turn status line: no edge, no fill, no rounding, starting at
 * the rows' left edge; body text 13/19 in the muted ink, then "·" with 4 either side and the elapsed
 * time in tabular figures (`workingSinceMs`). The pills stay small pills on its right. Supersedes the
 * 2026-10-20 capsule here (the phone has no Ghostex/Claude look switch, so it always draws the line).
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { ChatDocument, WorkingCard as WorkingCardValue } from '../../rust/document';
import type { RustChat } from '../../rust/useRustChat';
import { Glyph as ComposerGlyph } from '../composer/icons';
import { useTranscriptBottomStore } from '../transcript/bottomStore';
import { themedStyles, useTranscriptTheme } from '../transcript/theme';
import { IconPill, Pill, PillMenuSheet, QuestionPill } from './ChatPills';
import { Glyph } from './icons';
import { isTrue, num, obj, str } from './json';
import { chatCardsShown, COMPOSER_TOP_PADDING, STACK_GAP } from './NativeChatCards';
import { PulseDot, Spinner } from './primitives';
import { ProgressTrack, VISUAL, WorkingSpark, type ArmedAction } from './WorkingStrip';

/** The transcript rows' column (`Transcript.tsx` `ROW_MAX_WIDTH`). */
const ROW_MAX_WIDTH = 768;
/** How far the lone scroll-to-bottom pill sits above the transcript's bottom edge (desktop `transcript_layout.rs`). */
const END_PADDING = 16;

/**
 * The gap between the card's bottom edge and the chat box's top edge when nothing stacks between
 * them; the composer brings 6 of it (`NativeComposer.tsx` `root.paddingTop`), the card's row the rest.
 *
 * CDXC:SessionChat 2026-10-18 DECISION:
 * User, pointing at the gap between the working card and the chat box: "reduce the margin here to
 * 9px". A card stacked under the working card sits `STACK_GAP` below it instead (the 2026-10-23
 * decision in `NativeChatCards.tsx`). Desktop: `WORKING_CARD_GAP` in
 * apps/desktop/src/app/native_chat/working_card.rs.
 */
const BOX_GAP = 9;
/*
 * CDXC:SessionChat 2026-10-20 DECISION:
 * User: "i want clicking anywhere on the bar that's above the composer to scroll to the bottom (when the scroll to bottom button is shown) so i dont need to click specifically on that button". The card's own press scrolls to the bottom while the pill shows; the pills and timers on it keep their taps. Desktop: `render_working_card` in apps/desktop/src/app/native_chat/working_card.rs.
 */

/** Nothing stacks between the card and the chat box: no card band and nothing above the box in the composer. */
function sitsOnBox(document: ChatDocument): boolean {
  return (
    !chatCardsShown(document) &&
    document.incomingDraft === null &&
    !document.note.open &&
    document.catchUp?.open !== true &&
    obj(document.suggestions) === null &&
    document.runLocation === undefined
  );
}

/** The card's share of the gap under it: the card band brings its own top padding, the composer 6. */
function cardGap(document: ChatDocument): number {
  if (sitsOnBox(document)) return BOX_GAP - COMPOSER_TOP_PADDING;
  return chatCardsShown(document) ? 0 : STACK_GAP - COMPOSER_TOP_PADDING;
}

/** Whether the card shows: the core has something for it, or a timer is armed. */
function cardShown(document: ChatDocument, armed: readonly ArmedAction[]): boolean {
  return document.workingCard?.visible === true || armed.length > 0;
}

export function WorkingCard({
  chat,
  document,
  armed,
  onArmedPress,
}: {
  chat: RustChat;
  document: ChatDocument;
  armed: readonly ArmedAction[];
  /** Opens Delayed Actions; without it the timers are drawn but not pressable. */
  onArmedPress?: () => void;
}) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const awayFromBottom = useTranscriptBottomStore((store) => store.awayFromBottom);
  const jumpToBottom = useTranscriptBottomStore((store) => store.jumpToBottom);
  const [held, setHeld] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const card = document.workingCard;
  if (!cardShown(document, armed) || card === undefined) return null;
  const showJump = awayFromBottom && jumpToBottom !== null;
  const questions = document.openQuestions;
  const question = questions !== undefined && questions !== null && questions.count > 0 ? questions : null;
  const pills = card.pills
    .map((id) => (document.chatPills ?? []).find((pill) => pill.id === id))
    .filter((pill) => pill !== undefined);
  const label = card.label;
  return (
    <View style={styles.row}>
      <View style={[styles.column, { paddingBottom: cardGap(document) }]}>
        <Pressable
          disabled={label === null && !showJump}
          onPress={showJump ? () => jumpToBottom?.() : undefined}
          onLongPress={label !== null ? () => setHeld(true) : undefined}
          onPressOut={() => setHeld(false)}
          accessibilityRole="summary"
          accessibilityLabel={card.ariaLabel}
          style={styles.card}
        >
          <Lead card={card} />
          <View style={styles.labelSlot}>
            {label !== null ? (
              <Text
                style={card.labelKind === 'tool' || card.labelKind === 'activity' ? styles.labelStrong : styles.label}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {label}
              </Text>
            ) : null}
            {card.labelKind !== 'activity' && typeof card.workingSinceMs === 'number' ? (
              <TurnClock since={card.workingSinceMs} />
            ) : null}
            {card.labelKind === 'activity' ? <ActivityTrailing activity={obj(card.activity)} /> : null}
          </View>
          {/* Right to left from the card's edge: panel pills, question, timers, then scroll-to-bottom
              leftmost, so one appearing moves none of the others. */}
          <ScrollView
            horizontal
            style={styles.pillsScroll}
            contentContainerStyle={styles.pills}
            showsHorizontalScrollIndicator={false}
            alwaysBounceHorizontal={false}
            overScrollMode="never"
            directionalLockEnabled
            keyboardShouldPersistTaps="handled"
          >
            {showJump ? (
              <IconPill
                glyph="arrow-down"
                accessibilityLabel="Scroll to bottom"
                color={P.primary}
                onPress={() => jumpToBottom?.()}
              />
            ) : null}
            {armed.map((action) => (
              <Pressable
                key={action.id}
                disabled={onArmedPress === undefined}
                onPress={onArmedPress}
                accessibilityRole="button"
                accessibilityLabel={`${action.label}. Manage delayed actions`}
                hitSlop={6}
                style={({ pressed }) => [styles.armed, pressed ? styles.armedPressed : null]}
              >
                <ComposerGlyph
                  name="clock"
                  size={VISUAL.sparkSize}
                  color={action.id === 'delayedSend' ? VISUAL.delayedSendColor : VISUAL.closeAfterDoneColor}
                />
                <Text style={styles.armedLabel} numberOfLines={1}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
            {question !== null ? (
              <QuestionPill
                count={question.count}
                newest={question.newest ?? null}
                accessibilityLabel={question.accessibilityLabel}
                onPress={() => chat.dispatch({ type: 'previousQuestion' })}
              />
            ) : null}
            {pills.map((pill) => (
              <Pill key={pill.id} pill={pill} open={pill.id === menu} onPress={() => setMenu(pill.id)} />
            ))}
          </ScrollView>
        </Pressable>
        {held && label !== null ? (
          <View pointerEvents="none" style={styles.bubble}>
            <Text style={styles.bubbleText}>{label}</Text>
          </View>
        ) : null}
      </View>
      <PillMenuSheet chat={chat} document={document} open={menu} onClose={closeMenu} />
    </View>
  );
}

/**
 * Scroll-to-bottom on its own over the transcript's bottom edge, while the reader is away from the
 * bottom and no card shows to carry it (desktop `render_lone_scroll_bottom`).
 */
export function LoneScrollBottom({ document, armed }: { document: ChatDocument; armed: readonly ArmedAction[] }) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const awayFromBottom = useTranscriptBottomStore((store) => store.awayFromBottom);
  const jumpToBottom = useTranscriptBottomStore((store) => store.jumpToBottom);
  if (cardShown(document, armed) || !awayFromBottom || jumpToBottom === null) return null;
  return (
    <View pointerEvents="box-none" style={styles.lone}>
      <View pointerEvents="box-none" style={styles.loneColumn}>
        <IconPill
          glyph="arrow-down"
          accessibilityLabel="Scroll to bottom"
          color={P.primary}
          onPress={() => jumpToBottom()}
        />
      </View>
    </View>
  );
}

function Lead({ card }: { card: WorkingCardValue }) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  if (card.labelKind === null) return null;
  if (card.labelKind === 'activity') {
    return (
      <View style={styles.sparkBox}>
        {isTrue(obj(card.activity), 'shellsRunning') ? (
          <Spinner size={14} color={P.controlPrimary} />
        ) : (
          <PulseDot size={6} color={P.controlPrimary} active />
        )}
      </View>
    );
  }
  if (card.labelKind === 'worked') {
    return (
      <View style={styles.sparkBox}>
        <Glyph name="check" size={VISUAL.sparkSize} color={P.muted} />
      </View>
    );
  }
  return card.working ? <WorkingSpark /> : null;
}

/** "1h 2m 3s", "2m 3s" or "3s" (gx-chat-core `format_activity_elapsed`). */
function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** Claude's "· 12s" after the label (`turn_status.separator`, `turn_status.elapsed`), ticking each second. */
function TurnClock({ since }: { since: number }) {
  const styles = useStyles();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={styles.clock}>
      <Text style={[styles.clockText, styles.separator]}>{'\u00b7'}</Text>
      <Text style={styles.clockText}>{formatElapsed((now - since) / 1000)}</Text>
    </View>
  );
}

/** A live activity's progress track, clock, tokens and percent after its label (compaction). */
function ActivityTrailing({ activity }: { activity: Record<string, unknown> | null }) {
  const styles = useStyles();
  if (activity === null) return null;
  const percent = num(activity, 'percent');
  const indeterminate = isTrue(activity, 'indeterminate');
  const elapsed = str(activity, 'elapsedLabel');
  const tokens = str(activity, 'tokens');
  return (
    <>
      {percent !== null || indeterminate ? (
        <View style={styles.track}>
          <ProgressTrack percent={percent} />
        </View>
      ) : null}
      {elapsed.length > 0 ? <Text style={styles.numbers}>{elapsed}</Text> : null}
      {tokens.length > 0 ? <Text style={styles.numbers}>{tokens}</Text> : null}
      {percent !== null ? <Text style={styles.numbers}>{`${percent}%`}</Text> : null}
    </>
  );
}

const useStyles = themedStyles((P) => ({
  /** Its own row above the cards and the composer, in the rows' column. */
  row: {
    width: '100%',
    alignItems: 'center',
  },
  column: {
    width: '100%',
    maxWidth: ROW_MAX_WIDTH,
    paddingHorizontal: 12,
  },
  /** Scroll-to-bottom alone over the transcript's bottom edge, at the card's right end. */
  lone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: END_PADDING,
    alignItems: 'center',
  },
  loneColumn: {
    width: '100%',
    maxWidth: ROW_MAX_WIDTH,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
  },
  /** Claude Code's turn status line: no edge, no fill, a pill high (2026-10-29). */
  card: {
    minHeight: VISUAL.minHeight,
    paddingLeft: 0,
    paddingRight: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // The pills scroll sideways when they don't fit; nothing spills past the line's right end.
    overflow: 'hidden',
  },
  /** The whole label while the card is held, above the card, so the card keeps its height. */
  bubble: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: '100%',
    marginBottom: -2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: P.inputBorder,
    backgroundColor: P.cardPanel,
  },
  bubbleText: {
    color: P.foreground,
    fontSize: 13,
    lineHeight: 19.5,
  },
  sparkBox: {
    width: VISUAL.sparkBox,
    height: VISUAL.sparkBox,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelSlot: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: VISUAL.gap,
  },
  /** Claude's body text (13/19) in the muted ink, whatever the label names (2026-10-29). */
  label: {
    flexShrink: 1,
    color: P.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  labelStrong: {
    flexShrink: 1,
    color: P.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  /** "·" with 4 either side, then the time in tabular figures, muted; right after the label. */
  clock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: -VISUAL.gap,
  },
  separator: {
    paddingHorizontal: 4,
  },
  clockText: {
    color: P.muted,
    fontSize: 13,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
  },
  numbers: {
    flexShrink: 0,
    color: P.muted,
    fontSize: VISUAL.fontSize,
    fontVariant: ['tabular-nums'],
  },
  track: {
    width: 48,
    flexShrink: 0,
  },
  /**
   * The pills' scroll row. A horizontal ScrollView grows by default; here it takes only its content's
   * width (so the label keeps the rest while everything fits) and shrinks, then scrolls, when the
   * pills outgrow the card.
   */
  pillsScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  },
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  armed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: VISUAL.armedIconGap,
  },
  armedPressed: {
    opacity: 0.8,
  },
  armedLabel: {
    color: P.foreground,
    fontSize: VISUAL.fontSize,
    lineHeight: VISUAL.fontSize * 1.5,
  },
}));
