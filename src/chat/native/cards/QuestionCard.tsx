/**
 * The agent's blocking question (`AskUserQuestion` and the like) and its approval request, drawn
 * from `questionCard` and `prompt`. Port of desktop `question.rs` and `approval.rs`: the same
 * copy, the same actions and payloads.
 *
 * While `prompt.kind` is `question` desktop draws this card in place of the composer; the screen
 * decides that (see `questionReplacesComposer`).
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';

import type { ChatDocument } from '../../rust/document';
import type { RustChat } from '../../rust/useRustChat';
import { Glyph } from './icons';
import { arr, isTrue, obj, str } from './json';
import { MONO_FONT, themedStyles, useTranscriptTheme } from '../transcript/theme';
import { AskCard, AskHead, AskOption, PrimaryButton, ProgressDots } from './askCard';
import { SingleLineTile } from '../transcript/singleLineCard';
import { CardButton, CardHeader, StatusCard, useCardText } from './primitives';
import { ApprovalCard, RECONNECTING_NOTE } from './ApprovalCard';
import { useEchoedText } from './useEchoedText';
import { ClaudeButton, ClaudeHairline, ClaudeOptionRow, NeedsInputPill, claudeAskColors, useClaudeLook } from './claudeAsk';

/** The share of the window the cards band above the composer may take (`NativeChatCards`). */
export const CARD_BAND_SHARE = 0.6;

/**
 * CDXC:SessionChat 2026-10-23 DECISION: User: "please make the height of this limited and the text in the middle scrollable. right now it sometimes becomes super tall and i can't click on the buttons at the bottom." The card stands in for the composer at the foot of the cards band, so it is no taller than that band (less its top padding): its head, options and footer keep their height and only the question text scrolls. The options keep their own scroll at under half the card. Desktop caps its card the same way (`question_card_max_height` in apps/desktop/src/app/native_chat/question.rs).
 */
function questionCardMaxHeight(windowHeight: number): number {
  return windowHeight * CARD_BAND_SHARE - 8;
}

/** Desktop returns the question card instead of the composer for a `question` prompt. */
export function questionReplacesComposer(document: ChatDocument | null | undefined): boolean {
  return document?.questionCard?.visible === true && str(document.prompt, 'kind') === 'question';
}

export function QuestionCard({ chat, document }: { chat: RustChat; document: ChatDocument }) {
  const cardText = useCardText();
  const card = document.questionCard;
  if (card?.visible !== true) return null;
  if (card.loading) {
    return (
      <StatusCard
        header={<CardHeader icon="help-circle" title="Question" />}
        body={[
          <Text key="restoring" style={cardText.prose}>
            Restoring your answer…
          </Text>,
        ]}
      />
    );
  }
  if (str(document.prompt, 'kind') === 'approval') {
    return <ApprovalCard chat={chat} document={document} />;
  }
  return <QuestionPromptCard chat={chat} document={document} />;
}

function QuestionPromptCard(props: { chat: RustChat; document: ChatDocument }) {
  return useClaudeLook() ? <ClaudeQuestionPromptCard {...props} /> : <GhostexQuestionPromptCard {...props} />;
}

/**
 * The question card in the Claude look (claudeAsk.tsx): the question on a darker header strip with
 * a "‹ 1 of 2 ›" pager and the fold chevron, hairline-separated option rows, a last "Other" row
 * that opens into a text field, Cancel / Skip / Submit, and the "Needs your input" pill under it.
 * Same actions and payloads as Ghostex's look below (desktop claude_question_card.rs).
 */
function ClaudeQuestionPromptCard({ chat, document }: { chat: RustChat; document: ChatDocument }) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const colors = claudeAskColors(P);
  const { dispatch } = chat;
  const maxHeight = questionCardMaxHeight(useWindowDimensions().height);
  const card = document.questionCard;
  const prompt = document.prompt;
  const questions = arr(obj(prompt)?.questions);
  const count = questions.length;
  const index = card.questionIndex ?? 0;
  const last = index + 1 >= count;
  const question = questions[index];
  const draft = card.drafts[index] ?? { indices: [], other: '' };
  const busy = card.busy;
  const multi = isTrue(question, 'multiSelect');
  const promptKey = useMemo(() => JSON.stringify(prompt), [prompt]);
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const collapsed = collapsedKey === promptKey;
  const [otherKey, setOtherKey] = useState<string | null>(null);

  const reportText = useCallback((text: string) => dispatch({ type: 'questionText', text }), [dispatch]);
  const [other, setOther] = useEchoedText(`${promptKey}:${index}`, draft.other ?? '', reportText);
  const allowCustom = obj(question)?.allowCustom !== false;
  const otherOpen = allowCustom && (otherKey === `${promptKey}:${index}` || other.length > 0);
  const answered = draft.indices.length > 0 || other.trim().length > 0;
  const options = arr(obj(question)?.options);
  const previews = !multi && options.some((option) => str(option, 'preview').length > 0);
  const focused = draft.indices[0] ?? 0;
  const preview = previews ? str(options[focused], 'preview') : '';
  const sending = card.controls.label === 'Sending…';
  const submitLabel = sending ? 'Sending…' : last ? 'Submit' : 'Next';

  return (
    <View style={styles.claudeWrap}>
      <View style={[styles.claudeCard, { maxHeight }]}>
        <View style={[styles.claudeHead, { backgroundColor: colors.head }, collapsed && styles.claudeHeadFolded]}>
          <ScrollView style={styles.questionScroll} nestedScrollEnabled>
            <Text style={styles.claudeQuestion} numberOfLines={collapsed ? 1 : undefined}>
              {str(question, 'question')}
            </Text>
          </ScrollView>
          <View style={styles.claudeHeadTools}>
            {count > 1 ? (
              <View style={styles.pager}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Previous question"
                  disabled={busy || index === 0}
                  hitSlop={8}
                  onPress={() => dispatch({ type: 'questionBack' })}
                  style={[styles.pagerButton, (busy || index === 0) && styles.pagerDisabled]}
                >
                  <Glyph name="chevron-left" size={14} color={P.muted} />
                </Pressable>
                <Text style={styles.pagerLabel}>{`${index + 1} of ${count}`}</Text>
                {/* Forward without an answer is the core's Next short of the last question, which never sends. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Next question"
                  disabled={busy || last}
                  hitSlop={8}
                  onPress={() => dispatch({ type: 'questionNext' })}
                  style={[styles.pagerButton, (busy || last) && styles.pagerDisabled]}
                >
                  <Glyph name="chevron-right" size={14} color={P.muted} />
                </Pressable>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={collapsed ? 'Show the question and its options' : 'Hide the question and its options'}
              hitSlop={8}
              onPress={() => setCollapsedKey(collapsed ? null : promptKey)}
              style={styles.pagerButton}
            >
              <Glyph name={collapsed ? 'chevron-up' : 'chevron-down'} size={14} color={P.muted} />
            </Pressable>
          </View>
        </View>
        {collapsed ? null : (
          <View style={[styles.claudeBody, styles.shrinks]}>
            <ScrollView style={{ maxHeight: maxHeight * 0.45 }} nestedScrollEnabled>
              {options.map((option, optionIndex) => {
                // A one-of-N note replaces the pick, so the pick stays lit only while there is none.
                const selected = (multi || other.trim().length === 0) && draft.indices.includes(optionIndex);
                return (
                  <View key={optionIndex}>
                    <ClaudeOptionRow
                      label={str(option, 'label')}
                      detail={str(option, 'description')}
                      picked={selected}
                      multiple={multi}
                      enabled={!busy}
                      onPress={() => {
                        setOtherKey(null);
                        dispatch({ type: 'questionOption', index: optionIndex });
                      }}
                    />
                    {optionIndex + 1 < options.length || allowCustom ? <ClaudeHairline /> : null}
                  </View>
                );
              })}
              {allowCustom ? (
                <ClaudeOptionRow
                  label="Other"
                  picked={otherOpen}
                  multiple={multi}
                  other
                  enabled={!busy}
                  onPress={() => setOtherKey(`${promptKey}:${index}`)}
                >
                  {otherOpen ? (
                    <TextInput
                      accessibilityLabel="Other"
                      style={styles.otherInput}
                      value={other}
                      onChangeText={setOther}
                      editable={!busy}
                      autoFocus={other.length === 0}
                      multiline
                      submitBehavior="submit"
                      returnKeyType="send"
                      onSubmitEditing={() => dispatch({ type: 'questionNext' })}
                      placeholder="Other"
                      placeholderTextColor={P.placeholder}
                    />
                  ) : undefined}
                </ClaudeOptionRow>
              ) : null}
            </ScrollView>
            {/* The picked option's preview (the first one's before a pick), under the list on a phone. */}
            {preview.length > 0 ? (
              <ScrollView style={styles.claudePreview} nestedScrollEnabled>
                <Text style={styles.commandText} selectable>
                  {preview}
                </Text>
              </ScrollView>
            ) : null}
          </View>
        )}
        <View style={[styles.claudeRule, { backgroundColor: colors.hairline }]} />
        <View style={styles.claudeFooter}>
          <View style={styles.claudeFooterStart}>
            <ClaudeButton label="Cancel" disabled={busy} onPress={() => dispatch({ type: 'questionCancel' })} />
            {card.reconnecting === true ? (
              <Text style={styles.claudeStatus} numberOfLines={2}>
                {RECONNECTING_NOTE}
              </Text>
            ) : multi && draft.indices.length > 0 ? (
              <Text style={styles.claudeStatus}>{`${draft.indices.length} selected`}</Text>
            ) : null}
          </View>
          {!answered ? (
            <ClaudeButton
              label="Skip"
              disabled={busy || (last && card.controls.hasAnswer !== true)}
              onPress={() => dispatch({ type: 'questionNext' })}
            />
          ) : null}
          <ClaudeButton
            label={submitLabel}
            primary
            disabled={busy || card.controls.disabled || !answered}
            onPress={() => dispatch({ type: 'questionNext' })}
          />
        </View>
      </View>
      <NeedsInputPill />
    </View>
  );
}

function GhostexQuestionPromptCard({ chat, document }: { chat: RustChat; document: ChatDocument }) {
  const cardText = useCardText();
  const styles = useStyles();
  const P = useTranscriptTheme();
  const { dispatch } = chat;
  const maxHeight = questionCardMaxHeight(useWindowDimensions().height);
  const card = document.questionCard;
  const prompt = document.prompt;
  const questions = arr(obj(prompt)?.questions);
  const count = questions.length;
  const index = card.questionIndex ?? 0;
  const question = questions[index];
  const draft = card.drafts[index] ?? { indices: [], other: '' };
  const busy = card.busy;
  const multi = isTrue(question, 'multiSelect');
  const header = str(question, 'header');
  const promptKey = useMemo(() => JSON.stringify(prompt), [prompt]);
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const collapsed = collapsedKey === promptKey;

  const reportText = useCallback((text: string) => dispatch({ type: 'questionText', text }), [dispatch]);
  const [other, setOther] = useEchoedText(`${promptKey}:${index}`, draft.other ?? '', reportText);
  const allowCustom = obj(question)?.allowCustom !== false;

  // The header names the ask over the question's own header and its place (desktop question.rs, CDXC:SessionChat 2026-10-11).
  const detail = collapsed
    ? str(question, 'question')
    : count > 1
      ? header.length > 0
        ? `${header} · ${index + 1} of ${count}`
        : `${index + 1} of ${count}`
      : header;
  const head = (
    <AskHead
      lead={<SingleLineTile glyph="checklist" badge="ask" ring={P.cardPanel} />}
      title="Needs your answer"
      detail={detail}
      trailing={count > 1 && !collapsed ? <ProgressDots index={index} count={count} /> : undefined}
      chevron={collapsed ? 'closed' : 'open'}
      accessibilityLabel={collapsed ? 'Show the question and its options' : 'Hide the question and its options'}
      onPress={() => setCollapsedKey(collapsed ? null : promptKey)}
    />
  );

  const footer = (
    <>
      {index > 0 ? <CardButton label="←" disabled={busy} onPress={() => dispatch({ type: 'questionBack' })} /> : null}
      {allowCustom ? (
        <View style={styles.answerField}>
          <Glyph name="pencil" size={13} color={P.muted} />
          <TextInput
            accessibilityLabel="Your answer"
            style={styles.answerInput}
            value={other}
            onChangeText={setOther}
            editable={!busy}
            multiline
            submitBehavior="submit"
            returnKeyType="send"
            onSubmitEditing={() => dispatch({ type: 'questionNext' })}
            placeholder="Or write your own answer…"
            placeholderTextColor={P.placeholder}
          />
        </View>
      ) : (
        <View style={styles.spacer} />
      )}
      <CardButton label="Cancel" disabled={busy} onPress={() => dispatch({ type: 'questionCancel' })} />
      <PrimaryButton
        label={card.controls.label}
        disabled={busy || card.controls.disabled}
        onPress={() => dispatch({ type: 'questionNext' })}
      />
    </>
  );

  return (
    <AskCard head={head} footer={footer} style={{ maxHeight }} bodyStyle={styles.shrinks}>
      {collapsed ? null : (
        <View style={[styles.body, styles.shrinks]}>
          <ScrollView style={styles.questionScroll} nestedScrollEnabled>
            <Text style={styles.question}>{str(question, 'question')}</Text>
          </ScrollView>
          {multi ? <Text style={[cardText.hint, styles.multiHint]}>Select one or more options.</Text> : null}
          <ScrollView
            style={{ maxHeight: maxHeight * 0.45 }}
            contentContainerStyle={styles.options}
            nestedScrollEnabled
          >
            {arr(obj(question)?.options).map((option, optionIndex) => {
              // A multi-select note is sent beside the picks, so they stay visible while it is typed.
              const selected = (multi || draft.other.trim().length === 0) && draft.indices.includes(optionIndex);
              const preview = str(option, 'preview');
              return (
                <View key={optionIndex} style={styles.optionWithPreview}>
                  <AskOption
                    label={str(option, 'label')}
                    detail={str(option, 'description')}
                    picked={selected}
                    multiple={multi}
                    enabled={!busy}
                    onPress={() => dispatch({ type: 'questionOption', index: optionIndex })}
                  />
                  {/* The mockup Claude shows beside the option, under the row that picks it (desktop question.rs). */}
                  {preview.length > 0 ? (
                    <ScrollView style={styles.optionPreview} nestedScrollEnabled>
                      <Text style={styles.commandText} selectable>
                        {preview}
                      </Text>
                    </ScrollView>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          {card.reconnecting === true ? <Text style={cardText.hint}>{RECONNECTING_NOTE}</Text> : null}
        </View>
      )}
    </AskCard>
  );
}

const useStyles = themedStyles((P) => ({
  body: {
    gap: 12,
  },
  shrinks: {
    flexShrink: 1,
    minHeight: 0,
  },
  questionScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  question: {
    color: P.foreground,
    fontSize: 15,
    lineHeight: 22,
  },
  multiHint: {
    marginTop: -6,
  },
  options: {
    gap: 8,
  },
  answerField: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: P.inputBorder,
    backgroundColor: P.light ? P.background : P.cardRow,
  },
  answerInput: {
    flex: 1,
    minWidth: 0,
    maxHeight: 96,
    color: P.foreground,
    fontSize: 13.5,
    lineHeight: 20,
    paddingVertical: 6,
    paddingHorizontal: 0,
  },
  spacer: {
    flexGrow: 1,
  },
  optionWithPreview: {
    gap: 6,
  },
  optionPreview: {
    maxHeight: 160,
    marginLeft: 28,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: P.wellFill,
  },
  claudeWrap: {
    gap: 8,
  },
  claudeCard: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: P.inputBorder,
    backgroundColor: P.cardPanel,
    overflow: 'hidden',
  },
  claudeHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 12,
    paddingTop: 12,
    paddingBottom: 8,
    flexShrink: 1,
  },
  claudeHeadFolded: {
    paddingBottom: 12,
  },
  claudeQuestion: {
    color: P.foreground,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '500',
  },
  claudeHeadTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 22,
  },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  pagerButton: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerDisabled: {
    opacity: 0.4,
  },
  pagerLabel: {
    color: P.muted,
    fontSize: 14,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
  claudeBody: {
    padding: 6,
    gap: 6,
  },
  otherInput: {
    flex: 1,
    minWidth: 0,
    maxHeight: 96,
    color: P.foreground,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  claudePreview: {
    maxHeight: 256,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: P.ink(0.05),
  },
  claudeRule: {
    height: 0.5,
  },
  claudeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  claudeFooterStart: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  claudeStatus: {
    flexShrink: 1,
    color: P.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  commandText: {
    color: P.cardMuted,
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 20,
  },
}));
