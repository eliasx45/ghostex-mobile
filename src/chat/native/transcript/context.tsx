/**
 * What every transcript row reads besides its own item.
 *
 * `NativeChatUiProvider` (mounted once per chat screen) owns the drawing state that outlives one
 * list: open rows, the row-detail demand and the loaded-image requests. The subagent viewer's rows
 * share all of it with the main transcript, as desktop's one `NativeChatView` does. The image
 * viewer and the table preview are `NativeChatOverlays`' (`../cards/overlayStore.ts`).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

import type { RustChat } from '../../rust/useRustChat';
import { chatMachineLink } from '../../rust/machine-link';
import type { ChatDocument, Json } from '../../rust/document';
import { arr, obj, str, type JsonRecord } from './json';
import { openChatImageViewer } from '../cards/overlayStore';
import { DisclosureStore, RowDetailDemand } from './state';
import type { RenderMath } from './markdown/math';
import type { TranscriptTheme } from './theme';

/** A picture as the document projects it (`transport`, `path`, `url`, `label`, `alt`). */
export type ChatImageSource = JsonRecord;

export type NativeChatUi = {
  disclosures: DisclosureStore;
  demand: RowDetailDemand;
  /** Asks the core for a machine image's bytes once (`loadImage`); the answer lands in `state.images`. */
  requestImage(path: string): void;
  /**
   * Lays out one ```visual block at `width` through the core (`renderVisual`): its scene as SVG with
   * tooltip regions, a page card, or an error; null when the core could not answer.
   */
  renderVisual(source: string, width: number, theme: JsonRecord, progress?: number): JsonRecord | null;
  /** The same layout, awaited: the Browser view brain answers a moment later (draw-in frames). */
  renderVisualAsync(source: string, width: number, theme: JsonRecord, progress?: number): Promise<JsonRecord | null>;
  /**
   * Opens the image viewer on a picture the transcript shows, with every picture the transcript
   * shows to step through (the core's `transcriptPictures`, CDXC:SessionChat 2026-10-24 in
   * gx-chat-core `transcript/pictures.rs`); `fallback` is the list it opens on when the core cannot answer.
   */
  openPicture(image: ChatImageSource, fallback: readonly ChatImageSource[], index: number): void;
  /** Typesets formulas on the chat's computer (`/api/renderMath`) for the Markdown (`markdown/math.ts`). */
  renderMath: RenderMath;
};

/** First typesetting starts gxserver's Typst engine, which takes a moment. */
const RENDER_MATH_TIMEOUT_MS = 20_000;

const UiContext = createContext<NativeChatUi | null>(null);

export function NativeChatUiProvider({ chat, children }: { chat: RustChat; children: ReactNode }) {
  const disclosures = useMemo(() => new DisclosureStore(), []);
  const dispatchRef = useRef(chat.dispatch);
  dispatchRef.current = chat.dispatch;
  const queryAsyncRef = useRef(chat.queryAsync);
  queryAsyncRef.current = chat.queryAsync;
  const demand = useMemo(() => new RowDetailDemand((action) => dispatchRef.current(action)), []);
  useEffect(() => () => demand.dispose(), [demand]);
  // A new core (the host changed) has forgotten which rows are open and which images it read.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    demand.reset();
    requested.current = new Set();
  }, [chat.dispatch, demand]);
  const requestImage = useCallback((path: string) => {
    if (path.length === 0 || requested.current.has(path)) return;
    requested.current.add(path);
    dispatchRef.current({ type: 'loadImage', path });
  }, []);
  // Keyed on `chat.query`, which changes when a late Browser view answer arrives, so a chart drawn
  // before its layout came back draws again; it never changes on the Built-in brain.
  const { query } = chat;
  const renderVisual = useCallback(
    (source: string, width: number, theme: JsonRecord, progress?: number): JsonRecord | null =>
      obj(
        query(
          'renderVisual',
          progress === undefined ? [source, width, theme, 'System'] : [source, width, theme, 'System', progress],
        ),
      ),
    [query],
  );
  const renderVisualAsync = useCallback(
    async (source: string, width: number, theme: JsonRecord, progress?: number): Promise<JsonRecord | null> =>
      obj(
        await queryAsyncRef.current(
          'renderVisual',
          progress === undefined ? [source, width, theme, 'System'] : [source, width, theme, 'System', progress],
        ),
      ),
    [],
  );
  const openPicture = useCallback((image: ChatImageSource, fallback: readonly ChatImageSource[], index: number) => {
    void queryAsyncRef
      .current('transcriptPictures', [image])
      .catch(() => null)
      .then((answer) => {
        const gallery = obj(answer);
        const images = arr(gallery?.images)
          .map((entry) => obj(entry))
          .filter((entry): entry is ChatImageSource => entry !== null);
        const at = typeof gallery?.index === 'number' ? gallery.index : -1;
        if (images.length > 0 && at >= 0) openChatImageViewer(images, at);
        else openChatImageViewer(fallback, index);
      });
  }, []);
  const machineRef = useRef(chat.machine);
  machineRef.current = chat.machine;
  // Over the warm link only: an older Ghostex (the exec route) has no typesetting, and its formulas stay text.
  const renderMath = useCallback<RenderMath>(async (params) => {
    const machine = machineRef.current;
    if (machine === null) return null;
    const link = chatMachineLink(machine);
    if ((await link.route()) !== 'socket') return null;
    const answer = await link.rpc('renderMath', params, RENDER_MATH_TIMEOUT_MS);
    return answer.error === null ? obj(answer.result) : null;
  }, []);
  const value = useMemo<NativeChatUi>(
    () => ({ disclosures, demand, requestImage, renderVisual, renderVisualAsync, openPicture, renderMath }),
    [demand, disclosures, requestImage, renderVisual, renderVisualAsync, openPicture, renderMath],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

/** The chat screen's shared drawing state, or null outside `NativeChatScreen` (Markdown in a card). */
export function useOptionalNativeChatUi(): NativeChatUi | null {
  return useContext(UiContext);
}

/** The chat screen's shared drawing state. Throws outside `NativeChatScreen`. */
export function useNativeChatUi(): NativeChatUi {
  const value = useContext(UiContext);
  if (value === null) throw new Error('useNativeChatUi outside NativeChatUiProvider');
  return value;
}

/** How one list draws (`ChatAppearance` plus the list it belongs to). */
export type TranscriptEnv = {
  /** The chat's `dispatch`, stable per chat (the `RustChat` object itself changes every frame). */
  dispatch: RustChat['dispatch'];
  theme: TranscriptTheme;
  /** Verbose mode opens every work fold by default (`verboseOverride` or the setting). */
  verbose: boolean;
  /**
   * Simple mode (`sessionChatSimpleMode`): tool runs and a message's file edits fold behind a
   * count, and tool rows hide their command preview (desktop `ChatAppearance::simple`).
   */
  simple: boolean;
  /**
   * The folds under each agent message (its tool calls, a thought's tools, a finished turn's
   * "Worked" log) start open: in verbose mode, and whenever Simple mode is off (desktop
   * `ChatAppearance::work_open`, CDXC:SessionChat 2026-10-14 DECISION).
   */
  workOpen: boolean;
  /** File edit previews: file cards show their first lines without a tap. */
  filePreviews: boolean;
  /** Grey thinking (`sessionChatMutedThinking`): thinking muted, replies in the foreground (desktop `ChatAppearance::thinking_lane`). */
  mutedThinking: boolean;
  /** This session's own transcript (not the subagent viewer): only it offers rewind. */
  main: boolean;
};

const EnvContext = createContext<TranscriptEnv | null>(null);
export const TranscriptEnvProvider = EnvContext.Provider;

export function useTranscriptEnv(): TranscriptEnv {
  const value = useContext(EnvContext);
  if (value === null) throw new Error('useTranscriptEnv outside a transcript');
  return value;
}

/** The document fields rows read, gathered once per document so rows compare cheaply. */
export type TranscriptFlags = {
  finalIds: ReadonlySet<string>;
  /** Pages whose answers arrived, so their cards read Answered (desktop `visual.rs`). */
  answeredPages: ReadonlySet<string>;
  /** Question pages whose questions were withdrawn, some or all (desktop `page_card.rs`). */
  withdrawnPages: { [pageId: string]: { tags: string[]; total: number } };
  savedPrompts: { [messageId: string]: Json };
  rewindAvailable: boolean;
  rewindEnabled: boolean;
  /** The host can stash (Save prompt on a user row). */
  canSavePrompt: boolean;
  /** The queue's Edit and Delete, which a user row still waiting for the agent offers too. */
  canEditQueued: boolean;
  canRemoveQueued: boolean;
  /** Messages the agent itself queued, which Back to composer takes back into the composer. */
  takeBackIds: ReadonlySet<string>;
  /** The message a Back to composer is taking back right now. */
  takeBackBusy: string | null;
  deferredWork: { [itemId: string]: { loading: boolean; error?: string | null } };
  /** The open API error card (`apiErrorCard`); the row whose id it names draws it, other failed-call rows a quiet line. */
  apiErrorCard: Json;
  /** Handover heading color strength, 0 to 1 (`markedHeadingStrength`; absent is 60%). */
  markedHeadingStrength: number;
  /** Claude Code workflow runs drawn as cards, by Workflow call id (`workflowCards`). */
  workflowCards: { [callId: string]: Json };
  /** Read aloud's reply row shows (`readAloud.available`). */
  readAloudAvailable: boolean;
  /** The reply being read, whose row reads Stop reading (`readAloud.speakingId`). */
  readAloudSpeakingId: string | null;
};

const EMPTY_FLAGS: TranscriptFlags = {
  finalIds: new Set(),
  answeredPages: new Set(),
  withdrawnPages: {},
  savedPrompts: {},
  rewindAvailable: false,
  rewindEnabled: false,
  canSavePrompt: false,
  canEditQueued: false,
  canRemoveQueued: false,
  takeBackIds: new Set(),
  takeBackBusy: null,
  deferredWork: {},
  apiErrorCard: null,
  markedHeadingStrength: 0.6,
  workflowCards: {},
  readAloudAvailable: false,
  readAloudSpeakingId: null,
};

const FlagsContext = createContext<TranscriptFlags>(EMPTY_FLAGS);
export const TranscriptFlagsProvider = FlagsContext.Provider;
export function useTranscriptFlags(): TranscriptFlags {
  return useContext(FlagsContext);
}

export function transcriptFlags(document: ChatDocument | null): TranscriptFlags {
  if (document === null) return EMPTY_FLAGS;
  return {
    finalIds: new Set(arr(document.finalIds).filter((id): id is string => typeof id === 'string')),
    answeredPages: new Set(arr(document.answeredPages).filter((id): id is string => typeof id === 'string')),
    withdrawnPages: obj(document.withdrawnPages) === null ? {} : (document.withdrawnPages ?? {}),
    savedPrompts: obj(document.savedPrompts) === null ? {} : document.savedPrompts,
    rewindAvailable: document.rewindAvailable === true,
    rewindEnabled: document.rewindEnabled === true,
    canSavePrompt: obj(document.composerActions)?.stash === true,
    canEditQueued: obj(obj(document.queue)?.capabilities)?.canEdit === true,
    canRemoveQueued: obj(obj(document.queue)?.capabilities)?.canRemove === true,
    takeBackIds: new Set(arr(document.queueTakeBackIds).filter((id): id is string => typeof id === 'string')),
    takeBackBusy: typeof document.queueTakeBackBusy === 'string' ? document.queueTakeBackBusy : null,
    deferredWork: obj(document.deferredWork) === null ? {} : document.deferredWork,
    apiErrorCard: document.apiErrorCard ?? null,
    markedHeadingStrength:
      typeof document.markedHeadingStrength === 'number'
        ? Math.min(Math.max(document.markedHeadingStrength / 100, 0), 1)
        : 0.6,
    workflowCards: obj(document.workflowCards) === null ? {} : (document.workflowCards ?? {}),
    readAloudAvailable: document.readAloud?.available === true,
    readAloudSpeakingId: typeof document.readAloud?.speakingId === 'string' ? document.readAloud.speakingId : null,
  };
}

/** Row details by row key; changes only when the core ships new ones. */
const DetailsContext = createContext<{ [key: string]: Json }>({});
export const RowDetailsProvider = DetailsContext.Provider;
export function useRowDetails(): { [key: string]: Json } {
  return useContext(DetailsContext);
}

/** Loaded image bytes by machine path. */
const ImagesContext = createContext<RustChatImages>({});
export type RustChatImages = NonNullable<RustChat['state']>['images'];
export const ChatImagesProvider = ImagesContext.Provider;
export function useChatImages(): RustChatImages {
  return useContext(ImagesContext);
}

/** Registers an open row's demand for its detail while mounted, and returns the detail (or null). */
export function useRowDetail(
  key: string,
  kind: 'tool' | 'file',
  messageId: string,
  index: number,
  active: boolean,
): Json {
  const { demand } = useNativeChatUi();
  const details = useRowDetails();
  useEffect(() => {
    if (!active) return undefined;
    return demand.add({ key, kind, messageId, index });
  }, [active, demand, index, key, kind, messageId]);
  return active ? (details[key] ?? null) : null;
}

/** What an image tile shows: a URI React Native can load, a spinner, or the picture's own words. */
export type ImageDisplay =
  { state: 'ready'; uri: string } | { state: 'loading' } | { state: 'unavailable'; reason: string };

/** Resolves one projected image source, asking the core for machine bytes the first time (`images.rs`). */
export function useImageDisplay(image: ChatImageSource): ImageDisplay {
  const images = useChatImages();
  const { requestImage } = useNativeChatUi();
  const transport = str(image, 'transport');
  const path = str(image, 'path');
  const url = str(image, 'url');
  useEffect(() => {
    if (transport === 'read' && path.length > 0 && images[path] === undefined) requestImage(path);
  }, [images, path, requestImage, transport]);
  if (transport === 'url' || transport === 'data')
    return url.length > 0 ? { state: 'ready', uri: url } : { state: 'unavailable', reason: 'unavailable' };
  if (transport !== 'read' || path.length === 0) return { state: 'unavailable', reason: 'unavailable' };
  const loaded = images[path];
  if (loaded === undefined) return { state: 'loading' };
  if (loaded.status === 'failed') return { state: 'unavailable', reason: loaded.reason };
  return { state: 'ready', uri: `data:${loaded.mediaType};base64,${loaded.base64Data}` };
}
