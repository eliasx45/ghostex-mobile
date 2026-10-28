/**
 * The run of tool rows under a message (desktop `tool_run.rs`): a per-tool glyph and one-line
 * preview, the "+N previous tool calls" fold, failed results in the error tone, the subagent link,
 * and each row's arguments and result, which the core ships only while the row is open.
 */

import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ProjectedMessage } from '../../rust/document';
import { subagentOpenAction } from '../cards';
import { useNativeChatUi, useRowDetail, useTranscriptEnv, useTranscriptFlags } from './context';
import { DisclosureBody, DisclosureHeading, useFoldPlace } from './Disclosure';
import { Glyph, toolGlyph } from './icons';
import { arr, obj, str, type JsonRecord } from './json';
import { highlightLabel, useRowFind } from './searchHighlight';
import { useDisclosure } from './state';
import { openTranscriptMenu } from './transcriptMenuStore';
import { CODE_LINE, CODE_SIZE, MONO_FONT, PROSE_LINE, PROSE_SIZE } from './theme';

/** Each row carries its own padding (the 2026-10-11 work look), so the gap between rows is small. */
const ROW_GAP = 2;
/** A row's padding beside its glyph tile, and the tile's side (desktop `tool_run.rs`). */
const ROW_PAD_X = 8;
const TILE = 22;
/**
 * A described tool row's label: the agent's prose colour, 20% dimmer.
 * SEE-ALSO: apps/desktop/src/app/native_chat/tool_run.rs (`DESCRIBED_LABEL_OPACITY`).
 */
const DESCRIBED_LABEL_OPACITY = 0.8;

/** A `#rrggbb` theme colour at an alpha (a nested `Text` run ignores `opacity`). */
function dimmed(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * The tool rows of one message, folded the way the core's `toolFold` says, or in Simple mode
 * behind one "N tool calls" heading (desktop `tool_run.rs`).
 */
export function ToolRows({ message }: { message: ProjectedMessage }) {
  const { theme, simple } = useTranscriptEnv();
  const { workflowCards } = useTranscriptFlags();
  const { disclosures } = useNativeChatUi();
  const { inWorkFold } = useFoldPlace();
  const tools = arr(message.tools)
    .map((tool) => obj(tool))
    .filter((tool): tool is JsonRecord => tool !== null);
  const runKey = `tool-run:${message.id}`;
  const [runOpen, toggleRun] = useDisclosure(disclosures, runKey);
  // Simple mode's run heading opens on demand only; verbose mode never opens it. A call waiting on
  // an approval opens it (gx-chat-core `approval_wait.rs`).
  const awaiting = tools.some((tool) => tool.awaitingApproval === true);
  const [simpleOpen, toggleSimple] = useDisclosure(disclosures, `tools:${message.id}`, awaiting);
  if (tools.length === 0) return null;
  // Under a heading that already folds the run, every row shows (React's `showAllRows`).
  const showAll = message.toolsShowAllRows === true;
  // An answered question is its own exchange card and a message sent to another agent its own message
  // card; each stays a plain row only where its card shows elsewhere.
  const cardsAsRows = showAll || inWorkFold;
  const visible = tools
    .map((_, index) => index)
    .filter(
      (index) =>
        cardsAsRows ||
        (tools[index]!.exchange !== true &&
          tools[index]!.sentMessage !== true &&
          // A Workflow call with a run to show is drawn as its card (`WorkflowCard.tsx`).
          obj(workflowCards[str(tools[index]!, 'workflow')]) === null),
    );
  if (visible.length === 0) return null;
  const fold = obj(message.toolFold);
  const hidden = typeof fold?.hiddenCount === 'number' ? fold.hiddenCount : 0;
  const rows = (indices: number[]) =>
    indices.map((index) => <ToolRow key={index} messageId={message.id} index={index} tool={tools[index]!} />);
  if (simple && !showAll) {
    return (
      <View style={styles.column}>
        <DisclosureHeading label={str(message, 'simpleToolLabel')} open={simpleOpen} onToggle={toggleSimple} />
        {simpleOpen ? (
          <DisclosureBody onCollapse={toggleSimple} label="Collapse tool calls" gap={ROW_GAP}>
            {rows(visible)}
          </DisclosureBody>
        ) : null}
      </View>
    );
  }
  if (showAll || hidden === 0) return <View style={styles.column}>{rows(visible)}</View>;
  const keptFlags = arr(fold?.visible);
  // The toggle sits right before the last call, open or closed, so what it reveals lands above it
  // (gx-chat-core `tool_run_fold`, `toggleBefore`).
  const before = typeof fold?.toggleBefore === 'number' ? fold.toggleBefore : Number.MAX_SAFE_INTEGER;
  const label = str(fold, runOpen ? 'expandedLabel' : 'collapsedLabel');
  const toggle = (
    <Pressable
      onPress={toggleRun}
      accessibilityRole="button"
      accessibilityState={{ expanded: runOpen }}
      style={({ pressed }) => [styles.foldToggle, pressed && { backgroundColor: theme.pressed }]}
    >
      {/* The chevron sits in a slot as wide as the rows' glyph tiles, so the label starts where their names do. */}
      <View style={styles.foldSlot}>
        <Glyph name={runOpen ? 'chevron-down' : 'chevron-right'} size={14} color={theme.muted} />
      </View>
      <Text style={[styles.foldLabel, { color: theme.muted }]}>{label}</Text>
    </Pressable>
  );
  if (runOpen) {
    return (
      <DisclosureBody onCollapse={toggleRun} label={str(fold, 'expandedLabel') || 'Show fewer steps'} gap={ROW_GAP}>
        {rows(visible.filter((index) => index < before))}
        {toggle}
        {rows(visible.filter((index) => index >= before))}
      </DisclosureBody>
    );
  }
  return (
    <View style={styles.column}>
      {rows(visible.filter((index) => keptFlags[index] === true && index < before))}
      {toggle}
      {rows(visible.filter((index) => keptFlags[index] === true && index >= before))}
    </View>
  );
}

/**
 * A `!` command the user ran (`shellCard`, gx-chat-core's `shell_card`), in the user's bubble
 * (desktop `shell_command_card` in `tool_run.rs`): a header with the terminal glyph, the command and
 * its failure status, opening onto the output alone; Copy is in the long-press menu. It shows in Simple mode too, since it is
 * what the user typed. A running card opens on its output by default and folds like every
 * disclosure, from the header or the rail.
 */
export function ShellCommandCard({ message }: { message: ProjectedMessage }) {
  const { theme } = useTranscriptEnv();
  const { disclosures } = useNativeChatUi();
  const card = obj(message.shellCard);
  const hasBody = card?.hasBody === true;
  const [openState, toggle] = useDisclosure(disclosures, `shell:${message.id}`, card?.openByDefault === true);
  const fullCommand = str(card, 'fullCommand');
  const open = hasBody && openState;
  const failed = card?.failed === true;
  const status = str(card, 'status');
  const blocks = (
    [
      ['commandBody', false],
      ['stdout', false],
      ['stderr', true],
    ] as const
  )
    .map(([part, error]) => ({ part, error, content: str(card, part) }))
    .filter(({ content }) => content.trim().length > 0);
  return (
    <View style={styles.shellColumn}>
      <View style={[styles.shellBubble, styles.shellHeaderBubble, { backgroundColor: theme.input }]}>
        <View style={styles.shellHeader}>
          <Pressable
            onPress={hasBody ? toggle : undefined}
            // Holding the bubble opens the menu with Copy of the bare command.
            {...(fullCommand.length > 0 ? { onLongPress: () => openTranscriptMenu({ selection: fullCommand }) } : {})}
            accessibilityRole="button"
            accessibilityLabel={`Shell command: ${fullCommand}`}
            accessibilityHint="Long press for Copy"
            accessibilityState={{ expanded: open, disabled: !hasBody }}
            style={({ pressed }) => [
              styles.trigger,
              styles.shellTrigger,
              pressed && { backgroundColor: theme.pressed },
            ]}
          >
            <View style={styles.glyphSlot}>
              <Glyph name={toolGlyph('terminal')} size={14} color={theme.muted} />
            </View>
            <Text numberOfLines={1} style={[styles.shellCommand, { color: failed ? theme.error : theme.primary }]}>
              {str(card, 'command')}
            </Text>
            {hasBody ? <Glyph name={open ? 'chevron-down' : 'chevron-right'} size={12} color={theme.muted} /> : null}
            <View style={styles.shellSpacer} />
            {status.length > 0 ? (
              <Text style={[styles.shellStatus, { color: failed ? theme.error : theme.muted }]}>{status}</Text>
            ) : null}
          </Pressable>
        </View>
      </View>
      {/* The output opens in a bubble of its own below the header, which keeps its collapsed size;
          the header is its toggle, so it carries no rail. */}
      {open && blocks.length > 0 ? (
        <View style={[styles.shellBubble, styles.shellOutputBubble, { backgroundColor: theme.input }]}>
          {blocks.map(({ part, error, content }) => (
            <ToolBody key={part} label={null} content={content} failed={error} copyText="" />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const ToolRow = memo(function ToolRow({
  messageId,
  index,
  tool,
}: {
  messageId: string;
  index: number;
  tool: JsonRecord;
}) {
  const { theme, dispatch, simple } = useTranscriptEnv();
  const { disclosures } = useNativeChatUi();
  const key = `tool:${messageId}:${index}`;
  // A call waiting on an approval starts open so its command shows beside the card, and folds back
  // once it is answered unless the reader toggled it (gx-chat-core `approval_wait.rs`).
  const [open, toggle] = useDisclosure(disclosures, key, tool.awaitingApproval === true);
  const hasDetail = tool.hasDetail === true;
  const expanded = open && hasDetail;
  const detail = obj(useRowDetail(key, 'tool', messageId, index, expanded));
  const failed = tool.failed === true;
  // A call the agent described is named by that description in every mode, without its command
  // preview (gx-chat-core `tool_description`); opening the row shows the command.
  const described = str(tool, 'description').length > 0;
  const name = str(tool, 'label') || str(tool, 'name');
  const failure = str(tool, 'failure');
  const duration = str(tool, 'duration');
  const status = str(tool, 'status');
  // Simple mode and a description hide the command preview; a failed call says what failed after it.
  const argument = simple || described ? '' : str(tool, 'preview');
  const preview = failure.length === 0 ? argument : argument.length === 0 ? failure : `${argument} \u00b7 ${failure}`;
  const subagent = str(tool.subagent, 'name');
  const openSubagent = subagentOpenAction(tool.subagent);
  // A description reads as the agent's own prose: the reply's size and weight, a fifth dimmer.
  const heading = failed ? theme.error : described ? dimmed(theme.prose, DESCRIBED_LABEL_OPACITY) : theme.foreground;
  const nameStyle = described ? [styles.name, styles.described] : styles.name;
  // Holding a call that names a file opens that file's menu (Copy Path; CDXC:SessionChat 2026-10-17 in desktop `native_chat/file_actions.rs`).
  const filePath = str(tool, 'filePath');
  // The find's words in the name and the preview (core `visible_segments` searches both).
  const find = useRowFind();
  const nameText = highlightLabel(name, find, key);
  const trigger = (
    <Pressable
      disabled={!hasDetail && filePath.length === 0}
      onPress={hasDetail ? toggle : undefined}
      {...(filePath.length > 0 ? { onLongPress: () => openTranscriptMenu({ href: filePath }) } : {})}
      accessibilityRole="button"
      accessibilityLabel={
        subagent.length > 0
          ? `Tool ${name} (${subagent})`
          : argument.length > 0
            ? `Tool ${name}: ${argument}`
            : `Tool ${name}`
      }
      accessibilityState={{ expanded }}
      style={({ pressed }) => [
        styles.trigger,
        subagent.length === 0 && styles.triggerFill,
        failed && { backgroundColor: errorWash(theme.error) },
        pressed && { backgroundColor: theme.pressed },
      ]}
    >
      <View style={[styles.tile, { backgroundColor: theme.ink(0.05) }]}>
        <Glyph name={toolGlyph(str(tool, 'glyph'))} size={13} color={theme.muted} />
      </View>
      {preview.length > 0 && subagent.length === 0 ? (
        // One line with two runs (desktop `name_and_preview`): side by side, the mono preview sat
        // below the name's baseline; nested runs share one.
        <Text numberOfLines={1} style={[styles.nameLine, styles.fill]}>
          <Text style={[nameStyle, { color: heading }]}>{nameText}</Text>
          {' '}
          <Text style={[styles.preview, { color: theme.muted }]}>
            {highlightLabel(preview, find, `tool-preview:${messageId}:${index}`)}
          </Text>
        </Text>
      ) : (
        <Text numberOfLines={1} style={[nameStyle, subagent.length === 0 && styles.fill, { color: heading }]}>
          {nameText}
        </Text>
      )}
      {duration.length > 0 ? <Text style={[styles.duration, { color: theme.mutedInk(0.75) }]}>{duration}</Text> : null}
      {status === 'done' ? <Glyph name="check" size={13} color={successTone(theme.light)} /> : null}
      {status === 'failed' ? <Glyph name="x" size={13} color={theme.error} /> : null}
    </Pressable>
  );
  let body = null;
  if (expanded && detail !== null) {
    const input = str(detail, 'input');
    const output = str(detail, 'output');
    const command = tool.glyph === 'terminal';
    // The first block's label row carries the copy button, which copies the whole call (the core's `copyText`).
    const copyText = str(detail, 'copyText');
    const parts = [];
    if (input.length > 0) {
      parts.push(
        <ToolBody
          key="input"
          label={command ? 'Command' : output.length > 0 ? 'Input' : null}
          content={input}
          failed={false}
          copyText={copyText}
        />,
      );
    }
    if (output.length > 0) {
      parts.push(
        <ToolBody
          key="output"
          label={tool.hasCall === true ? 'Result' : null}
          content={output}
          failed={failed}
          copyText={parts.length === 0 ? copyText : ''}
        />,
      );
    }
    if (parts.length > 0) {
      // The rail hangs from the middle of the glyph tile, which the row's padding moved right of the
      // marker column the rail is measured from.
      body = (
        <View style={styles.detailInset}>
          <DisclosureBody onCollapse={toggle} label={`Collapse ${name}`} rail="tool">
            {parts}
          </DisclosureBody>
        </View>
      );
    }
  }
  return (
    <View style={styles.row}>
      {subagent.length === 0 ? (
        trigger
      ) : (
        <View style={styles.subagentLine}>
          {trigger}
          {openSubagent !== null ? (
            <Pressable
              onPress={() => dispatch(openSubagent)}
              accessibilityRole="button"
              accessibilityLabel={`View ${subagent}'s transcript`}
              style={styles.subagentLink}
            >
              <Text numberOfLines={1} style={[styles.subagentText, { color: theme.controlPrimary }]}>
                {subagent}
              </Text>
            </Pressable>
          ) : (
            <Text numberOfLines={1} style={[styles.subagentText, { color: theme.controlPrimary }]}>
              {subagent}
            </Text>
          )}
        </View>
      )}
      {body}
    </View>
  );
});

/** A finished call's check (desktop `ChatAppearance::success`). */
function successTone(light: boolean): string {
  return light ? '#059669' : '#34d399';
}

/** A failed row's tint: the error tone at 6%. */
function errorWash(error: string): string {
  return `${error}0f`;
}

/**
 * One labelled block of a tool's detail: verbatim monospaced text in a height-capped box, selectable
 * with a long press. A non-empty `copyText` puts the copy button for the whole call on its label row
 * (desktop `tool_run.rs`).
 */
function ToolBody({
  label,
  content,
  failed,
  copyText,
}: {
  label: string | null;
  content: string;
  failed: boolean;
  copyText: string;
}) {
  const { theme } = useTranscriptEnv();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [copyText]);
  return (
    <View style={styles.bodyGroup}>
      {label !== null || copyText.length > 0 ? (
        <View style={styles.bodyHeader}>
          <Text numberOfLines={1} style={[styles.bodyLabel, { color: theme.muted }]}>
            {label ?? ''}
          </Text>
          {copyText.length > 0 ? (
            <Pressable
              hitSlop={6}
              onPress={copy}
              accessibilityRole="button"
              accessibilityLabel={copied ? 'Copied' : 'Copy tool call'}
              style={({ pressed }) => [styles.copyAction, pressed && { backgroundColor: theme.pressed }]}
            >
              <Glyph name={copied ? 'check' : 'copy'} size={14} color={theme.muted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ScrollView
        nestedScrollEnabled
        style={[styles.bodyBox, { backgroundColor: theme.input }]}
        contentContainerStyle={styles.bodyContent}
      >
        <Text selectable style={[styles.bodyText, { color: failed ? theme.error : theme.muted }]}>
          {content}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: ROW_GAP, minWidth: 0 },
  shellColumn: { alignItems: 'flex-end', gap: 6 },
  shellBubble: { maxWidth: '80%', flexShrink: 1, minWidth: 0, borderRadius: 16 },
  shellHeaderBubble: { paddingHorizontal: 12, paddingVertical: 8 },
  shellOutputBubble: { gap: 4, padding: 2 },
  shellHeader: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  shellTrigger: { flex: 1 },
  shellCommand: { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: PROSE_LINE, flexShrink: 1, minWidth: 0 },
  shellSpacer: { flexGrow: 1 },
  shellStatus: { fontSize: 12.25, flexShrink: 0 },
  row: { gap: 4, minWidth: 0 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: ROW_PAD_X,
    paddingVertical: 5,
    borderRadius: 8,
    minWidth: 0,
    flexShrink: 1,
  },
  triggerFill: { alignSelf: 'stretch' },
  glyphSlot: { width: 16, marginLeft: 2, height: PROSE_LINE, alignItems: 'center', justifyContent: 'center' },
  tile: { width: TILE, height: TILE, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  fill: { flex: 1 },
  name: { fontSize: 13.5, lineHeight: 20, fontWeight: '500', flexShrink: 0 },
  described: { fontSize: PROSE_SIZE, fontWeight: '400' },
  preview: { fontFamily: MONO_FONT, fontSize: 12.3, fontWeight: '400', flexShrink: 1, minWidth: 0 },
  nameLine: { fontSize: 13.5, lineHeight: 20, flexShrink: 1, minWidth: 0 },
  duration: { fontSize: 11.5, flexShrink: 0, fontVariant: ['tabular-nums'] },
  detailInset: { paddingLeft: ROW_PAD_X + TILE / 2 - 10 },
  subagentLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  subagentLink: { flexShrink: 1, minWidth: 0 },
  subagentText: { fontSize: PROSE_SIZE, lineHeight: PROSE_LINE },
  foldToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: ROW_PAD_X,
    paddingVertical: 2,
    borderRadius: 8,
  },
  foldSlot: { width: TILE, height: PROSE_LINE, alignItems: 'center', justifyContent: 'center' },
  foldLabel: { fontSize: 13.5, lineHeight: PROSE_LINE },
  bodyGroup: { gap: 4, minWidth: 0 },
  bodyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  bodyLabel: { fontSize: 12.25, flexShrink: 1 },
  copyAction: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  bodyBox: { maxHeight: 220.75, borderRadius: 6 },
  bodyContent: { paddingHorizontal: 10, paddingVertical: 8 },
  bodyText: { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: CODE_LINE },
});
