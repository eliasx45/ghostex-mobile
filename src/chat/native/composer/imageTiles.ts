/**
 * The composer's pasted pictures live only as thumbnail tiles above the text field.
 *
 * CDXC:SessionChat 2026-10-28 DECISION: Elias, of the `Image #1` pill in front of his typed text
 * with the thumbnail above it: "No need to have the sort of image text here. We already have the
 * image. No need to have the image as well in the text. Fix it." and, for the phone, "Yes, phone
 * too". The draft still holds every picture as its `[Image #N](path)` reference (the core inserts,
 * removes, saves, restores and sends it as before), but the composer keeps those references in a
 * tail after the typed text that the field never shows: `typed + "\n\n" + "[Image #1](a) [Image
 * #2](b)"`. The field shows the typed text only, so every selection offset it reports is still an
 * offset into the draft. The message goes out with the pictures first (`imagesFirst`). Mirrors the
 * desktop's `packages/gx-chat-core/src/composer/image_tiles.rs` (Ghostex 8c7e11b8c), kept in
 * TypeScript because the Browser view brain answers core queries a turn late and the field needs
 * the split in the same keystroke.
 */

/** Between the typed text and the hidden picture references. */
const SEPARATOR = '\n\n';

/** `[Image #N](path)`, what `native_path_reference` inserts for a picture. */
const IMAGE_REFERENCE = /\[Image #\d+\]\([^)\r\n]+\)/gu;

export type ComposerImages = {
  /** The text the field shows: the draft without its picture references. */
  visible: string;
  /** Every `[Image #N](path)` reference, in draft order. */
  images: string[];
  /** The caret, as an index into `visible`. */
  caret: number;
};

/**
 * Splits `draft` into the field's text and its pictures. Each picture goes with one following
 * space (the one `insert_reference` adds), or, when none follows, one preceding space. When every
 * picture sat at the end, the blank line `joinImages` put before them goes too, so
 * `splitImages(joinImages(v, i))` gives back `v` and `i` exactly.
 */
export function splitImages(draft: string, caret: number): ComposerImages {
  const spans: { from: number; to: number }[] = [];
  const images: string[] = [];
  for (const match of draft.matchAll(IMAGE_REFERENCE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const previousEnd = spans.length > 0 ? spans[spans.length - 1]!.to : 0;
    if (start < previousEnd) continue;
    images.push(match[0]);
    if (draft[end] === ' ') spans.push({ from: start, to: end + 1 });
    else if (start > previousEnd && draft[start - 1] === ' ') spans.push({ from: start - 1, to: end });
    else spans.push({ from: start, to: end });
  }
  const at = Math.max(0, Math.min(caret, draft.length));
  if (spans.length === 0) return { visible: draft, images, caret: at };
  let visible = '';
  let kept: number | null = null;
  let cursor = 0;
  for (const { from, to } of spans) {
    if (kept === null && at <= from) kept = visible.length + (at - cursor);
    else if (kept === null && at < to) kept = visible.length + (from - cursor);
    visible += draft.slice(cursor, from);
    cursor = to;
  }
  if (kept === null) kept = visible.length + Math.max(0, at - cursor);
  const tailOnly =
    cursor === draft.length &&
    spans.every((span, index) => index === 0 || draft.slice(spans[index - 1]!.to, span.from).trim() === '');
  visible += draft.slice(cursor);
  if (tailOnly) {
    visible = visible.slice(0, spans[0]!.from);
    if (visible.endsWith(SEPARATOR)) visible = visible.slice(0, -SEPARATOR.length);
  }
  return { visible, images, caret: Math.min(kept, visible.length) };
}

/** The draft for field text `visible` holding `images`: the text, a blank line, the pictures. */
export function joinImages(visible: string, images: readonly string[]): string {
  if (images.length === 0) return visible;
  const pictures = images.join(' ');
  return visible.length === 0 ? pictures : `${visible}${SEPARATOR}${pictures}`;
}

/** The draft with its pictures moved behind the typed text, and the caret mapped into the field. */
export function canonicalDraft(draft: string, caret: number): { text: string; caret: number } {
  const split = splitImages(draft, caret);
  return { text: joinImages(split.visible, split.images), caret: split.caret };
}

/**
 * The draft as it is sent: its pictures first, then the typed text, as a picture pasted before
 * typing was always sent. A draft without pictures is sent unchanged.
 */
export function imagesFirst(draft: string): string {
  const split = splitImages(draft, 0);
  if (split.images.length === 0) return draft;
  const pictures = split.images.join(' ');
  return split.visible.trim().length === 0 ? pictures : `${pictures} ${split.visible}`;
}
