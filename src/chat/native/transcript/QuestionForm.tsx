/**
 * A question form an agent wrote as a ```questions block, drawn where the block sits in its reply:
 * every question at once, choices picked with a tap, a note or text box per question, and one Send
 * button. The rules (picks, Other, what is sent, the answered state) are the chat core's
 * (`questionForms`, packages/gx-chat-core/src/questions/forms.rs); this file only lays them out.
 *
 * CDXC:SessionChat 2026-10-11 SEE-ALSO:
 * Desktop draws the same form in apps/desktop/src/app/native_chat/question_form.rs; the grammar is
 * packages/gx-chat-core/src/transcript/question_forms.rs. Change them together.
 */

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import type { Json } from '../../rust/document';
import { useTranscriptEnv } from './context';
import { useRevealFocusedField } from './fieldReveal';
import { useEchoedText } from '../cards/useEchoedText';
import { AskCard, AskHead, AskOption, PrimaryButton, SoftButton, answeredColor, askColor } from '../cards/askCard';
import { arr, obj, str, type JsonRecord } from './json';
import { Glyph } from './icons';
import { SingleLinePill, SingleLineTile } from './singleLineCard';
import { MONO_FONT } from './theme';
import { QuestionFlashFrame, useQuestionAnchor } from './OpenQuestions';
import { useClaudeLook } from '../cards/claudeAsk';

/** The document's `questionForms`, by form id. */
const FormsContext = createContext<{ [id: string]: Json }>({});
export const QuestionFormsProvider = FormsContext.Provider;

/** What the footer says about the questions left blank, behind the (i) icon; desktop `SKIPPED_HINT` (ask_card.rs) says the same. */
const SKIPPED_HINT = 'Questions you leave blank are sent as skipped.';

const HINT_WIDTH = 236;

/**
 * A small (i) icon that shows `hint` in a bubble above it on a tap; a tap anywhere else closes it.
 *
 * CDXC:SessionChat 2026-10-24 DECISION: User: "remove the text about skipped (add i icon there for that)". The footer's sentence wrapped into five lines beside the buttons on the phone, so the icon takes its place and the sentence shows on a tap (a hover tooltip on the computer, desktop `ask_info_hint` in ask_card.rs). Skip all and Send answers keep their size and place.
 */
function InfoHint({ hint }: { hint: string }) {
  const { theme } = useTranscriptEnv();
  const icon = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number } | null>(null);
  const screen = useWindowDimensions();
  const close = () => setAnchor(null);
  const left =
    anchor === null ? 0 : Math.max(12, Math.min(anchor.x + anchor.width / 2 - 24, screen.width - HINT_WIDTH - 12));
  return (
    <>
      <Pressable
        ref={icon}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={hint}
        hitSlop={12}
        onPress={() => icon.current?.measureInWindow((x, y, width) => setAnchor({ x, y, width }))}
        style={styles.info}
      >
        <Glyph name="info-circle" size={17} color={theme.muted} />
      </Pressable>
      {anchor === null ? null : (
        <Modal visible transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close the hint" />
          <View
            pointerEvents="none"
            style={[
              styles.bubble,
              {
                left,
                bottom: screen.height - anchor.y + 8,
                backgroundColor: theme.light ? '#fefefe' : '#1d1d1d',
                borderColor: theme.light ? '#e5e5e5' : 'rgba(255,255,255,0.1)',
              },
            ]}
          >
            <Text style={[styles.bubbleText, { color: theme.foreground }]}>{hint}</Text>
          </View>
        </Modal>
      )}
    </>
  );
}

function letter(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : String(index + 1);
}

/** The form's own notes box's hint; desktop (question_form.rs) says the same. */
const NOTES_PLACEHOLDER = 'Anything else? (optional)';

function placeholder(question: JsonRecord | null, draft: JsonRecord | null): string {
  if (question?.text === true) return str(question, 'placeholder') || 'Your answer (optional)';
  return draft?.otherPicked === true ? 'What would you prefer instead? (optional)' : 'Note (optional)';
}

/** The form, outlined for a moment when the Previous question pill or a Q-tag link lands on it. */
export function QuestionForm({ id, source }: { id: string; source: string }) {
  const { theme } = useTranscriptEnv();
  return (
    <QuestionFlashFrame target={id} light={theme.light}>
      <QuestionFormCard id={id} source={source} />
    </QuestionFlashFrame>
  );
}

function QuestionFormCard({ id, source }: { id: string; source: string }) {
  const { theme, dispatch } = useTranscriptEnv();
  const form = obj(useContext(FormsContext)[id]);
  if (form === null) {
    return <Text style={[styles.source, { color: theme.cardMuted }]}>{source}</Text>;
  }
  const phase = str(form, 'state');
  const enabled = phase === 'open';
  const error = str(form, 'error');
  const questions = arr(form.questions);
  // The form's state is a pill on the right, as "Answered" is once it folds (desktop question_form.rs).
  const detail =
    error.length > 0
      ? 'These questions could not be shown'
      : questions.length === 1
        ? '1 question'
        : `${questions.length} questions`;
  const state =
    error.length > 0 ? (
      <SingleLinePill label="Not shown" color={theme.error} />
    ) : (
      <SingleLinePill
        {...(phase === 'sending' ? {} : { icon: 'clock' as const })}
        label={phase === 'sending' ? 'Sending…' : phase === 'queued' ? 'Queued' : 'Waiting'}
        color={askColor(theme.light)}
      />
    );
  const drafts = arr(form.drafts);
  const questionViews = questions.map((question, index) => (
    <View key={index} style={index > 0 ? [styles.later, { borderTopColor: theme.ink(0.06) }] : undefined}>
      <FormQuestion
        formId={id}
        index={index}
        question={obj(question)}
        draft={obj(drafts[index])}
        otherLabel={str(form, 'otherLabel')}
        enabled={enabled}
        answered={phase === 'answered'}
      />
    </View>
  ));
  // The form's own notes box under the last question (the SessionChat 2026-10-14 DECISION in
  // packages/gx-chat-core/src/questions/forms.rs).
  const notes = str(form, 'notes');
  const body =
    form.takesNotes === true && (enabled || notes.trim().length > 0) ? (
      <>
        {questionViews}
        <View style={[styles.later, { borderTopColor: theme.ink(0.06) }]}>
          <FormNotes formId={id} notes={notes} enabled={enabled} />
        </View>
      </>
    ) : (
      questionViews
    );
  // An answered form is one line that opens the read-only form and closes it again; the core says
  // which (`collapsed`, the SessionChat 2026-10-12 DECISION in packages/gx-chat-core/src/questions/forms.rs).
  if (phase === 'answered' && error.length === 0) {
    const open = form.collapsed !== true;
    return (
      <AskCard
        singleLine
        head={
          <AskHead
            singleLine
            title={str(form, 'title') || 'Questions'}
            trailing={<SingleLinePill icon="check" label="Answered" color={answeredColor(theme.light)} />}
            accessibilityLabel={open ? 'Hide the questions' : 'Show the questions'}
            onPress={() => dispatch({ type: 'formToggle', form: id })}
          />
        }
      >
        {open ? body : null}
      </AskCard>
    );
  }
  const head = (
    <AskHead
      lead={<SingleLineTile glyph="checklist" ring={theme.cardPanel} />}
      title={str(form, 'title') || 'Questions'}
      detail={detail}
      trailing={state}
    />
  );
  if (error.length > 0) {
    return (
      <AskCard head={head}>
        <View style={styles.errorBody}>
          <Text style={{ color: theme.error }}>These questions could not be shown: {error}</Text>
          {form.resent === true ? (
            // Desktop question_form.rs RESENT_NOTE: gxserver asked the agent to send them again.
            <Text style={[styles.detail, { color: theme.cardMuted }]}>
              Ghostex asked the agent to send these questions again.
            </Text>
          ) : null}
          <Text style={[styles.source, { color: theme.cardMuted }]}>{source}</Text>
        </View>
      </AskCard>
    );
  }
  const canSend = form.canSend === true;
  const sendError = str(form, 'sendError');
  const status =
    phase === 'answered'
      ? 'Sent to the agent.'
      : phase === 'queued'
        ? "Queued: it goes to the agent once it's ready."
        : phase === 'sending'
          ? form.reconnecting === true
            ? "Reconnecting to Ghostex… your answers go out as soon as it's back."
            : 'Sending…'
          : sendError.length > 0
            ? sendError
            : '';
  const sendLabel = phase === 'answered' ? 'Sent' : phase === 'queued' ? 'Queued' : str(form, 'submit');
  const footer = (
    <>
      {status.length > 0 ? (
        <Text style={[styles.status, { color: enabled && sendError.length > 0 ? theme.error : theme.muted }]}>
          {status}
        </Text>
      ) : (
        // Nothing to report: the (i) icon holds the sentence about blank questions, in the status' place.
        <View style={styles.status}>
          <InfoHint hint={SKIPPED_HINT} />
        </View>
      )}
      {enabled ? (
        // Skip all sends at once, every question skipped whatever is picked (the core's `skip_all`; the
        // SessionChat 2026-10-16 DECISION on `SKIPPED` in packages/gx-visual/src/questions.rs).
        <SoftButton label="Skip all" onPress={() => dispatch({ type: 'formSkipAll', form: id })} />
      ) : null}
      <PrimaryButton label={sendLabel} disabled={!canSend} onPress={() => dispatch({ type: 'formSend', form: id })} />
    </>
  );
  return (
    <AskCard head={head} footer={footer}>
      {body}
    </AskCard>
  );
}

function FormNotes({ formId, notes, enabled }: { formId: string; notes: string; enabled: boolean }) {
  const { theme, dispatch } = useTranscriptEnv();
  const report = useCallback((text: string) => dispatch({ type: 'formNotes', form: formId, text }), [dispatch, formId]);
  const [text, setText] = useEchoedText(`${formId}:notes`, notes, report);
  const reveal = useRevealFocusedField();
  if (!enabled) {
    return (
      <Text selectable style={[styles.detail, { color: theme.cardMuted }]}>
        Notes: {notes}
      </Text>
    );
  }
  return (
    <TextInput
      multiline
      value={text}
      placeholder={NOTES_PLACEHOLDER}
      placeholderTextColor={theme.placeholder}
      accessibilityLabel="Notes"
      onFocus={reveal}
      onContentSizeChange={reveal}
      onChangeText={setText}
      style={[
        styles.input,
        {
          color: theme.foreground,
          borderColor: theme.inputBorder,
          backgroundColor: theme.light ? theme.background : theme.cardRow,
        },
      ]}
    />
  );
}

function FormQuestion({
  formId,
  index,
  question,
  draft,
  otherLabel,
  enabled,
  answered,
}: {
  formId: string;
  index: number;
  question: JsonRecord | null;
  draft: JsonRecord | null;
  otherLabel: string;
  enabled: boolean;
  answered: boolean;
}) {
  const { theme, dispatch } = useTranscriptEnv();
  const tag = str(question, 'tag');
  const detail = str(question, 'detail');
  const multiple = question?.multiple === true;
  const isText = question?.text === true;
  const picked = new Set(arr(draft?.indices).filter((value): value is number => typeof value === 'number'));
  const choices = arr(question?.choices);
  const written = str(draft, 'other');
  const pick = (choice: number) => dispatch({ type: 'formChoice', form: formId, question: index, choice });
  const report = useCallback(
    (text: string) => dispatch({ type: 'formText', form: formId, question: index, text }),
    [dispatch, formId, index],
  );
  const [text, setText] = useEchoedText(`${formId}:${index}`, written, report);
  const reveal = useRevealFocusedField();
  const skipped = draft?.skipped === true;
  const anchor = useQuestionAnchor(formId, tag);
  // Claude's rows carry their own height and pressed fill, so they sit closer together.
  const claude = useClaudeLook();
  return (
    <View ref={anchor} collapsable={false} style={[styles.question, claude && styles.claudeQuestion]}>
      <View style={styles.questionHead}>
        <Text style={[styles.questionTitle, { color: theme.foreground }]}>{str(question, 'title')}</Text>
        {tag.length > 0 ? (
          <Text style={[styles.tag, { color: theme.muted, backgroundColor: `${theme.muted}2e` }]}>{tag}</Text>
        ) : null}
      </View>
      {detail.length > 0 ? <Text style={[styles.detail, { color: theme.cardMuted }]}>{detail}</Text> : null}
      {!isText && multiple ? <Text style={[styles.hint, { color: theme.muted }]}>Pick any that apply.</Text> : null}
      {!isText
        ? choices.map((choice, choiceIndex) => (
            <AskOption
              key={choiceIndex}
              keyLabel={letter(choiceIndex)}
              label={str(choice, 'label')}
              detail={str(choice, 'detail')}
              recommended={obj(choice)?.recommended === true}
              picked={picked.has(choiceIndex)}
              multiple={multiple}
              enabled={enabled}
              answered={answered}
              onPress={() => pick(choiceIndex)}
            />
          ))
        : null}
      {!isText ? (
        <AskOption
          keyLabel={letter(choices.length)}
          label={otherLabel}
          picked={draft?.otherPicked === true}
          multiple={multiple}
          other
          enabled={enabled}
          answered={answered}
          onPress={() => pick(choices.length)}
        />
      ) : null}
      {enabled ? (
        <TextInput
          multiline
          value={text}
          placeholder={placeholder(question, draft)}
          placeholderTextColor={theme.placeholder}
          onFocus={reveal}
          onContentSizeChange={reveal}
          onChangeText={setText}
          style={[
            styles.input,
            {
              color: theme.foreground,
              borderColor: theme.inputBorder,
              backgroundColor: theme.light ? theme.background : theme.cardRow,
            },
            isText && styles.textAnswer,
          ]}
        />
      ) : written.trim().length > 0 ? (
        <Text selectable style={[styles.detail, { color: theme.cardMuted }]}>
          {isText ? written : `Note: ${written}`}
        </Text>
      ) : skipped ? (
        <Text style={[styles.detail, { color: theme.muted }]}>Skipped</Text>
      ) : isText ? (
        <Text style={[styles.detail, { color: theme.muted }]}>Not answered</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  later: { marginTop: 16, paddingTop: 16, borderTopWidth: 1 },
  errorBody: { gap: 8 },
  question: { gap: 8 },
  claudeQuestion: { gap: 2 },
  // The user's pick (desktop question_form.rs): the tag is a filled chip at the right end of the title's first line, the title wrapping beside it.
  questionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  tag: {
    flexShrink: 0,
    marginTop: 2,
    fontFamily: MONO_FONT,
    fontSize: 10.5,
    lineHeight: 18,
    fontWeight: '500',
    paddingHorizontal: 7,
    borderRadius: 999,
    overflow: 'hidden',
  },
  questionTitle: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, fontWeight: '500' },
  detail: { fontSize: 13, lineHeight: 19 },
  hint: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13.5,
    minHeight: 38,
    textAlignVertical: 'top',
  },
  textAnswer: { minHeight: 70 },
  status: { flex: 1, fontSize: 12.5 },
  info: { alignSelf: 'flex-start', width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  bubble: {
    position: 'absolute',
    width: HINT_WIDTH,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  bubbleText: { fontSize: 13, lineHeight: 18 },
  source: { fontFamily: MONO_FONT, fontSize: 12 },
});
