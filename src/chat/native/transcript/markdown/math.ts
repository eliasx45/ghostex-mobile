/**
 * Typeset formulas for the transcript's Markdown: gxserver typesets each `$…$` and `$$…$$` with
 * Typst (`POST /api/renderMath`, server/src/math/) and answers it as SVG with its size and, inline,
 * where the text's baseline runs. Desktop draws the same answers (apps/desktop/src/app/native_chat/
 * math_text.rs); until a formula's picture arrives, and when it cannot be typeset, the text it was
 * written as stands in.
 *
 * The formulas are kept here for the life of the app, by LaTeX, display, size and colour. Every
 * formula asked for while one render runs goes to gxserver in one request (one per size and
 * colour), so a message's formulas arrive together.
 *
 * CDXC:Learn 2026-10-26 SEE-ALSO: packages/gx-chat-core/src/math_text.rs (where the math is), parse.ts (the same rules).
 */

import { useEffect, useReducer, useRef } from 'react';

import { arr, obj, type JsonRecord } from '../json';

/**
 * CDXC:Learn 2026-10-26 WHY: New Computer Modern's letters are about a fifth smaller than the UI
 * font's at the same point size, so formulas are typeset this much larger than the text around
 * them (desktop `MATH_TO_TEXT`).
 */
const MATH_TO_TEXT = 1.2;
/** gxserver typesets at most this many formulas per request (`MAX_FORMULAS` in `server/src/math/http.rs`). */
const MAX_PER_REQUEST = 128;
/** Formulas kept; past this the oldest are let go and asked for again (gxserver caches them too). */
const MAX_ENTRIES = 1024;
/** How long a request that got no answer waits before its formulas are asked for again. */
const RETRY_AFTER_MS = 30_000;

/** One typeset formula, in points (the text's units): its SVG, size and baseline from the top. */
export type MathFormula = { svg: string; width: number; height: number; baseline: number | null };

/** Asks gxserver to typeset (`/api/renderMath` params): its `result`, or null when it did not answer. */
export type RenderMath = (params: JsonRecord) => Promise<JsonRecord | null>;

type Entry =
  | { status: 'pending' }
  | { status: 'ready'; formula: MathFormula }
  /** Cannot be typeset (`retryAt` null), or no answer came (asked again after `retryAt`). */
  | { status: 'failed'; retryAt: number | null };

type Wanted = { key: string; latex: string; display: boolean };
type Batch = { size: number; color: string; render: RenderMath; formulas: Wanted[] };

const entries = new Map<string, Entry>();
const batches = new Map<string, Batch>();
const listeners = new Set<(changed: ReadonlySet<string>) => void>();
let flushScheduled = false;

function mathKey(latex: string, display: boolean, size: number, color: string): string {
  return JSON.stringify([latex, display, Math.round(size * 100), color]);
}

function formulaOf(answer: unknown): MathFormula | null {
  const formula = obj(answer);
  if (formula === null || typeof formula.svg !== 'string') return null;
  const { width, height, baseline } = formula;
  if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) return null;
  return { svg: formula.svg, width, height, baseline: typeof baseline === 'number' ? baseline : null };
}

function settle(changed: Map<string, Entry>): void {
  if (entries.size + changed.size > MAX_ENTRIES) {
    for (const [key, entry] of entries) {
      if (entries.size <= MAX_ENTRIES / 2) break;
      if (entry.status !== 'pending') entries.delete(key);
    }
  }
  for (const [key, entry] of changed) entries.set(key, entry);
  const keys = new Set(changed.keys());
  for (const listener of listeners) listener(keys);
}

async function send(batch: Batch): Promise<void> {
  for (let start = 0; start < batch.formulas.length; start += MAX_PER_REQUEST) {
    const formulas = batch.formulas.slice(start, start + MAX_PER_REQUEST);
    const result = await batch
      .render({
        formulas: formulas.map(({ latex, display }) => ({ latex, display })),
        size: batch.size * MATH_TO_TEXT,
        color: batch.color,
        format: 'svg',
      })
      .catch(() => null);
    const answers = result === null ? null : arr(result.formulas);
    const changed = new Map<string, Entry>();
    formulas.forEach(({ key }, index) => {
      const formula = answers === null ? null : formulaOf(answers[index]);
      changed.set(
        key,
        formula !== null
          ? { status: 'ready', formula }
          : { status: 'failed', retryAt: answers === null ? Date.now() + RETRY_AFTER_MS : null },
      );
    });
    settle(changed);
  }
}

function flush(): void {
  flushScheduled = false;
  const sending = [...batches.values()];
  batches.clear();
  for (const batch of sending) void send(batch);
}

/** The formula for this text, or null while it is on its way or when it cannot be typeset; asks for a missing one. */
function lookup(
  latex: string,
  display: boolean,
  size: number,
  color: string,
  render: RenderMath,
  asked: Set<string>,
  waiting: Set<string>,
): MathFormula | null {
  const key = mathKey(latex, display, size, color);
  asked.add(key);
  const entry = entries.get(key);
  if (entry?.status === 'ready') return entry.formula;
  if (entry?.status === 'pending') {
    waiting.add(key);
    return null;
  }
  if (entry?.status === 'failed' && (entry.retryAt === null || Date.now() < entry.retryAt)) return null;
  entries.set(key, { status: 'pending' });
  waiting.add(key);
  const batchKey = JSON.stringify([size, color]);
  let batch = batches.get(batchKey);
  if (batch === undefined) {
    batch = { size, color, render, formulas: [] };
    batches.set(batchKey, batch);
  }
  batch.formulas.push({ key, latex, display });
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
  return null;
}

/** Formulas for one Markdown body: `formula(latex, display, size, color)` while it draws. */
export type MathLookup = {
  formula(latex: string, display: boolean, size: number, color: string): MathFormula | null;
};

/**
 * A Markdown body's formulas, drawn again when one it showed as text arrives. Null without a
 * gxserver to ask (`render` null: Markdown outside a chat screen), where formulas stay text.
 */
export function useMathLookup(render: RenderMath | null): MathLookup | null {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const asked = useRef(new Set<string>()).current;
  const waiting = useRef(new Set<string>()).current;
  waiting.clear();
  useEffect(() => {
    const listener = (changed: ReadonlySet<string>) => {
      for (const key of changed) {
        if (asked.has(key)) {
          redraw();
          return;
        }
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [asked]);
  // An answer that landed between drawing and listening.
  useEffect(() => {
    for (const key of waiting) {
      if (entries.get(key)?.status !== 'pending') {
        redraw();
        return;
      }
    }
  });
  const lookupRef = useRef<{ render: RenderMath; value: MathLookup } | null>(null);
  if (render === null) return null;
  if (lookupRef.current?.render !== render) {
    lookupRef.current = {
      render,
      value: {
        formula: (latex, display, size, color) => lookup(latex, display, size, color, render, asked, waiting),
      },
    };
  }
  return lookupRef.current.value;
}

/** `color` as the `#rrggbb` or `#rrggbbaa` gxserver reads (`parse_color`), or null for one it cannot. */
export function mathColor(color: string): string | null {
  const text = color.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(text);
  if (short !== null)
    return `#${short
      .slice(1)
      .map((digit) => (digit === undefined ? '' : digit + digit))
      .join('')}`;
  if (/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return text;
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (rgb === null) return null;
  const byte = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
  const alpha = rgb[4] === undefined ? '' : byte(Number(rgb[4]) * 255);
  return `#${byte(Number(rgb[1]))}${byte(Number(rgb[2]))}${byte(Number(rgb[3]))}${alpha}`;
}
