/**
 * A small GFM parser for the transcript: blocks (paragraphs, ATX and setext headings, fences, lists
 * with nesting and task boxes, quotes, tables, rules, display formulas) and inlines (code, emphasis,
 * strikethrough, links, autolinks, hard breaks, formulas).
 *
 * The core ships each message's Markdown with its decisions already made and marked with the
 * private-use character U+E000 (`packages/gx-chat-core/src/transcript/native_markdown.rs`): a fence
 * that names a file carries its header JSON after the mark on the info string, a GitHub alert is a
 * marked section, a table, a finished Mermaid fence and a finished ```visual block are wrapped in marks, and a picture written
 * into prose is a marked token with its image source. This file only splits on those marks, exactly as desktop's
 * `rich_markdown.rs` and `code_block.rs` do, and parses the plain Markdown between them. No chat
 * rule lives here.
 */

import { obj, type JsonRecord } from '../json';

const MARK = '';
const ALERT_OPEN = `${MARK}alert:`;
const ALERT_CLOSE = `${MARK}/alert`;
const TABLE_OPEN = `${MARK}table`;
const TABLE_CLOSE = `${MARK}/table`;
const IMAGE_OPEN = `${MARK}image:`;
const MERMAID_OPEN = `${MARK}mermaid`;
const MERMAID_CLOSE = `${MARK}/mermaid`;
const VISUAL_OPEN = `${MARK}visual`;
const VISUAL_CLOSE = `${MARK}/visual`;
const QUESTIONS_OPEN = `${MARK}questions:`;
const QUESTIONS_CLOSE = `${MARK}/questions`;
const SECTION_OPEN = `${MARK}section:`;
const SECTION_CLOSE = `${MARK}/section`;

/** A marked section of an agent's reply, as the core described it (`marked_sections.rs`). */
export type SectionMeta = {
  kind: string;
  emoji: string;
  name: string;
  label: string;
  labelRepeats: boolean;
  plain?: string;
};

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  /** `label` is the link's source text, which `markdownReferences` is keyed by (`sourceLabel`). */
  | { t: 'link'; href: string; label: string; c: Inline[] }
  /** A marked picture: the projected image source (`images.rs`). */
  | { t: 'image'; image: JsonRecord }
  /** A formula (`$…$`, `\(…\)`; `display` for `$$…$$` and `\[…\]`): its LaTeX and the text it was written as. */
  | { t: 'math'; latex: string; display: boolean; source: string }
  | { t: 'br' };

/** What a fence's header shows, when the core named a file for it (`code_block.rs`). */
export type FenceHeader = { label: string; icon: string; href?: string };

export type Align = 'left' | 'center' | 'right' | null;

export type ListItem = { checked: boolean | null; c: Block[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  /** `run`: the command the block's Run button runs, decided by the core (`run_command.rs`). */
  | { t: 'code'; lang: string; header: FenceHeader | null; run: string | null; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'alert'; kind: string; c: Block[] }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][]; source: string }
  /** A finished ```visual fence: the block's JSON, drawn by `VisualBlock` (desktop `visual.rs`). */
  | { t: 'visual'; source: string }
  /** A finished ```questions fence: the form's id and its lines, drawn by `QuestionForm` (desktop `question_form.rs`). */
  | { t: 'questions'; id: string; source: string }
  /**
   * A marked section (`MarkedSections.tsx`): `all` is every line as written and `rest` the lines
   * after the first, for the styles that draw their own first line (the core ends the first line at
   * its label and moves what followed under it); `first` is the first line without its marker emoji,
   * for the thin rule with emojis off.
   */
  | { t: 'section'; meta: SectionMeta; all: Block[]; rest: Block[]; label: Inline[]; first: Block[] }
  /** A `$$…$$` or `\[…\]` block on lines of its own (`MathLine::Display` in gx-chat-core `math_text.rs`). */
  | { t: 'math'; latex: string; source: string }
  | { t: 'hr' };

export type ParseOptions = {
  /** Text somebody typed: a single newline is a line break (React's `chatText` mode). */
  breaks?: boolean;
};

/** A command the core percent-encoded into a fence header (`decode_command` in `run_command.rs`). */
function decodeCommand(encoded: string): string | null {
  try {
    const command = decodeURIComponent(encoded);
    return command.trim().length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** A marked fence's text: its lines without the opening and closing runs (desktop `mermaid.rs` `fence_source`). */
function fenceSource(fence: readonly string[]): string {
  const indentOf = (line: string) => line.length - line.replace(/^ +/, '').length;
  const indent = fence.length > 0 ? indentOf(fence[0]!) : 0;
  return fence
    .slice(1, Math.max(1, fence.length - 1))
    .map((line) => line.slice(Math.min(indentOf(line), indent)))
    .join('\n');
}

const cache = new Map<string, Block[]>();
const CACHE_LIMIT = 400;

/** Parses one message body. Results are cached by text, so a re-render costs a map lookup. */
export function parseMarkdown(source: string, options: ParseOptions = {}): Block[] {
  const key = `${options.breaks === true ? 'b' : 'n'}${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = new BlockParser(options).blocks(lines);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, blocks);
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIMITER = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function indentOf(line: string): number {
  return line.length - trimMarkdownStart(line).length;
}

/**
 * Markdown's whitespace is spaces and tabs only. JavaScript's `trim` also takes the no-break spaces
 * the core writes to keep a reply line's indentation (core `line_breaks.rs`, GitHub issue #252), so
 * the paragraph code trims with these instead.
 */
function trimMarkdownStart(line: string): string {
  return line.replace(/^[ \t]+/, '');
}

function trimMarkdown(line: string): string {
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

type ListMarker = { indent: number; bullet: string; ordered: boolean; start: number; content: number; rest: string };

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (match === null) return null;
  const [, lead, marker, spaces, rest] = match as unknown as [string, string, string, string, string];
  const ordered = /\d/.test(marker);
  // Five or more spaces after the marker start indented code in CommonMark; chat never means that.
  const gap = rest.length === 0 ? 1 : Math.min(spaces.length, 4);
  return {
    indent: lead.length,
    bullet: ordered ? marker.slice(-1) : marker,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    content: lead.length + marker.length + gap,
    rest,
  };
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index]!;
  const next = lines[index + 1];
  return next !== undefined && line.includes('|') && TABLE_DELIMITER.test(next) && next.includes('-');
}

/**
 * A display formula starting at `start`: a line opening with `$$` or `\[`, closed on it or on a
 * later line (no blank line between, at most 40 lines), with nothing after the close. The rule of
 * `math_lines` in gx-chat-core `math_text.rs`, which desktop draws with.
 */
function displayMath(lines: readonly string[], start: number): { latex: string; source: string; end: number } | null {
  const trimmed = trimMarkdown(lines[start] ?? '');
  const delimiters = trimmed.startsWith('$$') ? ['$$', '$$'] : trimmed.startsWith('\\[') ? ['\\[', '\\]'] : null;
  if (delimiters === null) return null;
  const [open, close] = delimiters as [string, string];
  const afterOpen = trimmed.slice(open.length);
  const sameLine = afterOpen.indexOf(close);
  if (sameLine >= 0) {
    const latex = afterOpen.slice(0, sameLine).trim();
    if (afterOpen.slice(sameLine + close.length).trim().length > 0 || latex.length === 0) return null;
    return { latex, source: trimmed, end: start + 1 };
  }
  const body = [afterOpen];
  for (let index = start + 1; index < lines.length && index <= start + 40; index += 1) {
    const next = trimMarkdown(lines[index]!);
    const at = next.indexOf(close);
    if (at >= 0) {
      if (next.slice(at + close.length).trim().length > 0) return null;
      body.push(next.slice(0, at));
      const latex = body.join('\n').trim();
      if (latex.length === 0) return null;
      return {
        latex,
        source: lines
          .slice(start, index + 1)
          .map(trimMarkdown)
          .join('\n'),
        end: index + 1,
      };
    }
    if (next.length === 0) return null;
    body.push(next);
  }
  return null;
}

class BlockParser {
  constructor(private readonly options: ParseOptions) {}

  inline(text: string): Inline[] {
    return parseInline(text, this.options.breaks === true);
  }

  /** Whether `line` starts a block that ends a running paragraph. */
  private interrupts(line: string): boolean {
    if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
    if (line.startsWith(SECTION_OPEN) || line === SECTION_CLOSE) return true;
    if (
      line.startsWith(ALERT_OPEN) ||
      line === TABLE_OPEN ||
      line === MERMAID_OPEN ||
      line === VISUAL_OPEN ||
      line.startsWith(QUESTIONS_OPEN)
    )
      return true;
    const marker = listMarker(line);
    // Only a bullet, or an ordered item starting at 1, interrupts a paragraph (CommonMark).
    return marker !== null && marker.indent <= 3 && marker.rest.length > 0 && (!marker.ordered || marker.start === 1);
  }

  blocks(lines: readonly string[]): Block[] {
    const out: Block[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        index += 1;
        continue;
      }
      if (line.startsWith(ALERT_OPEN)) {
        let depth = 1;
        let end = index + 1;
        while (end < lines.length) {
          if (lines[end]!.startsWith(ALERT_OPEN)) depth += 1;
          else if (lines[end] === ALERT_CLOSE && --depth === 0) break;
          end += 1;
        }
        out.push({
          t: 'alert',
          kind: line.slice(ALERT_OPEN.length).trim(),
          c: this.blocks(lines.slice(index + 1, end)),
        });
        index = end + 1;
        continue;
      }
      if (line.startsWith(SECTION_OPEN)) {
        let end = index + 1;
        while (end < lines.length && lines[end] !== SECTION_CLOSE) end += 1;
        const meta = parseJson<SectionMeta | null>(line.slice(SECTION_OPEN.length), null);
        const body = lines.slice(index + 1, end);
        if (meta !== null) {
          out.push({
            t: 'section',
            meta,
            all: this.blocks(body),
            rest: this.blocks(body.slice(1)),
            label: this.inline(meta.label),
            first: this.blocks([meta.plain ?? body[0] ?? '']),
          });
        } else {
          out.push(...this.blocks(body));
        }
        index = end + 1;
        continue;
      }
      // A finished ```mermaid fence arrives between these marks for the desktop's diagram card; the
      // phone does not draw diagrams yet, so the fence inside shows as the code block it is.
      if (line === MERMAID_OPEN || line === MERMAID_CLOSE) {
        index += 1;
        continue;
      }
      if (line.startsWith(QUESTIONS_OPEN)) {
        let end = index + 1;
        while (end < lines.length && lines[end] !== QUESTIONS_CLOSE) end += 1;
        out.push({
          t: 'questions',
          id: line.slice(QUESTIONS_OPEN.length),
          source: fenceSource(lines.slice(index + 1, end)),
        });
        index = end + 1;
        continue;
      }
      if (line === VISUAL_OPEN) {
        let end = index + 1;
        while (end < lines.length && lines[end] !== VISUAL_CLOSE) end += 1;
        out.push({ t: 'visual', source: fenceSource(lines.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
      if (line === TABLE_OPEN) {
        let end = index + 1;
        while (end < lines.length && lines[end] !== TABLE_CLOSE) end += 1;
        const body = lines.slice(index + 1, end);
        const table = body.length >= 2 ? this.table(body, 0) : null;
        if (table !== null) out.push(table.block);
        else if (body.some((entry) => !isBlank(entry))) out.push({ t: 'p', c: this.inline(body.join('\n')) });
        index = end + 1;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence !== null) {
        index = this.fence(lines, index, fence, out);
        continue;
      }
      const display = displayMath(lines, index);
      if (display !== null) {
        out.push({ t: 'math', latex: display.latex, source: display.source });
        index = display.end;
        continue;
      }
      const heading = ATX.exec(line);
      if (heading !== null) {
        out.push({ t: 'h', level: heading[1]!.length, c: this.inline((heading[2] ?? '').trim()) });
        index += 1;
        continue;
      }
      if (HR.test(line)) {
        out.push({ t: 'hr' });
        index += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const quoted: string[] = [];
        while (index < lines.length) {
          const current = lines[index]!;
          const match = QUOTE.exec(current);
          if (match !== null) quoted.push(match[1]!);
          else if (
            !isBlank(current) &&
            quoted.length > 0 &&
            !isBlank(quoted[quoted.length - 1]!) &&
            !this.interrupts(current)
          )
            quoted.push(current);
          else break;
          index += 1;
        }
        out.push({ t: 'quote', c: this.blocks(quoted) });
        continue;
      }
      const marker = listMarker(line);
      if (marker !== null && marker.indent <= 3) {
        index = this.list(lines, index, marker, out);
        continue;
      }
      if (isTableStart(lines, index)) {
        const table = this.table(lines, index);
        if (table !== null) {
          out.push(table.block);
          index = table.end;
          continue;
        }
      }
      // A paragraph: runs until a blank line or a line that starts another block.
      const paragraph: string[] = [trimMarkdown(line)];
      index += 1;
      let setext = 0;
      while (index < lines.length) {
        const current = lines[index]!;
        if (isBlank(current)) break;
        const underline = SETEXT.exec(current);
        if (underline !== null) {
          setext = underline[1]!.startsWith('=') ? 1 : 2;
          index += 1;
          break;
        }
        if (this.interrupts(current) || isTableStart(lines, index) || displayMath(lines, index) !== null) break;
        paragraph.push(this.options.breaks === true ? current : trimMarkdown(current));
        index += 1;
      }
      const text = paragraph.join('\n');
      out.push(setext > 0 ? { t: 'h', level: setext, c: this.inline(text) } : { t: 'p', c: this.inline(text) });
    }
    return out;
  }

  private fence(lines: readonly string[], start: number, match: RegExpExecArray, out: Block[]): number {
    const indent = match[1]!.length;
    const run = match[2]!;
    const info = match[3]!;
    // The core appends the header after the mark; everything before it is the usual info string.
    const markAt = info.indexOf(MARK);
    const plainInfo = (markAt >= 0 ? info.slice(0, markAt) : info).trim();
    let header: FenceHeader | null = null;
    let runCommand: string | null = null;
    if (markAt >= 0) {
      try {
        const parsed = obj(JSON.parse(info.slice(markAt + 1)));
        // The core percent-encodes the command (`encode_command` in `run_command.rs`).
        if (parsed !== null && typeof parsed.run === 'string') runCommand = decodeCommand(parsed.run);
        if (parsed !== null && typeof parsed.label === 'string') {
          header = {
            label: parsed.label,
            icon: typeof parsed.icon === 'string' ? parsed.icon : 'file',
            ...(typeof parsed.href === 'string' ? { href: parsed.href } : {}),
          };
        }
      } catch {
        header = null;
      }
    }
    const body: string[] = [];
    let index = start + 1;
    const closing = new RegExp(`^ {0,3}${run[0] === '`' ? '`' : '~'}{${run.length},}[ \\t]*$`);
    while (index < lines.length && !closing.test(lines[index]!)) {
      const line = lines[index]!;
      body.push(line.slice(Math.min(indent, indentOf(line))));
      index += 1;
    }
    out.push({ t: 'code', lang: plainInfo.split(/\s+/)[0] ?? '', header, run: runCommand, text: body.join('\n') });
    return index + 1;
  }

  private list(lines: readonly string[], start: number, first: ListMarker, out: Block[]): number {
    const items: ListItem[] = [];
    let index = start;
    let marker: ListMarker | null = first;
    while (marker !== null && marker.ordered === first.ordered && marker.bullet === first.bullet) {
      const content: string[] = [marker.rest];
      const contentIndent = marker.content;
      index += 1;
      let previousBlank = false;
      while (index < lines.length) {
        const line = lines[index]!;
        if (isBlank(line)) {
          content.push('');
          previousBlank = true;
          index += 1;
          continue;
        }
        const indent = indentOf(line);
        if (indent >= contentIndent) {
          content.push(line.slice(contentIndent));
          previousBlank = false;
          index += 1;
          continue;
        }
        // A new item of any list, or a block start at this level, ends the item.
        const next = listMarker(line);
        // A marker indented past this item's own marker but short of its content column is still a
        // nested list (agents often nest two spaces under `1. `).
        if (next !== null && next.indent > marker.indent) {
          content.push(line.slice(indent));
          previousBlank = false;
          index += 1;
          continue;
        }
        if (next !== null) break;
        if (previousBlank || this.interrupts(line)) break;
        // Lazy continuation of the item's paragraph.
        content.push(trimMarkdown(line));
        index += 1;
      }
      while (content.length > 0 && isBlank(content[content.length - 1]!)) content.pop();
      let checked: boolean | null = null;
      const task = /^\[([ xX])\][ \t]+/.exec(content[0] ?? '');
      if (task !== null) {
        checked = task[1] !== ' ';
        content[0] = content[0]!.slice(task[0].length);
      }
      items.push({ checked, c: this.blocks(content) });
      // Skip blank lines between items; the list continues only with a sibling marker.
      let probe = index;
      while (probe < lines.length && isBlank(lines[probe]!)) probe += 1;
      const following = probe < lines.length ? listMarker(lines[probe]!) : null;
      if (following !== null && following.indent <= 3 && following.indent < first.content) {
        index = probe;
        marker = following;
      } else {
        marker = null;
      }
    }
    out.push({ t: 'list', ordered: first.ordered, start: first.start, items });
    return index;
  }

  private table(lines: readonly string[], start: number): { block: Block; end: number } | null {
    const headLine = lines[start];
    const delimiter = lines[start + 1];
    if (headLine === undefined || delimiter === undefined || !TABLE_DELIMITER.test(delimiter)) return null;
    const head = splitRow(headLine);
    const align: Align[] = splitRow(delimiter).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
    });
    const rows: string[][] = [];
    let index = start + 2;
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line) || line === TABLE_CLOSE || (!line.includes('|') && this.interrupts(line))) break;
      rows.push(splitRow(line));
      index += 1;
    }
    const width = head.length;
    const fit = (cells: string[]): string[] => Array.from({ length: width }, (_, column) => cells[column] ?? '');
    return {
      block: {
        t: 'table',
        head: head.map((cell) => this.inline(cell)),
        align: Array.from({ length: width }, (_, column) => align[column] ?? null),
        rows: rows.map((row) => fit(row).map((cell) => this.inline(cell))),
        source: lines.slice(start, index).join('\n'),
      },
      end: index,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------------------------

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const AUTOLINK = /^https?:\/\/[^\s<>]+/;

function pushText(out: Inline[], value: string): void {
  if (value.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.t === 'text') last.v += value;
  else out.push({ t: 'text', v: value });
}

/** Where the `]` closing the bracket at `open` is, skipping code spans and nested brackets. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '`') {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (close >= 0) index = close + run.length - 1;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']' && --depth === 0) return index;
  }
  return -1;
}

/** `(href "title")` at `open`, returning the href and where the `)` is. */
function linkDestination(text: string, open: number): { href: string; end: number } | null {
  if (text[open] !== '(') return null;
  let index = open + 1;
  while (text[index] === ' ') index += 1;
  let href = '';
  const bracketed = text[index] === '<';
  const start = bracketed ? index + 1 : index;
  const literalEnd = literalDestinationEnd(text, start, bracketed);
  const literal = literalEnd !== null && isLiteralWindowsDestination(text.slice(start, literalEnd));
  if (bracketed) {
    const close = text.indexOf('>', index);
    if (close < 0) return null;
    href = text.slice(index + 1, close);
    index = close + 1;
  } else if (literal) {
    href = text.slice(start, literalEnd);
    index = literalEnd;
  } else {
    let depth = 0;
    const begin = index;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ' ' || character === '\n') break;
      index += 1;
    }
    href = text.slice(begin, index);
  }
  while (text[index] === ' ' || text[index] === '\n') index += 1;
  if (text[index] === '"' || text[index] === "'") {
    const quote = text[index]!;
    const close = text.indexOf(quote, index + 1);
    if (close < 0) return null;
    index = close + 1;
    while (text[index] === ' ') index += 1;
  }
  if (text[index] !== ')') return null;
  return { href: literal ? href : unescapeDestination(href), end: index };
}

/**
 * CDXC:SessionChat 2026-10-06 WHY:
 * CommonMark drops a backslash only before ASCII punctuation; dropping every one turned an agent's
 * `[page.html](C:\Users\me\page.html)` into `C:Usersmepage.html`, which the core reads as an
 * unknown `C:` scheme, so tapping the link did nothing. The desktop parser (markdown-rs) keeps them.
 */
function unescapeDestination(href: string): string {
  return href.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * CDXC:SessionChat 2026-10-06 DECISION:
 * User: keep backslashes literally whenever a link destination is a Windows absolute path, so
 * `C:\Users\me\.claude\x.md` keeps its `\.`. The core already doubles such backslashes in the
 * Markdown it hands both clients; this is the same test (`is_literal_windows_destination`) for
 * text that does not come through it, and a destination the core doubled fails it and decodes as
 * ordinary escaped Markdown, so the two never apply twice.
 * SEE-ALSO: packages/gx-chat-core/src/transcript/native_markdown.rs (`literal_windows_link_destinations`)
 */
function isLiteralWindowsDestination(destination: string): boolean {
  const drive = /^[a-z]:/iu.test(destination);
  if (drive && destination[2] === '\\') return destination[3] !== '\\';
  if (drive && destination[2] === '/') return !destination.includes('\\\\');
  return destination.startsWith('\\\\') && destination[2] !== '\\';
}

/**
 * CDXC:SessionChat 2026-10-17 WHY:
 * An absolute Windows path written as plain text (`C:\Users\me\dev\_scratch`, `\\server\share`)
 * keeps every backslash instead of reading `\_` as an escaped underscore. The core doubles such a
 * path's backslashes in the Markdown it hands the phone; this is the same test for text that does
 * not come through it, and a path the core doubled fails it and decodes as ordinary escaped Markdown.
 * SEE-ALSO: packages/gx-chat-core/src/transcript/native_markdown.rs (`windows_prose_path_end`)
 */
function windowsProsePathEnd(text: string, start: number): number | null {
  const before = start > 0 ? text[start - 1]! : '';
  if (/[A-Za-z0-9\\:/]/u.test(before)) return null;
  const drive = /^[A-Za-z]:\\/u.test(text.slice(start, start + 3));
  const unc = text.startsWith('\\\\', start) && /[A-Za-z0-9]/u.test(text[start + 2] ?? '');
  if (!drive && !unc) return null;
  let end = start;
  while (end < text.length && !/[\s<>"|?*`[\]]/u.test(text[end]!)) end += 1;
  // A reply's hard break (`\` before a newline) after the path stays a break.
  if (end > start && text[end - 1] === '\\' && text[end] === '\n') end -= 1;
  return isLiteralWindowsDestination(text.slice(start, end)) ? end : null;
}

/** Where a destination ends when its backslashes are literal (`literal_destination_end` in the core). */
function literalDestinationEnd(text: string, start: number, bracketed: boolean): number | null {
  if (bracketed) {
    const close = text.indexOf('>', start);
    return close < 0 ? null : close;
  }
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === ' ' || character === '\t' || character === '\r' || character === '\n') return index;
  }
  return text.length;
}

function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

/** Finds the closing delimiter run for an emphasis opener at `start`. */
function closingDelimiter(text: string, start: number, run: string): number {
  const character = run[0]!;
  let index = start + run.length;
  while (index < text.length) {
    const found = text.indexOf(run, index);
    if (found < 0) return -1;
    // Skip over code spans between the delimiters.
    const tick = text.indexOf('`', index);
    if (tick >= 0 && tick < found) {
      const ticks = /^`+/.exec(text.slice(tick))![0];
      const close = text.indexOf(ticks, tick + ticks.length);
      if (close >= 0 && close + ticks.length > found) {
        index = close + ticks.length;
        continue;
      }
    }
    const before = text[found - 1];
    const after = text[found + run.length];
    const longer = after === character;
    if (!isSpace(before) && !longer && found > start + run.length && (character !== '_' || !isWordCharacter(after))) {
      return found;
    }
    index = found + (longer ? run.length + 1 : 1);
  }
  return -1;
}

/**
 * Where the `$…$` formula whose LaTeX starts at `open` closes, as Pandoc reads it (gx-chat-core
 * `closing_dollar`): the opening `$` is not followed by a space, the closing one is not preceded
 * by a space nor followed by a digit, so "costs $5 and $10" stays text. Never across a line, nor
 * into a code span (a `$` in code stays code).
 */
function closingDollar(text: string, open: number): number {
  const first = text[open];
  if (first === undefined || /\s/.test(first) || first === '$') return -1;
  let index = open;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') index += 2;
    else if (character === '\n' || character === '`') return -1;
    else if (character === '$') {
      return !isSpace(text[index - 1]) && !/[0-9]/.test(text[index + 1] ?? '') ? index : -1;
    } else index += 1;
  }
  return -1;
}

/**
 * The formula written at `index` (`\(…\)`, `\[…\]`, `$$…$$`, `$…$`) and where it ends, as
 * gx-chat-core `split_math` finds them; null when none starts there. A `\$` is an escape, not math.
 */
function mathAt(text: string, index: number): { inline: Inline; end: number } | null {
  const rest = text.slice(index, index + 2);
  const bracket = rest === '\\[' ? '\\]' : rest === '\\(' ? '\\)' : null;
  if (bracket !== null || rest === '$$') {
    const close = bracket ?? '$$';
    const end = text.indexOf(close, index + 2);
    if (end < 0) return null;
    const latex = text.slice(index + 2, end).trim();
    if (latex.length === 0) return null;
    const source = text.slice(index, end + 2);
    return { inline: { t: 'math', latex, display: rest !== '\\(', source }, end: end + 2 };
  }
  if (text[index] !== '$') return null;
  const close = closingDollar(text, index + 1);
  if (close < 0) return null;
  const latex = text.slice(index + 1, close).trim();
  return { inline: { t: 'math', latex, display: false, source: text.slice(index, close + 1) }, end: close + 1 };
}

export function parseInline(text: string, breaks: boolean): Inline[] {
  const out: Inline[] = [];
  let index = 0;
  let plain = '';
  const flush = (): void => {
    pushText(out, plain);
    plain = '';
  };
  while (index < text.length) {
    const character = text[index]!;
    const pathEnd = windowsProsePathEnd(text, index);
    if (pathEnd !== null) {
      plain += text.slice(index, pathEnd);
      index = pathEnd;
      continue;
    }
    const rest = text.slice(index);
    if (character === '$' || (character === '\\' && (text[index + 1] === '(' || text[index + 1] === '['))) {
      const math = mathAt(text, index);
      if (math !== null) {
        flush();
        out.push(math.inline);
        index = math.end;
        continue;
      }
      // An unclosed `$$` stays text whole, so its second `$` does not open a formula.
      if (rest.startsWith('$$')) {
        plain += '$$';
        index += 2;
        continue;
      }
    }
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1]!;
      if (next === '\n') {
        flush();
        out.push({ t: 'br' });
        index += 2;
        continue;
      }
      if (ESCAPABLE.test(next)) {
        plain += next;
        index += 2;
        continue;
      }
    }
    if (character === '\n') {
      const hard = plain.endsWith('  ');
      // A line of pictures is a block of its own on the desktop (`parse` in `rich_markdown.rs`),
      // so the newline either side of one breaks the line here too and the pictures can form a
      // filmstrip (`pictureRuns` in `Markdown.tsx`).
      const nextLine = text.slice(index + 1).trimStart();
      const besidePicture =
        nextLine.startsWith(IMAGE_OPEN) || (plain.trim().length === 0 && out[out.length - 1]?.t === 'image');
      if (hard || breaks || besidePicture) {
        plain = plain.replace(/ +$/, '');
        flush();
        out.push({ t: 'br' });
      } else {
        plain = `${plain.replace(/ +$/, '')} `;
      }
      index += 1;
      while (text[index] === ' ' && !breaks) index += 1;
      continue;
    }
    if (character === MARK && rest.startsWith(IMAGE_OPEN)) {
      const end = text.indexOf(MARK, index + IMAGE_OPEN.length);
      if (end > 0) {
        try {
          const image = obj(JSON.parse(text.slice(index + IMAGE_OPEN.length, end)));
          if (image !== null) {
            flush();
            out.push({ t: 'image', image });
            index = end + 1;
            continue;
          }
        } catch {
          // Not a mark the core wrote: read it as text.
        }
      }
    }
    if (character === '`') {
      const run = /^`+/.exec(rest)![0];
      const close = text.indexOf(run, index + run.length);
      if (close >= 0 && text[close + run.length] !== '`') {
        let code = text.slice(index + run.length, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0)
          code = code.slice(1, -1);
        flush();
        out.push({ t: 'code', v: code });
        index = close + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }
    if (character === '[' || (character === '!' && text[index + 1] === '[')) {
      const image = character === '!';
      const open = image ? index + 1 : index;
      const close = closingBracket(text, open);
      if (close > 0) {
        const destination = linkDestination(text, close + 1);
        if (destination !== null) {
          const label = text.slice(open + 1, close);
          flush();
          // A picture the core did not mark (its bytes cannot be read) reads as its words.
          out.push({
            t: 'link',
            href: destination.href,
            label,
            c: image ? [{ t: 'text', v: label }] : parseInline(label, breaks),
          });
          index = destination.end + 1;
          continue;
        }
      }
    }
    if (character === '<') {
      const match = /^<((?:https?|mailto):[^\s<>]+)>/.exec(rest);
      if (match !== null) {
        flush();
        out.push({ t: 'link', href: match[1]!, label: match[1]!, c: [{ t: 'text', v: match[1]! }] });
        index += match[0].length;
        continue;
      }
    }
    if ((character === 'h' || character === 'H') && !isWordCharacter(text[index - 1])) {
      const match = AUTOLINK.exec(rest);
      if (match !== null) {
        let url = match[0];
        // GFM trims trailing punctuation, and a `)` the URL did not open.
        url = url.replace(/[.,:;!?"'*_~]+$/, '');
        while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))
          url = url.slice(0, -1);
        flush();
        out.push({ t: 'link', href: url, label: url, c: [{ t: 'text', v: url }] });
        index += url.length;
        continue;
      }
    }
    if (character === '*' || character === '_' || character === '~') {
      const run = /^([*_~])\1*/.exec(rest)![0];
      const length = character === '~' ? (run.length >= 2 ? 2 : 0) : Math.min(run.length, 3);
      const opener = run.slice(0, length);
      const after = text[index + length];
      const before = text[index - 1];
      const canOpen = length > 0 && !isSpace(after) && (character !== '_' || !isWordCharacter(before));
      if (canOpen) {
        const close = closingDelimiter(text, index, opener);
        if (close > 0) {
          const inner = parseInline(text.slice(index + length, close), breaks);
          flush();
          if (character === '~') out.push({ t: 'del', c: inner });
          else if (length === 3) out.push({ t: 'strong', c: [{ t: 'em', c: inner }] });
          else if (length === 2) out.push({ t: 'strong', c: inner });
          else out.push({ t: 'em', c: inner });
          index = close + length;
          continue;
        }
      }
      plain += run;
      index += run.length;
      continue;
    }
    plain += character;
    index += 1;
  }
  flush();
  return out;
}

/** The plain words of some inlines, for accessibility labels and table copies. */
export function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.t) {
        case 'text':
        case 'code':
          return inline.v;
        case 'math':
          return inline.source;
        case 'br':
          return '\n';
        case 'image':
          return typeof inline.image.label === 'string' ? inline.image.label : '';
        default:
          return inlineText(inline.c);
      }
    })
    .join('');
}
