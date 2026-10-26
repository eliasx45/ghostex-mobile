/**
 * Draws one message body: the blocks `parse.ts` reads out of the core's marked Markdown, in the
 * React chat's prose styles (packages/core-ui/styles/chat.css, `.ghostex-chat-markdown`), the way
 * desktop's `rich_markdown.rs`, `markdown_style.rs`, `markdown_links.rs` and `code_block.rs` lay
 * them out. Links and file references dispatch `openMarkdownLink`, the action desktop sends.
 * Formulas are typeset by gxserver (`math.ts`, desktop `math_text.rs`).
 */

import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type TextStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { openChatTablePreview, tableCsv } from '../../cards';
import { useOptionalNativeChatUi, useTranscriptEnv } from '../context';
import { Glyph, type GlyphName } from '../icons';
import { arr, obj, str, type JsonRecord } from '../json';
import { CODE_SIZE, MONO_FONT, PROSE_LINE, PROSE_SIZE, type TranscriptTheme } from '../theme';
import { InlineImage, PictureStrip } from '../Images';
import { VisualBlock } from '../VisualBlock';
import { QuestionForm } from '../QuestionForm';
import { QUESTION_TAGS, type QuestionTagState } from '../OpenQuestions';
import { openTranscriptMenu } from '../transcriptMenuStore';
import { highlightText, useOwnFind, useRowFind, type RowFind } from '../searchHighlight';
import { inlineText, parseMarkdown, type Block, type FenceHeader, type Inline } from './parse';
import { BlockLongPress } from './blockLongPress';
import { isRunCommandHref } from './runCommands';
import { fitTableColumns } from './tableLayout';
import { MarkedSection, useMarkedEmoji, useMarkedStyle } from './MarkedSections';
import { mathColor, useMathLookup, type MathFormula, type MathLookup } from './math';

type Reference = { label: string; kind: string; state: string; title: string };

type InlineContext = {
  theme: TranscriptTheme;
  references: Map<string, Reference>;
  openLink(href: string): void;
  /** A long press on a link: the transcript menu's reference rows. */
  longPressLink: ((href: string) => void) | undefined;
  /** Whether prose and code take the platform's own text selection (see `TranscriptMenu.tsx`). */
  selectable: boolean;
  /** Transcript search's word highlight for the row this text is in (`searchHighlight.tsx`). */
  find: RowFind | null;
  /** False in a prompt somebody sent: its pictures stay small thumbnails (`pictureRuns`). */
  strips: boolean;
  /** The heading colour (levels 1 to 5): the theme's `primary` unless the row's lane sets one. */
  heading: string;
  /** Typeset formulas, or null where formulas stay the text they were written as (`math.ts`). */
  math: MathLookup | null;
  /** The colour and size of the text being drawn, which its formulas are typeset in. */
  color: string;
  size: number;
};

function referenceMap(references: unknown): Map<string, Reference> {
  const map = new Map<string, Reference>();
  for (const entry of arr(references)) {
    const reference = obj(entry);
    if (reference === null) continue;
    const href = str(reference, 'href');
    const sourceLabel = str(reference, 'sourceLabel');
    if (href.length === 0) continue;
    map.set(`${href}\u0000${sourceLabel}`, {
      label: str(reference, 'label'),
      kind: str(reference, 'kind'),
      state: str(reference, 'state'),
      title: str(reference, 'title'),
    });
  }
  return map;
}

const REFERENCE_GLYPHS: { [kind: string]: GlyphName } = {
  file: 'file',
  folder: 'folder',
  image: 'photo',
  skill: 'skill',
  url: 'link',
  comment: 'comment',
};

function linkColor(theme: TranscriptTheme, kind: string): string {
  return (theme.link as { [kind: string]: string })[kind] ?? theme.link.url;
}

function isExternal(href: string): boolean {
  return /^(https?|mailto):/i.test(href);
}

function renderInlines(
  inlines: readonly Inline[],
  context: InlineContext,
  keyPrefix: string,
  style?: TextStyle,
): ReactNode[] {
  return inlines.map((inline, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (inline.t) {
      case 'text':
        return highlightText(inline.v, context.find, key, style);
      case 'br':
        return '\n';
      case 'code':
        return (
          <Text
            key={key}
            style={[
              style,
              styles.inlineCode,
              { backgroundColor: context.theme.inlineCodeSurface, color: context.theme.primary },
            ]}
          >
            {'\u00a0'}
            {highlightText(inline.v, context.find, `${key}.code`)}
            {'\u00a0'}
          </Text>
        );
      case 'strong':
        return (
          <Text key={key} style={[style, styles.strong]}>
            {renderInlines(inline.c, context, key)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={[style, styles.em]}>
            {renderInlines(inline.c, context, key)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={[style, styles.del]}>
            {renderInlines(inline.c, context, key)}
          </Text>
        );
      case 'image':
        // Pictures are split out of their paragraph before this runs (`FlowParagraph`).
        return str(inline.image, 'label');
      case 'math': {
        const formula = typesetFormula(context, inline.latex, inline.display);
        if (formula === null) return highlightText(inline.source, context.find, key, style);
        return <InlineFormula key={key} formula={formula} label={inline.latex} />;
      }
      case 'link': {
        // An inline command stays the code it was written as; the phone runs it from the message's
        // long-press menu (`runCommands.ts`), never from a button on the message.
        if (isRunCommandHref(inline.href)) {
          return (
            <Text key={key} style={style}>
              {renderInlines(inline.c, context, key)}
            </Text>
          );
        }
        const reference = context.references.get(`${inline.href}\u0000${inline.label}`);
        if (reference?.kind === 'question')
          return <QuestionTagPill key={key} reference={reference} href={inline.href} context={context} />;
        const kind = reference?.kind ?? (isExternal(inline.href) ? 'url' : 'file');
        const color = linkColor(context.theme, kind);
        const glyph = reference !== undefined ? REFERENCE_GLYPHS[kind] : undefined;
        return (
          <Text
            key={key}
            style={[style, { color }]}
            suppressHighlighting={false}
            onPress={() => context.openLink(inline.href)}
            {...(context.longPressLink !== undefined
              ? { onLongPress: () => context.longPressLink?.(inline.href) }
              : {})}
            accessibilityRole="link"
          >
            {glyph !== undefined ? (
              <Text>
                <View style={styles.referenceIcon}>
                  <Glyph name={glyph} size={13} color={color} strokeWidth={2} />
                </View>{' '}
              </Text>
            ) : null}
            {reference !== undefined && reference.label.length > 0
              ? reference.label
              : renderInlines(inline.c, context, key)}
          </Text>
        );
      }
    }
  });
}

function typesetFormula(context: InlineContext, latex: string, display: boolean): MathFormula | null {
  const color = mathColor(context.color);
  if (context.math === null || color === null) return null;
  return context.math.formula(latex, display, context.size, color);
}

/**
 * A formula inside a line of text: its baseline on the text's (React Native sets an inline view's
 * bottom on the baseline), the part below it hanging into the line's descent as on the desktop.
 */
function InlineFormula({ formula, label }: { formula: MathFormula; label: string }) {
  return (
    <View
      style={{ width: formula.width, height: formula.baseline ?? formula.height }}
      accessible
      accessibilityLabel={label}
    >
      <SvgXml xml={formula.svg} width={formula.width} height={formula.height} style={styles.inlineFormula} />
    </View>
  );
}

/** A `$$…$$` block: centred on its own line, scaled down to the transcript's width when it is wider. */
function FormulaBlock({
  block,
  context,
  blockKey,
}: {
  block: Extract<Block, { t: 'math' }>;
  context: InlineContext;
  blockKey: string;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const formula = typesetFormula(context, block.latex, true);
  if (formula === null) {
    return (
      <Text selectable={context.selectable} style={[styles.prose, { color: context.color }]}>
        {highlightText(block.source, context.find, `${blockKey}.math`)}
      </Text>
    );
  }
  const fit = available !== null && formula.width > available ? available / formula.width : 1;
  return (
    <View
      style={[styles.formulaBlock, { paddingVertical: context.size * 0.3 }]}
      onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={block.latex}
    >
      <SvgXml xml={formula.svg} width={formula.width * fit} height={formula.height * fit} />
    </View>
  );
}

/**
 * A Q-tag (`Q80`) as an outlined pill in its question's state: amber with a ? while open, green with
 * a check once answered, grey and struck through once withdrawn. Desktop draws the same pill from
 * `question_tag_link` in `open_questions.rs`; the state is gx-chat-core's `TagState`.
 */
function QuestionTagPill({ reference, href, context }: { reference: Reference; href: string; context: InlineContext }) {
  const state = (reference.state in QUESTION_TAGS.tone.dark ? reference.state : 'open') as QuestionTagState;
  const tone = (context.theme.light ? QUESTION_TAGS.tone.light : QUESTION_TAGS.tone.dark)[state];
  const glyph = state === 'open' ? 'question-mark' : state === 'answered' ? 'check' : undefined;
  return (
    <Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={reference.title}
        onPress={() => context.openLink(href)}
        {...(context.longPressLink !== undefined ? { onLongPress: () => context.longPressLink?.(href) } : {})}
        style={({ pressed }) => [
          styles.questionTag,
          { borderColor: tone.border, backgroundColor: pressed ? tone.border : 'transparent' },
        ]}
      >
        {glyph !== undefined ? (
          <Glyph name={glyph} size={QUESTION_TAGS.iconSize} color={tone.text} strokeWidth={2.8} />
        ) : null}
        <Text style={[styles.questionTagLabel, { color: tone.text }, state === 'withdrawn' ? styles.del : null]}>
          {reference.label}
        </Text>
      </Pressable>
    </Text>
  );
}

/**
 * A paragraph with pictures in it, cut at its line breaks: consecutive lines made only of pictures
 * become one filmstrip, every other line keeps its words and inline thumbnails (`parse` in
 * desktop's `rich_markdown.rs` groups the same lines).
 */
function pictureRuns(inlines: Inline[]): { pictures: boolean; inlines: Inline[] }[] {
  const lines: Inline[][] = [[]];
  for (const inline of inlines) {
    if (inline.t === 'br') lines.push([]);
    else lines[lines.length - 1]!.push(inline);
  }
  const runs: { pictures: boolean; inlines: Inline[] }[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const pictures =
      line.some((inline) => inline.t === 'image') &&
      line.every((inline) => inline.t === 'image' || (inline.t === 'text' && inline.v.trim().length === 0));
    const last = runs[runs.length - 1];
    if (last !== undefined && last.pictures === pictures)
      last.inlines.push(...(pictures ? line : [{ t: 'br' } as Inline, ...line]));
    else runs.push({ pictures, inlines: [...line] });
  }
  return runs;
}

/** A paragraph with pictures in it: the run of words and thumbnails it was written as (`flow` in `rich_markdown.rs`). */
function FlowParagraph({ inlines, context, color }: { inlines: Inline[]; context: InlineContext; color: string }) {
  const parts: ({ kind: 'text'; inlines: Inline[] } | { kind: 'image'; image: JsonRecord })[] = [];
  for (const inline of inlines) {
    if (inline.t === 'image') parts.push({ kind: 'image', image: inline.image });
    else {
      const last = parts[parts.length - 1];
      if (last !== undefined && last.kind === 'text') last.inlines.push(inline);
      else parts.push({ kind: 'text', inlines: [inline] });
    }
  }
  return (
    <View style={styles.flow}>
      {parts.map((part, index) =>
        part.kind === 'image' ? (
          <InlineImage key={index} image={part.image} />
        ) : (
          <Text key={index} selectable={context.selectable} style={[styles.prose, { color }]}>
            {renderInlines(part.inlines, context, `f${index}`)}
          </Text>
        ),
      )}
    </View>
  );
}

const CELL_PAD_X = 12;
/** How many of a column's longest words are laid out to find its widest one. */
const TABLE_MEASURED_WORDS = 4;

/**
 * `markdown-visual.json` `codeBlock`: a fence longer than `collapseAfterLines` shows `collapsedLines`
 * lines and scrolls the rest under its header until the reader shows it whole.
 * CDXC:SessionChat 2026-10-08 SEE-ALSO: the desktop caps its blocks with the same numbers
 * (`apps/desktop/src/app/native_chat/markdown_style.rs`, `code_block_cap`).
 */
const CODE_COLLAPSED_LINES = 20;
const CODE_COLLAPSE_AFTER_LINES = 26;
/** `styles.codeText` line height and `styles.codeBody` vertical padding. */
const CODE_CAP = CODE_COLLAPSED_LINES * 17.5 + 12 * 2;

/** `markdown-visual.json`: the shared heading sizes, gaps and leading. */
const HEADING_SIZES = [0, 20, 18, 16, 14, 14, 14];
const HEADING_LINE = 1.3;

function CodeBlock({
  block,
  blockKey,
  selectable,
}: {
  block: Extract<Block, { t: 'code' }>;
  blockKey: string;
  selectable: boolean;
}) {
  const { theme, dispatch } = useTranscriptEnv();
  const [find, findDone] = useOwnFind(useRowFind());
  const [wrapped, setWrapped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = useMemo(() => block.text.split('\n').length > CODE_COLLAPSE_AFTER_LINES, [block.text]);
  const header: FenceHeader | null = block.header;
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(block.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [block.text]);
  const openHeader = header?.href;
  const separator = header === null ? -1 : Math.max(header.label.lastIndexOf('/'), header.label.lastIndexOf('\\'));
  const body = (
    <Text selectable={selectable} style={[styles.codeText, { color: theme.primary }]}>
      {highlightText(block.text, find, `${blockKey}.code`)}
    </Text>
  );
  findDone();
  const codeContent = wrapped ? (
    <View style={styles.codeBody}>{body}</View>
  ) : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeBody}>
      <BlockLongPress>{body}</BlockLongPress>
    </ScrollView>
  );
  return (
    <View
      style={[styles.codeBlock, { backgroundColor: theme.light ? '#fafafa' : '#171717', borderColor: theme.border }]}
      key={blockKey}
    >
      <View style={[styles.codeHeader, { borderBottomColor: theme.border }]}>
        {header !== null ? (
          <Pressable
            style={styles.codeTitle}
            disabled={openHeader === undefined}
            onPress={() =>
              openHeader !== undefined && dispatch({ type: 'openMarkdownLink', href: openHeader, external: false })
            }
            accessibilityRole="link"
            accessibilityLabel={`Open ${header.label}`}
          >
            <Glyph
              name={header.icon === 'markdown' ? 'markdown' : header.icon === 'file-code' ? 'file-code' : 'file'}
              size={13}
              color={theme.muted}
            />
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              style={[styles.codeHeaderText, { color: theme.muted, flexShrink: 1 }]}
            >
              {separator >= 0 ? header.label.slice(0, separator + 1) : ''}
              <Text style={{ color: theme.primary }}>
                {separator >= 0 ? header.label.slice(separator + 1) : header.label}
              </Text>
            </Text>
          </Pressable>
        ) : (
          <Text numberOfLines={1} style={[styles.codeHeaderText, { color: theme.muted, flexShrink: 1 }]}>
            {block.lang.toLowerCase() || 'text'}
          </Text>
        )}
        <View style={styles.codeActions}>
          {long ? (
            <Pressable
              hitSlop={6}
              style={styles.codeAction}
              onPress={() => setExpanded((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse code' : 'Show all code'}
              accessibilityState={{ expanded }}
            >
              <Glyph name={expanded ? 'arrows-diagonal-minimize' : 'arrows-diagonal'} size={14} color={theme.muted} />
            </Pressable>
          ) : null}
          <Pressable
            hitSlop={6}
            style={[styles.codeAction, wrapped && { backgroundColor: theme.pressed }]}
            onPress={() => setWrapped((value) => !value)}
            accessibilityRole="button"
            accessibilityLabel={wrapped ? 'Turn off line wrap' : 'Wrap lines'}
            accessibilityState={{ selected: wrapped }}
          >
            <Glyph name="text-wrap" size={14} color={wrapped ? theme.foreground : theme.muted} />
          </Pressable>
          {block.run !== null ? (
            <Pressable
              hitSlop={6}
              style={[styles.codeAction, styles.codeRunAction]}
              onPress={() => block.run !== null && dispatch({ type: 'runInTerminal', command: block.run })}
              accessibilityRole="button"
              accessibilityLabel="Run in terminal"
            >
              <Glyph name="terminal-2" size={14} color={theme.muted} />
              <Text style={[styles.codeRunLabel, { color: theme.muted }]}>Run</Text>
            </Pressable>
          ) : null}
          <Pressable
            hitSlop={6}
            style={styles.codeAction}
            onPress={copy}
            accessibilityRole="button"
            accessibilityLabel="Copy code"
          >
            <Glyph name={copied ? 'check' : 'copy'} size={14} color={theme.muted} />
          </Pressable>
        </View>
      </View>
      {long && !expanded ? (
        // The transcript is a list too, so Android needs `nestedScrollEnabled` for the code to scroll on its own.
        <ScrollView nestedScrollEnabled style={{ maxHeight: CODE_CAP }}>
          {codeContent}
        </ScrollView>
      ) : (
        codeContent
      )}
    </View>
  );
}

function Table({ block, context: rowContext }: { block: Extract<Block, { t: 'table' }>; context: InlineContext }) {
  const { theme } = useTranscriptEnv();
  // The table renders again on its own once its columns are measured; its occurrences keep their
  // numbers then (`useOwnFind`), and the invisible measuring copy marks none.
  const [find, findDone] = useOwnFind(rowContext.find);
  const context = { ...rowContext, find };
  const measureContext = { ...rowContext, find: null };
  const headColor = { color: theme.foreground };
  const cellColor = { color: theme.prose };
  const { width } = useWindowDimensions();
  const [collapsed, setCollapsed] = useState(false);
  // The table fits the transcript's width (`fitTableColumns`). React Native has no table layout,
  // so both of a column's widths are measured from an invisible copy of the cells laid out without
  // a width limit (each column's cells, and its longest words alone); until that layout lands, an
  // estimate from the prose size stands in. A column reports only when its width changes, so the
  // last report per column stays valid.
  const [available, setAvailable] = useState<number | null>(null);
  const [measured, setMeasured] = useState<{ max: number[]; min: number[] } | null>(null);
  const pending = useRef<{ max: number[]; min: number[] }>({ max: [], min: [] });
  const longWords = useMemo(
    () =>
      block.head.map((cell, column) => {
        const words = [cell, ...block.rows.map((row) => row[column] ?? [])].flatMap((inlines) =>
          inlineText(inlines).split(/\s+/),
        );
        return [...new Set(words.filter((word) => word.length > 0))]
          .sort((a, b) => b.length - a.length)
          .slice(0, TABLE_MEASURED_WORDS);
      }),
    [block],
  );
  const columns = useMemo(() => {
    let natural: number[];
    let word: number[];
    if (measured !== null && measured.max.length === block.head.length) ({ max: natural, min: word } = measured);
    else {
      natural = block.head.map((cell) => inlineText(cell).length * 7.9);
      for (const row of block.rows) {
        row.forEach((cell, column) => {
          natural[column] = Math.max(natural[column] ?? 0, inlineText(cell).length * 7.3);
        });
      }
      word = longWords.map((words) => (words[0]?.length ?? 0) * 7.9);
    }
    const extents = natural.map((max, column) => ({ max, min: word[column] ?? 0 }));
    return fitTableColumns(extents, 1 + CELL_PAD_X * 2, available ?? width, PROSE_SIZE);
  }, [block, measured, longWords, available, width]);
  const report = (kind: 'max' | 'min', column: number, columnWidth: number) => {
    const widths = pending.current;
    widths[kind][column] = columnWidth;
    const complete = (values: number[]) => block.head.every((_, index) => typeof values[index] === 'number');
    if (!complete(widths.max) || !complete(widths.min)) return;
    const next = {
      max: block.head.map((_, index) => widths.max[index]!),
      min: block.head.map((_, index) => widths.min[index]!),
    };
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    setMeasured((current) =>
      current !== null && same(current.max, next.max) && same(current.min, next.min) ? current : next,
    );
  };
  const cellStyle = (column: number) => {
    const align = block.align[column] ?? null;
    return [
      styles.tableCell,
      { width: columns[column] },
      align === 'right' ? styles.right : align === 'center' ? styles.center : null,
    ];
  };
  const lines = collapsed ? 1 : undefined;
  const table = (
    <View style={styles.table}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      >
        <View
          style={styles.tableMeasure}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {block.head.map((cell, column) => (
            <View
              key={column}
              style={styles.tableMeasureColumn}
              onLayout={(event) => report('max', column, event.nativeEvent.layout.width)}
            >
              <Text style={[styles.tableText, styles.strong]}>
                {renderInlines(cell, { ...measureContext, ...headColor }, `mh${column}`)}
              </Text>
              {block.rows.map((row, rowIndex) => (
                <Text key={rowIndex} style={styles.tableText}>
                  {renderInlines(row[column] ?? [], { ...measureContext, ...cellColor }, `mr${rowIndex}.${column}`)}
                </Text>
              ))}
            </View>
          ))}
          {longWords.map((words, column) => (
            <View
              key={`w${column}`}
              style={styles.tableMeasureColumn}
              onLayout={(event) => report('min', column, event.nativeEvent.layout.width)}
            >
              {words.map((word, wordIndex) => (
                <Text key={wordIndex} style={[styles.tableText, styles.strong]}>
                  {word}
                </Text>
              ))}
            </View>
          ))}
        </View>
        <BlockLongPress>
          <View style={[styles.tableRow, { borderBottomColor: theme.border }]}>
            {block.head.map((cell, column) => (
              <View key={column} style={cellStyle(column)}>
                <Text
                  numberOfLines={lines}
                  selectable={context.selectable}
                  style={[styles.tableText, styles.strong, { color: theme.foreground }]}
                >
                  {renderInlines(cell, { ...context, ...headColor }, `h${column}`)}
                </Text>
              </View>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[
                styles.tableRow,
                { borderBottomColor: theme.light ? 'rgba(229,229,229,0.6)' : 'rgba(29,29,29,0.6)' },
              ]}
            >
              {row.map((cell, column) => (
                <View key={column} style={cellStyle(column)}>
                  <Text
                    numberOfLines={lines}
                    selectable={context.selectable}
                    style={[styles.tableText, { color: theme.prose }]}
                  >
                    {renderInlines(cell, { ...context, ...cellColor }, `r${rowIndex}.${column}`)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </BlockLongPress>
      </ScrollView>
      <View style={styles.tableActions}>
        <TableAction
          label="Open table"
          glyph="maximize"
          theme={theme}
          onPress={() => openChatTablePreview(block.source)}
        />
        <TableAction
          label={collapsed ? 'Expand cells' : 'Collapse cells'}
          glyph={collapsed ? 'chevron-down' : 'chevron-up'}
          theme={theme}
          onPress={() => setCollapsed((value) => !value)}
        />
        <TableAction
          label="Copy as Markdown"
          text="MD"
          theme={theme}
          onPress={() => void Clipboard.setStringAsync(block.source)}
        />
        <TableAction
          label="Copy as CSV"
          text="CSV"
          theme={theme}
          onPress={() => void Clipboard.setStringAsync(tableCsv(block.source))}
        />
      </View>
    </View>
  );
  findDone();
  return table;
}

function TableAction({
  label,
  glyph,
  text,
  theme,
  onPress,
}: {
  label: string;
  glyph?: GlyphName;
  text?: string;
  theme: TranscriptTheme;
  onPress(): void;
}) {
  return (
    <Pressable
      hitSlop={4}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tableAction, pressed && { backgroundColor: theme.pressed }]}
    >
      {glyph !== undefined ? (
        <Glyph name={glyph} size={14} color={theme.muted} />
      ) : (
        <Text style={[styles.tableActionText, { color: theme.muted }]}>{text}</Text>
      )}
    </Pressable>
  );
}

const ALERTS: { [kind: string]: { label: string; glyph: GlyphName } } = {
  note: { label: 'Note', glyph: 'info-circle' },
  tip: { label: 'Tip', glyph: 'bulb' },
  important: { label: 'Important', glyph: 'message-report' },
  warning: { label: 'Warning', glyph: 'alert-triangle' },
  caution: { label: 'Caution', glyph: 'alert-octagon' },
};

const BULLETS = ['•', '◦', '▪'];

function orderedLabel(value: number, depth: number): string {
  if (depth % 3 === 1) {
    let label = '';
    let remaining = value;
    while (remaining > 0) {
      remaining -= 1;
      label = String.fromCharCode(97 + (remaining % 26)) + label;
      remaining = Math.floor(remaining / 26);
    }
    return `${label}.`;
  }
  if (depth % 3 === 2) {
    const numerals: [number, string][] = [
      [10, 'x'],
      [9, 'ix'],
      [5, 'v'],
      [4, 'iv'],
      [1, 'i'],
    ];
    let label = '';
    let remaining = value;
    for (const [amount, numeral] of numerals) {
      while (remaining >= amount) {
        label += numeral;
        remaining -= amount;
      }
    }
    return `${label}.`;
  }
  return `${value}.`;
}

type BlockProps = {
  blocks: Block[];
  context: InlineContext;
  color: string;
  depth: number;
  listDepth: { ordered: number; bullet: number };
};

function Blocks({ blocks, context: outer, color, depth, listDepth }: BlockProps) {
  const context = outer.color === color ? outer : { ...outer, color };
  const { theme } = context;
  const markedStyle = useMarkedStyle();
  const markedEmoji = useMarkedEmoji();
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${depth}.${index}`;
        const spacing = index === 0 ? null : block.t === 'h' ? styles.headingGap : styles.blockGap;
        switch (block.t) {
          case 'p':
            if (block.c.some((inline) => inline.t === 'image')) {
              return (
                <View key={key} style={[spacing, styles.pictureLines]}>
                  {(context.strips ? pictureRuns(block.c) : [{ pictures: false, inlines: block.c }]).map((run, part) =>
                    run.pictures ? (
                      <PictureStrip
                        key={part}
                        images={run.inlines.flatMap((inline) => (inline.t === 'image' ? [inline.image] : []))}
                      />
                    ) : (
                      <FlowParagraph key={part} inlines={run.inlines} context={context} color={color} />
                    ),
                  )}
                </View>
              );
            }
            return (
              <Text key={key} selectable={context.selectable} style={[styles.prose, { color }, spacing]}>
                {renderInlines(block.c, context, key)}
              </Text>
            );
          case 'h':
            return (
              <Text
                key={key}
                selectable={context.selectable}
                accessibilityRole="header"
                style={[
                  styles.heading,
                  {
                    fontSize: HEADING_SIZES[block.level] ?? PROSE_SIZE,
                    lineHeight: (HEADING_SIZES[block.level] ?? PROSE_SIZE) * HEADING_LINE,
                  },
                  { color: block.level === 6 ? theme.muted : context.heading },
                  spacing,
                  styles.headingBottom,
                ]}
              >
                {renderInlines(
                  block.c,
                  {
                    ...context,
                    color: block.level === 6 ? theme.muted : context.heading,
                    size: (context.size / PROSE_SIZE) * (HEADING_SIZES[block.level] ?? PROSE_SIZE),
                  },
                  key,
                )}
              </Text>
            );
          case 'math':
            return (
              <View key={key} style={spacing}>
                <FormulaBlock block={block} context={context} blockKey={key} />
              </View>
            );
          case 'code':
            return (
              <View key={key} style={spacing}>
                <CodeBlock block={block} blockKey={key} selectable={context.selectable} />
              </View>
            );
          case 'visual':
            return (
              <View key={key} style={spacing}>
                <VisualBlock source={block.source} />
              </View>
            );
          case 'questions':
            return (
              <View key={key} style={spacing}>
                <QuestionForm id={block.id} source={block.source} />
              </View>
            );
          case 'hr':
            return <View key={key} style={[styles.rule, { backgroundColor: theme.border }, spacing]} />;
          case 'section':
            return (
              <View key={key} style={spacing}>
                <MarkedSection
                  meta={block.meta}
                  style={markedStyle}
                  emoji={markedEmoji}
                  theme={theme}
                  color={color}
                  selectable={context.selectable}
                  all={
                    <Blocks
                      blocks={block.all}
                      context={context}
                      color={color}
                      depth={depth + 1}
                      listDepth={listDepth}
                    />
                  }
                  rest={
                    block.rest.length > 0 ? (
                      <View style={styles.blockGap}>
                        <Blocks
                          blocks={block.rest}
                          context={context}
                          color={color}
                          depth={depth + 1}
                          listDepth={listDepth}
                        />
                      </View>
                    ) : null
                  }
                  label={renderInlines(block.label, context, `${key}.label`)}
                  first={
                    <Blocks
                      blocks={block.first}
                      context={context}
                      color={color}
                      depth={depth + 1}
                      listDepth={listDepth}
                    />
                  }
                />
              </View>
            );
          case 'quote':
            return (
              <View key={key} style={[styles.quote, { borderLeftColor: theme.border }, spacing]}>
                <Blocks
                  blocks={block.c}
                  context={context}
                  color={theme.muted}
                  depth={depth + 1}
                  listDepth={listDepth}
                />
              </View>
            );
          case 'alert': {
            const alert = ALERTS[block.kind] ?? ALERTS.note!;
            const accent = (theme.alert as { [kind: string]: string })[block.kind] ?? theme.alert.note;
            return (
              <View key={key} style={[styles.alert, { borderLeftColor: accent }, spacing]}>
                <View style={styles.alertTitle}>
                  <Glyph name={alert.glyph} size={15} color={accent} />
                  <Text style={[styles.alertTitleText, { color: accent }]}>{alert.label}</Text>
                </View>
                <Blocks blocks={block.c} context={context} color={color} depth={depth + 1} listDepth={listDepth} />
              </View>
            );
          }
          case 'table':
            return (
              <View key={key} style={spacing}>
                <Table block={block} context={context} />
              </View>
            );
          case 'list': {
            const nested = block.ordered
              ? { ...listDepth, ordered: listDepth.ordered + 1 }
              : { ...listDepth, bullet: listDepth.bullet + 1 };
            const widest = block.ordered ? orderedLabel(block.start + block.items.length - 1, listDepth.ordered) : '';
            const gutter = block.ordered ? Math.max(20, widest.length * 8 + 4) : 20;
            return (
              <View key={key} style={spacing}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.listItem, itemIndex > 0 && styles.listItemGap]}>
                    <View style={[styles.listMarker, { width: gutter }]}>
                      {item.checked !== null ? (
                        <View
                          style={[
                            styles.checkbox,
                            { borderColor: theme.muted },
                            item.checked && { backgroundColor: theme.muted },
                          ]}
                        >
                          {item.checked ? (
                            <Glyph name="check" size={10} color={theme.background} strokeWidth={3} />
                          ) : null}
                        </View>
                      ) : (
                        <Text style={[styles.prose, { color: theme.muted }]}>
                          {block.ordered
                            ? orderedLabel(block.start + itemIndex, listDepth.ordered)
                            : BULLETS[listDepth.bullet % BULLETS.length]}
                        </Text>
                      )}
                    </View>
                    <View style={styles.listBody}>
                      {/* A done task steps back so the open ones stand out, as on the desktop. */}
                      <Blocks
                        blocks={item.c}
                        context={context}
                        color={item.checked ? theme.muted : color}
                        depth={depth + 1}
                        listDepth={nested}
                      />
                    </View>
                  </View>
                ))}
              </View>
            );
          }
        }
      })}
    </>
  );
}

export type MarkdownProps = {
  text: string;
  /** The message's `markdownReferences`: the pill label and kind of each link, by href and source label. */
  references?: unknown;
  /** The running text colour; defaults to the answer's prose tone. */
  color?: string;
  /** The headings' colour; defaults to the theme's `primary` (Grey thinking sets it, desktop `thinking_lane`). */
  headingColor?: string;
  /** Text somebody typed: single newlines are line breaks. */
  breaks?: boolean;
  /** False on iOS for a message with a menu, whose native view selects its words (`messageSelection.tsx`). */
  selectable?: boolean;
  /** False in a sent prompt, whose pictures keep their small thumbnails instead of a filmstrip. */
  strips?: boolean;
};

export const Markdown = memo(function Markdown({
  text,
  references,
  color,
  headingColor,
  breaks = false,
  selectable = true,
  strips = true,
}: MarkdownProps) {
  const { theme, dispatch } = useTranscriptEnv();
  const find = useRowFind();
  const math = useMathLookup(useOptionalNativeChatUi()?.renderMath ?? null);
  // Text follows the system's text size, so the formulas are typeset at the size it draws at.
  const { fontScale } = useWindowDimensions();
  const blocks = useMemo(() => parseMarkdown(text, { breaks }), [breaks, text]);
  const referencesMap = useMemo(() => referenceMap(references), [references]);
  const openLink = useCallback(
    (href: string) => dispatch({ type: 'openMarkdownLink', href, external: false }),
    [dispatch],
  );
  const context = useMemo<InlineContext>(
    () => ({
      theme,
      references: referencesMap,
      openLink,
      longPressLink: (href: string) => openTranscriptMenu({ href }),
      selectable,
      find,
      strips,
      heading: headingColor ?? theme.primary,
      math,
      color: color ?? theme.prose,
      size: PROSE_SIZE * fontScale,
    }),
    [color, find, fontScale, headingColor, math, openLink, referencesMap, selectable, strips, theme],
  );
  return (
    <View style={styles.root}>
      <Blocks
        blocks={blocks}
        context={context}
        color={color ?? theme.prose}
        depth={0}
        listDepth={{ ordered: 0, bullet: 0 }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { minWidth: 0, flexShrink: 1 },
  prose: { fontSize: PROSE_SIZE, lineHeight: PROSE_LINE },
  strong: { fontWeight: '600' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: MONO_FONT, fontSize: CODE_SIZE },
  referenceIcon: { width: 13, height: 13, transform: [{ translateY: 2 }] },
  inlineFormula: { position: 'absolute', left: 0, top: 0 },
  formulaBlock: { alignItems: 'center' },
  questionTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: QUESTION_TAGS.gap,
    paddingHorizontal: QUESTION_TAGS.paddingX,
    borderWidth: 1,
    borderRadius: QUESTION_TAGS.radius,
    transform: [{ translateY: 4 }],
  },
  questionTagLabel: { fontSize: PROSE_SIZE - 1, lineHeight: PROSE_SIZE + 4, fontWeight: '600' },
  flow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  pictureLines: { gap: 6 },
  blockGap: { marginTop: 10.4 },
  headingGap: { marginTop: 20 },
  headingBottom: { marginBottom: 0 },
  heading: { fontWeight: '600' },
  rule: { height: 1 },
  quote: { borderLeftWidth: 2, paddingLeft: 12 },
  alert: { borderLeftWidth: 2, paddingLeft: 12 },
  alertTitle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  alertTitleText: { fontSize: PROSE_SIZE, fontWeight: '600', lineHeight: 20 },
  listItem: { flexDirection: 'row' },
  listItemGap: { marginTop: 4 },
  listMarker: { alignItems: 'flex-start' },
  listBody: { flex: 1, minWidth: 0 },
  checkbox: {
    width: 13,
    height: 13,
    borderWidth: 1,
    borderRadius: 3,
    marginTop: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBlock: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  codeHeader: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    borderBottomWidth: 1,
  },
  codeTitle: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, minWidth: 0 },
  codeHeaderText: { fontFamily: MONO_FONT, fontSize: 11 },
  codeActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  codeAction: { width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  codeRunAction: { width: 'auto', flexDirection: 'row', gap: 3, paddingHorizontal: 6 },
  codeRunLabel: { fontSize: 11, fontWeight: '500' },
  codeBody: { paddingHorizontal: 14, paddingVertical: 12 },
  codeText: { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: 17.5 },
  table: { gap: 2 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1 },
  tableMeasure: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 10000,
    flexDirection: 'row',
    alignItems: 'flex-start',
    opacity: 0,
  },
  tableMeasureColumn: { alignItems: 'flex-start' },
  tableCell: { paddingHorizontal: CELL_PAD_X, paddingVertical: 7 },
  tableText: { fontSize: PROSE_SIZE, lineHeight: 20 },
  right: { alignItems: 'flex-end' },
  center: { alignItems: 'center' },
  tableActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 2 },
  tableAction: {
    minWidth: 26,
    height: 24,
    paddingHorizontal: 5,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableActionText: { fontSize: 11, fontWeight: '600' },
});
