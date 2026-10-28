/**
 * The composer text the phone owns, and the composer requests the core addresses to it.
 *
 * On desktop the text field lives in the view (`apps/desktop/src/app/native_chat/state.rs`:
 * `draft`, `draft_id`, `draft_revision`, `composer_ready`, `pending_send`) and the view performs
 * the composer requests the core's effects become (`composerInit`, `composer`,
 * `composerClearExpected`, `draftSubmitted`, `submissionFailed`, `draftReceived`,
 * `returnedPrompt`, `attachmentReferences`, and the `readNativeComposer` read). The phone host
 * keeps that model here, so the native screen only binds a `TextInput` to `text` and reports
 * edits, focus, blur and Send, and every rule about what those mean stays where desktop keeps it.
 *
 * Offsets (`caret`, `selection`) are UTF-16, which is what a JavaScript string index already is.
 */

import type { ChatDocument } from './document';
import { nextDraftVersion, randomUuid } from './host-records';
import type { UserAction } from './actions';
import { canonicalDraft, imagesFirst } from '../native/composer/imageTiles';

/** What a submission does; `interrupt` is Interrupt & Send. */
export type SubmitMode = 'send' | 'queue' | 'compact' | 'handoff' | 'interrupt';

export type ComposerModelState = {
  /** The field's text. */
  text: string;
  /** Where the caret should go after a host replacement, or null to leave it. */
  caret: number | null;
  /** The selection the screen last reported. */
  selection: { start: number; end: number };
  /** Bumped whenever the HOST replaced `text`, so the screen knows to push it into its input. */
  replaceSequence: number;
  /** The replacement came from history recall (desktop makes it undoable differently). */
  fromHistory: boolean;
  clientId: string;
  draftId: string;
  /** The draft revision, bumped per edit; the wire claims `max(1, revision)`. */
  revision: number;
  /** The boot read answered; edits and saves go to the core only from here on. */
  ready: boolean;
  /** A send left the composer and has not settled. Send does not wait for it: the core holds later sends behind it. */
  pendingSend: boolean;
};

export type ComposerHooks = {
  dispatch(action: UserAction): void;
  document(): ChatDocument | null;
  onChange(): void;
  /** Send was pressed while `sendBlockedReason` holds: show the core's `sendBlockedToast`. */
  onSendBlocked(reason: string): void;
  onFocusRequested(): void;
};

export class ComposerModel {
  state: ComposerModelState = {
    text: '',
    caret: null,
    selection: { start: 0, end: 0 },
    replaceSequence: 0,
    fromHistory: false,
    clientId: '',
    draftId: randomUuid(),
    revision: 0,
    ready: false,
    pendingSend: false,
  };

  private selectionSent: { text: string; caret: number } | null = null;

  constructor(private readonly hooks: ComposerHooks) {}

  private set(next: Partial<ComposerModelState>): void {
    this.state = { ...this.state, ...next };
    this.hooks.onChange();
  }

  private version(): { draftId: string; revision: number } {
    return { draftId: this.state.draftId, revision: Math.max(1, this.state.revision) };
  }

  // ---- the screen's input --------------------------------------------------------------------

  /** The user typed (desktop's `InputEvent::Change`). */
  edited(text: string, selection?: { start: number; end: number }): void {
    if (text === this.state.text) {
      if (selection) this.selected(selection);
      return;
    }
    this.hooks.dispatch({ type: 'composerExpand', editor: true });
    this.set({
      text,
      revision: this.state.revision + 1,
      caret: null,
      ...(selection ? { selection } : {}),
    });
    this.persist();
    if (selection) this.selected(selection);
  }

  /**
   * The caret or selection moved (the screen reports it after every edit too). The core reads it
   * for the `@` / `$` / `/` popup; like `suggestions/window.rs`, an unchanged (text, caret) pair is
   * not sent again.
   */
  selected(selection: { start: number; end: number }): void {
    this.state = { ...this.state, selection };
    const sent = this.selectionSent;
    if (sent !== null && sent.text === this.state.text && sent.caret === selection.end) return;
    this.selectionSent = { text: this.state.text, caret: selection.end };
    this.hooks.dispatch({ type: 'composerSelection', text: this.state.text, caret: selection.end });
  }

  focused(): void {
    this.hooks.dispatch({ type: 'composerExpand', editor: true });
  }

  /** Blur pushes the draft to gxserver, as desktop's `InputEvent::Blur` does. */
  blurred(): void {
    this.save();
  }

  /**
   * Send, Queue, Compact, Handoff, or Interrupt & Send (a send that stops the agent's running turn
   * first), with desktop's gates (`native_chat/composer.rs`, `submit`).
   * Returns whether the text left the composer.
   */
  submit(requested: SubmitMode): boolean {
    const interrupt = requested === 'interrupt';
    const mode = interrupt ? 'send' : requested;
    const document = this.hooks.document();
    if (!this.state.ready || this.state.text.trim().length === 0) return false;
    if (mode !== 'send' && mode !== 'handoff' && document?.queue.capabilities.canQueue !== true) return false;
    const blocked = document?.sendBlockedReason ?? null;
    if (blocked !== null) {
      this.hooks.onSendBlocked(blocked);
      return false;
    }
    if (mode === 'send' && typeof document?.composerCommand === 'string') {
      this.hooks.dispatch({ type: 'completeComposerCommand' });
      return false;
    }
    const submission = {
      type: mode,
      // The pictures go first, as a picture pasted before typing always did; the draft only kept
      // them after the typed text so the field could hide them (`imageTiles.ts`).
      text: imagesFirst(this.state.text),
      draftVersion: this.version(),
      ...(interrupt ? { interrupt } : {}),
    } as UserAction;
    this.set({
      pendingSend: true,
      text: '',
      draftId: randomUuid(),
      revision: 1,
      caret: 0,
      replaceSequence: this.state.replaceSequence + 1,
      fromHistory: false,
    });
    this.hooks.dispatch(submission);
    return true;
  }

  // ---- the core's composer requests ----------------------------------------------------------

  /** `composerInit`: the boot read's client id, draft identity and stored text. */
  init(read: { clientId?: unknown; entry?: unknown }, sessionId: string): void {
    const entry = (read.entry ?? {}) as { text?: unknown; parked?: unknown; submitted?: unknown; version?: unknown };
    const version = (entry.version ?? {}) as { draftId?: unknown; revision?: unknown };
    const typedBeforeReady = this.state.revision > 0 ? this.state.text : null;
    const restored =
      entry.parked === true || entry.submitted === true ? '' : typeof entry.text === 'string' ? entry.text : '';
    // Pictures sit after the typed text, where the field does not show them (`imageTiles.ts`).
    const text = canonicalDraft(
      typedBeforeReady === null ? restored : `${restored}${typedBeforeReady}`,
      0,
    ).text;
    this.set({
      clientId: typeof read.clientId === 'string' ? read.clientId : '',
      draftId: typeof version.draftId === 'string' ? version.draftId : nextDraftVersion().draftId,
      revision: typeof version.revision === 'number' ? version.revision : 1,
      ready: true,
      text,
      caret: null,
      replaceSequence: text === this.state.text ? this.state.replaceSequence : this.state.replaceSequence + 1,
    });
    if (typedBeforeReady !== null) {
      this.set({ revision: this.state.revision + 1 });
      this.persist();
      this.save();
    }
    // The stash badge and the session-note dot need their first read (`native-composer-chrome.ts`).
    this.hooks.dispatch({ type: 'refreshComposerChrome', sessionId });
  }

  /** `setComposerText` (desktop's `replace_draft`). */
  replace(incoming: string, caret: number | null, fromHistory: boolean, preserveError = false): void {
    // CDXC:SessionChat 2026-10-28 DECISION: Elias: "No need to have the sort of image text here. We already have the image. No need to have the image as well in the text. Fix it." ("Yes, phone too"). A picture the core put anywhere in the draft moves behind the typed text, where the field does not show it; the tile above the field is the picture (`imageTiles.ts`).
    const canonical = canonicalDraft(incoming, caret ?? incoming.length);
    const content = canonical.text;
    this.set({
      text: content,
      revision: this.state.revision + 1,
      caret: canonical.caret,
      fromHistory,
      replaceSequence: this.state.replaceSequence + 1,
    });
    this.hooks.onFocusRequested();
    if (this.state.ready) {
      this.hooks.dispatch({
        type: 'editDraft',
        text: this.state.text,
        draftVersion: this.version(),
        history: fromHistory,
        preserveError,
      });
    }
    // Desktop reports every (text, caret) the field shows (`suggestions/window.rs`); a programmatic
    // value change fires no selection event on iOS, so a picked `@` file kept its popup open.
    const at = this.state.caret ?? content.length;
    this.selected({ start: at, end: at });
    this.save(preserveError);
  }

  /** `composerClearExpected`: clear only if the field still holds exactly this text. */
  clearIfUnchanged(text: string): void {
    if (this.state.text === text) this.replace('', null, false);
  }

  /** `returnedPrompt`: the core decides how the returned text merges with what is typed now. */
  returnedPrompt(text: string): void {
    this.hooks.dispatch({ type: 'applyReturned', text, current: this.state.text });
  }

  /** `draftSubmitted`: the send settled; a handoff that took this exact revision clears the field. */
  submitted(method: string, params: Record<string, unknown>): void {
    this.set({ pendingSend: false });
    if (method !== 'handoff') return;
    const version = (params.version ?? {}) as { draftId?: unknown; revision?: unknown };
    if (version.draftId !== this.state.draftId || version.revision !== this.state.revision) return;
    const next = (params.nextVersion ?? {}) as { draftId?: unknown };
    this.set({
      text: '',
      draftId: typeof next.draftId === 'string' ? next.draftId : randomUuid(),
      revision: 1,
      caret: 0,
      replaceSequence: this.state.replaceSequence + 1,
    });
    this.hooks.onFocusRequested();
  }

  /** `submissionFailed`: the core merges the failed text back with what was typed since. */
  failed(text: string): void {
    this.set({ pendingSend: false });
    this.hooks.dispatch({ type: 'restoreSubmission', text, current: this.state.text });
  }

  /** `draftReceived`: a draft from another client replaces the field if it is still untouched. */
  received(params: Record<string, unknown>): void {
    if (params.previous !== this.state.text) return;
    const version = (params.version ?? {}) as { draftId?: unknown; revision?: unknown };
    this.set({
      text: canonicalDraft(typeof params.content === 'string' ? params.content : '', 0).text,
      draftId: typeof version.draftId === 'string' ? version.draftId : this.state.draftId,
      revision: typeof version.revision === 'number' ? version.revision : 1,
      caret: null,
      replaceSequence: this.state.replaceSequence + 1,
    });
    this.hooks.onFocusRequested();
  }

  /** `attachmentReferences`: insert pills for machine paths at the current selection. */
  insertAttachments(paths: unknown): void {
    this.hooks.dispatch({
      type: 'insertAttachments',
      paths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [],
      text: this.state.text,
      start: this.state.selection.start,
      end: this.state.selection.end,
    });
  }

  // ---- saves ---------------------------------------------------------------------------------

  private persist(): void {
    if (!this.state.ready) return;
    this.hooks.dispatch({ type: 'editDraft', text: this.state.text, draftVersion: this.version() });
  }

  private save(preserveError = false): void {
    if (!this.state.ready) return;
    this.hooks.dispatch({
      type: 'saveDraft',
      content: this.state.text,
      draftVersion: { draftId: this.state.draftId, revision: this.state.revision },
      ...(preserveError ? { preserveError: true } : {}),
    });
  }
}
