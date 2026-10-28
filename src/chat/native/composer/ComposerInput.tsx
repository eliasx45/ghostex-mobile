/**
 * The composer's text field: a multiline `TextInput` that grows to a cap, bound to the host's
 * composer model (`src/chat/rust/composer.ts`), which mirrors desktop's text-field handling.
 *
 * Reference pills (`[label](path)` in the draft, parsed by the core's `composerReferences`) are
 * drawn inside the field as their tinted label; the markdown around the label is kept in the text
 * but drawn with no width, the way desktop's `InlineReplacement` shows a pill over the same text.
 * A pill edits as one glyph (`references.ts`): deleting into it removes the whole reference
 * (`removeAttachment`), typing inside it lands after it.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import GhostexImageIntakeView from '../../../../modules/ghostex-native/src/GhostexImageIntakeView';
import type { UserAction } from '../../rust/actions';
import type { ComposerModelState } from '../../rust/composer';
import type { RustChat } from '../../rust/useRustChat';
import { themedStyles, useTranscriptTheme } from '../transcript/theme';
import { diffEdit, guardEdit, snapCaret, type ComposerReference } from './references';

export type ComposerInputHandle = { focus(): void; blur(): void };

type Selection = { start: number; end: number };

/**
 * The collapsed field: exactly one line (`lineHeight` plus the vertical padding in `input`). The
 * field was 24 tall, a point short of its own line, and Android squeezed both placeholder lines into
 * it; collapsed, it shows only the placeholder's first line.
 */
export const COLLAPSED_INPUT_HEIGHT = 21 + 2 + 2;

/**
 * The average glyph advance, in physical pixels, of the pill's hidden markdown.
 *
 * CDXC:SessionChat 2026-10-05 WHY: Android rounds a span's font size up to a whole pixel (`TextAttributeProps.setFontSize` ceils), so the "0.1" hidden `](path)` still took about 40px after an image pill, and the keyboard's suggestion/composing underline (drawn in its own color, not the transparent text color) showed there as a faint line. A font size of 0 is not an option: RN's letter-spacing getter requires a positive size. Each hidden glyph is pulled back by about its own 1px advance instead, so the markdown takes next to no width.
 */
const HIDDEN_GLYPH_ADVANCE_PX = 0.55;

/**
 * The field takes dragged text only (React Native's Android drag filter, which `TextInput.js` passes
 * on but its typings leave out), so an image held over it stays the chat view's drop.
 */
const TEXT_DROPS: Record<string, unknown> = { experimental_acceptDragAndDropTypes: ['text/*'] };

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  {
    model: ComposerModelState;
    input: NonNullable<RustChat['composer']>;
    references: readonly ComposerReference[];
    /** The text the references were parsed from; they are dropped while it differs from `text`. */
    parsedFor: string;
    /** Parses a draft's references now, for an edit that lands before `references` caught up. */
    parse: (text: string) => readonly ComposerReference[];
    placeholder: string;
    /** The how-to the placeholder used to carry (CP5, 2026-10-28), read by screen readers. */
    accessibilityHint?: string;
    collapsed: boolean;
    maxHeight: number;
    dispatch: (action: UserAction) => void;
    onTextChange: (text: string) => void;
    onCaret: (caret: number) => void;
    /** Images the keyboard inserted or Paste put in (`GhostexImageIntakeView`, Android). */
    onImages: (event: { nativeEvent: unknown }) => void;
  }
>(function ComposerInput(
  {
    model,
    input,
    references,
    parsedFor,
    parse,
    placeholder,
    accessibilityHint,
    collapsed,
    maxHeight,
    dispatch,
    onTextChange,
    onCaret,
    onImages,
  },
  ref,
) {
  const styles = useStyles();
  const P = useTranscriptTheme();
  const { scale, fontScale } = useWindowDimensions();
  const hidden = useMemo(
    () => [styles.hidden, { letterSpacing: -HIDDEN_GLYPH_ADVANCE_PX / (scale * fontScale) }],
    [styles.hidden, scale, fontScale],
  );
  const field = useRef<TextInput>(null);
  const [text, setText] = useState(model.text);
  const [forced, setForced] = useState<Selection | undefined>(undefined);
  const [, setNonce] = useState(0);
  const textRef = useRef(model.text);
  const seenSequence = useRef(model.replaceSequence);

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    blur: () => field.current?.blur(),
  }));

  // The host replaced the text (a send, a pick, a restore): push it into the field.
  useEffect(() => {
    if (model.replaceSequence === seenSequence.current) return;
    seenSequence.current = model.replaceSequence;
    textRef.current = model.text;
    setText(model.text);
    onTextChange(model.text);
    if (model.caret !== null) setForced({ start: model.caret, end: model.caret });
  }, [model.replaceSequence, model.text, model.caret, onTextChange]);

  const live = parsedFor === text ? references : [];

  const onChangeText = (next: string): void => {
    const before = textRef.current;
    // Guard against the pills of the text being edited. Key repeats (a held Backspace) arrive
    // before the parent re-parses the previous edit, and an empty list let them eat a pill's
    // markdown one character at a time.
    const guarded = guardEdit(before, next, parsedFor === before ? references : parse(before));
    if (guarded.kind === 'remove') {
      // The core answers with the text minus the whole reference; until then the field shows
      // what it had (the nonce re-renders it over the half-deleted pill).
      dispatch({ type: 'removeAttachment', text: before, start: guarded.reference.start, end: guarded.reference.end });
      setNonce((value) => value + 1);
      return;
    }
    const value = guarded.kind === 'rewrite' ? guarded.text : next;
    const edit = diffEdit(before, value);
    const caret = guarded.kind === 'rewrite' ? guarded.caret : edit.start + edit.inserted.length;
    textRef.current = value;
    setText(value);
    onTextChange(value);
    if (guarded.kind === 'rewrite') setForced({ start: caret, end: caret });
    input.edited(value, { start: caret, end: caret });
    onCaret(caret);
  };

  const onSelectionChange = (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>): void => {
    const selection = event.nativeEvent.selection;
    if (forced !== undefined) setForced(undefined);
    if (selection.start === selection.end) {
      const snapped = snapCaret(selection.end, live);
      if (snapped !== null) {
        setForced({ start: snapped, end: snapped });
        input.selected({ start: snapped, end: snapped });
        onCaret(snapped);
        return;
      }
    }
    input.selected(selection);
    onCaret(selection.end);
  };

  const children = useMemo(() => {
    if (live.length === 0) return null;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    live.forEach((reference, index) => {
      if (reference.start > cursor) parts.push(text.slice(cursor, reference.start));
      const tint = P.reference[reference.kind] ?? P.reference.file;
      parts.push(
        <Text key={`h0:${index}`} style={hidden}>
          {text.slice(reference.start, reference.labelStart)}
        </Text>,
        <Text key={`l:${index}`} style={[styles.pill, { color: tint, backgroundColor: `${tint}26` }]}>
          {text.slice(reference.labelStart, reference.labelEnd)}
        </Text>,
        // The Side Chat pill covers `/btw ` with its space, which stays visible after the pill
        // (core `reference_pill_text`).
        <Text key={`h1:${index}`} style={reference.kind === 'sideChat' ? undefined : hidden}>
          {text.slice(reference.labelEnd, reference.end)}
        </Text>,
      );
      cursor = reference.end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }, [P, hidden, live, styles, text]);

  // A TextInput wraps its placeholder and cannot truncate it, so the collapsed field draws the
  // placeholder's first line itself, cut to one line with an ellipsis.
  const collapsedHint = collapsed && text.length === 0 ? (placeholder.split('\n')[0] ?? '') : null;
  const field_ = (
    <GhostexImageIntakeView onImages={onImages}>
      <TextInput
        ref={field}
        accessibilityLabel="Message composer"
        multiline
        scrollEnabled
        {...(children === null ? { value: text } : {})}
        {...(forced !== undefined ? { selection: forced } : {})}
        onChangeText={onChangeText}
        onSelectionChange={onSelectionChange}
        onFocus={() => input.focused()}
        onBlur={() => input.blurred()}
        placeholder={collapsed ? '' : placeholder}
        accessibilityHint={accessibilityHint}
        placeholderTextColor={P.placeholder}
        keyboardAppearance={P.light ? 'light' : 'dark'}
        autoCapitalize="sentences"
        textAlignVertical="top"
        style={[styles.input, collapsed ? styles.collapsed : { maxHeight }]}
        {...TEXT_DROPS}
      >
        {children}
      </TextInput>
    </GhostexImageIntakeView>
  );
  if (collapsedHint === null) return field_;
  return (
    <View>
      {field_}
      <Text style={[styles.hint, { color: P.placeholder }]} numberOfLines={1} pointerEvents="none">
        {collapsedHint}
      </Text>
    </View>
  );
});

const useStyles = themedStyles((P) => ({
  input: {
    color: P.foreground,
    fontSize: 15,
    lineHeight: 21,
    minHeight: 24,
    paddingTop: 2,
    paddingBottom: 2,
    paddingHorizontal: 0,
  },
  hint: { position: 'absolute', left: 0, right: 0, top: 2, fontSize: 15, lineHeight: 21 },
  collapsed: { height: COLLAPSED_INPUT_HEIGHT, maxHeight: COLLAPSED_INPUT_HEIGHT },
  pill: { fontWeight: '500' },
  /** The markdown around a pill's label: in the text, drawn with no width (letter spacing set per density). */
  hidden: { fontSize: 0.1, color: 'transparent' },
}));
