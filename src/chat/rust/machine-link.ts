/**
 * The phone's warm chat connection to one computer: one `/api/events?stream=sessionChat` socket for
 * every open chat on it, and each chat request as a direct `POST /api/<method>`, both through the
 * SSH port forward to that computer's gxserver. It is the TypeScript twin of
 * `packages/gx-chat-client` (socket, followers, reconnect ladder) plus the desktop chat's
 * `native_chat/rpc.rs` (one call, one envelope); the chat rules stay in gx-chat-core, which folds
 * these frames exactly as it folds the desktop's.
 *
 * CDXC:Mobile 2026-10-08 DECISION:
 * User picked "Phone: one warm connection" from the chat-open report: each chat request was its
 * own SSH exec + login shell + `ghostex` CLI + HTTP call, with only 3 SSH command slots per
 * computer. Hard rule: "pls dont break things for users who set default to terminal at all". So
 * chat traffic (reads, the live stream, sends, prompt answers) rides one socket and plain HTTP over
 * the port forward the GPUI transcript already uses, which leaves the SSH command slots to
 * inventory and terminals; the terminal attach path is untouched. Old computers keep the exec path
 * (`transport.ts`): the handshake is `ghostex server endpoint` (missing verb or another wire
 * protocol means old) plus the forward's own probe (an sshd that refuses forwarding), decided
 * before any chat request is sent, never by a request failing first.
 *
 * The socket lives in JavaScript rather than in the phone library's Rust (`gx-chat-client` behind
 * UniFFI) because it is transport, not a chat rule: React Native's WebSocket and fetch reach the
 * loopback forward directly, and a Rust socket would need a thread calling back into JS through new
 * Kotlin and Swift event plumbing plus an HTTP client, and a native rebuild for every change.
 * SEE-ALSO: packages/gx-chat-client/src/wire.rs, apps/desktop/src/app/native_chat/rpc.rs,
 * server/src/server/ws.rs (`handle_events`), apps/mobile/app/src/chat/gpui/endpoint.ts
 */

import { AppState, type AppStateStatus } from 'react-native';

import { GhostexNative } from '../../../modules/ghostex-native/src';
import { ensureConnected } from '../../inventory/client';
import type { MachineConnectionTarget } from '../../machines/credentials';
import { GXSERVER_FORWARD_HOST, readServerEndpoint } from '../gpui/endpoint';
import type { RpcAnswer } from './transport';

/** `GXSERVER_PROTOCOL_VERSION`: the only wire this client speaks. */
const PROTOCOL_VERSION = 1;
const PROTOCOL_HEADER = 'x-gxserver-protocol-version';
/** `RECONNECT_DELAYS_MS` in `packages/gx-chat-client/src/wire.rs`; the last step repeats. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000];
/** The ladder in the background, for Voice mode's computer only: the SSH reconnect's steps. */
const BACKGROUND_RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
/** Opens that failed in a row before the endpoint is asked for again (port or token may have moved). */
const FAILED_OPENS_BEFORE_RECHECK = 3;
/** How long an older Ghostex is taken at its word before the handshake runs again (it may update). */
const LEGACY_RECHECK_MS = 10 * 60_000;
/** How long "Ghostex is not answering" is kept before the handshake runs again. */
const UNAVAILABLE_RECHECK_MS = 5_000;
/** The socket stays open this long after its last chat closes, so the next chat reuses it. */
const IDLE_CLOSE_MS = 30_000;
/** How long a socket that survived the background has to answer its fresh subscribes. */
const RESUME_ANSWER_MS = 5_000;
/** The four chat frame types a chat-only stream carries (`FRAME_TYPES` in `wire.rs`). */
const FRAME_TYPES = new Set(['sessionChatSnapshot', 'sessionChatReplaced', 'sessionChatAppended', 'sessionChatState']);
/** A forward is rebuilt at most this often; failures in between go straight to the exec route. */
const REPAIR_MIN_INTERVAL_MS = 5_000;
/** A watched socket that heard nothing from gxserver this long asks it whether it is still there. */
const QUIET_MS = 5_000;
/** How long that question (`GET /api/health`) may go unanswered before the chat counts as cut off. */
const PROBE_TIMEOUT_MS = 5_000;
/** How often a watched link looks at how long it has been quiet. */
const QUIET_CHECK_MS = 2_500;
/** Requests that only read, so a lost one may simply be asked again. */
const READ_ONLY_METHODS = new Set([
  'readSessionChat',
  'readSessionChatSkills',
  'readSessionChatFiles',
  'readSessionFilesLinks',
  'readSessionChatImage',
  'readVisualPageThumbnail',
  'readVisualPageSource',
  'readSessionTerminalTail',
  'readSessionChatReport',
  'readSessionAgentNote',
  'readCoordinatorThreads',
  'sessionForkBranches',
  'agentAccounts',
  'listStashedPrompts',
  'renderMath',
]);
/** The sends gxserver delivers at most once per `sendRequestId` (`session_chat_send_requests.rs`). */
const LEDGER_SEND_METHODS = new Set(['sendSessionChatMessage', 'queueSessionChatPrompt', 'answerSessionChatPrompt']);

/** What the user reads when a request never got an answer: one plain sentence, never a Java exception. */
export const UNREACHABLE_MESSAGE = "Couldn't reach Ghostex on this computer; try again in a moment.";
const TIMEOUT_MESSAGE = "Ghostex on this computer didn't answer in time.";

/**
 * How this computer's chat traffic travels: `socket` (the warm link), `legacy` (an older Ghostex, or
 * an sshd that refuses forwarding: one SSH exec per request), or `unavailable` (the handshake could
 * not finish, usually because Ghostex is not running; requests use exec until it is asked again).
 */
export type ChatRoute = 'socket' | 'legacy' | 'unavailable';

/**
 * `sendLedger`: the daemon advertised `sendRequestLedger`, so a send may be retried under its id.
 * `capabilities`: everything `ghostex server endpoint` listed (`voiceAgent` gates Voice mode).
 */
type Endpoint = { port: number; authToken: string; sendLedger: boolean; capabilities: readonly string[] };

/** The phone's loopback forward to a computer's gxserver, for sockets other than the chat's. */
export type GxserverLink = { localPort: number; authToken: string; capabilities: readonly string[] };

/**
 * How one request over the link ended: an answer for the core, or `fallBack` when nothing reached
 * gxserver (or a lost request was safe to repeat) and the exec route should carry it instead.
 */
export type LinkAnswer = { kind: 'answered'; answer: RpcAnswer } | { kind: 'fallBack' };

/** One HTTP attempt: answered, never sent (no forward), or lost after it may have been sent. */
type Attempt = { kind: 'answered'; answer: RpcAnswer } | { kind: 'notSent' } | { kind: 'lost'; timedOut: boolean };

function unreachable(endpoint: string, message: string): LinkAnswer {
  return { kind: 'answered', answer: { error: { code: 'unreachable', message, endpoint } } };
}

type LinkState =
  | { kind: 'unknown' }
  | { kind: 'probing'; done: Promise<ChatRoute> }
  | { kind: 'socket'; endpoint: Endpoint }
  | { kind: 'legacy' | 'unavailable'; until: number };

/** React Native's WebSocket constructor, whose third argument the DOM typings do not know. */
type HeaderWebSocket = new (
  url: string,
  protocols: string | string[] | undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

/** One conversation the socket follows. */
type Follower = {
  projectId: string;
  sessionId: string;
  limit: number;
  onFrame(frame: Record<string, unknown>): void;
};

function followerKey(projectId: string, sessionId: string): string {
  return JSON.stringify([projectId, sessionId]);
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function foreground(): boolean {
  return AppState.currentState !== 'background';
}

/** The computer whose chat link keeps reconnecting in the background (Read aloud's Voice mode). */
let backgroundMachineId: string | null = null;

/**
 * Lets one computer's chat link reconnect while the app is in the background, or none (`null`).
 *
 * CDXC:VoiceMode 2026-10-22 WHY: in the background nothing reconnects, so a cell handover while driving would end Auto-read without a word. While Voice mode reads a chat, its computer alone keeps retrying (SSH on its own ladder in `src/app/autoReconnect.ts`, the socket here on the same slower steps), and only until Voice mode stops.
 */
export function keepChatLinkInBackground(machineId: string | null): void {
  backgroundMachineId = machineId;
}

/** Whether `machineId` is the computer Voice mode keeps reconnecting in the background. */
export function chatLinkKeptInBackground(machineId: string): boolean {
  return backgroundMachineId === machineId;
}

function mayReconnect(machineId: string): boolean {
  return foreground() || chatLinkKeptInBackground(machineId);
}

class ChatMachineLink {
  private state: LinkState = { kind: 'unknown' };
  /** The route the last handshake settled on, so listeners hear only real changes. */
  private lastRoute: ChatRoute | null = null;
  private readonly routeListeners = new Set<(route: ChatRoute) => void>();
  private readonly followers = new Map<string, Follower>();
  /** The model catalog this computer's gxserver last pushed on the socket, or null before its first. */
  private modelCatalog: unknown = null;
  private readonly catalogListeners = new Set<(catalog: unknown) => void>();
  private socket: WebSocket | null = null;
  private socketOpen = false;
  /** Bumped for every socket, so a late callback of a replaced one does nothing. */
  private socketGeneration = 0;
  private connecting = false;
  private failedOpens = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private repairing: Promise<void> | null = null;
  private lastRepairAt = 0;
  /** Set when the app went to the background, so the next `active` checks the open socket. */
  private wasBackgrounded = false;
  /** Armed while a socket that survived the background owes an answer (`checkResumedSocket`). */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly socketListeners = new Set<(open: boolean) => void>();
  /** When gxserver was last heard: the socket opened or sent something, or a request was answered. */
  private lastHeardAt = 0;
  /** `silentSince`. */
  private silence: number | null = null;
  private readonly silenceListeners = new Set<() => void>();
  private quietTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(private machine: MachineConnectionTarget) {
    AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') this.wasBackgrounded = true;
      if (next !== 'active') return;
      const resumed = this.wasBackgrounded;
      this.wasBackgrounded = false;
      if (resumed && this.socket !== null) this.checkResumedSocket();
      else this.reconnectNow();
    });
    GhostexNative.addListener('onConnectionState', (event) => {
      if (event.machineId !== this.machine.id || event.state !== 'connected') return;
      // A new SSH connection means the old forward, and any socket riding it, is gone.
      if (this.socket !== null) this.replaceSocket();
      else this.reconnectNow();
    });
  }

  /** The newest connection target for this computer (credentials can change while the app runs). */
  retarget(machine: MachineConnectionTarget): void {
    this.machine = machine;
  }

  /** The route already known, or `null` when the handshake has to run (again). */
  current(): ChatRoute | null {
    const state = this.state;
    if (state.kind === 'socket') return 'socket';
    if ((state.kind === 'legacy' || state.kind === 'unavailable') && Date.now() < state.until) return state.kind;
    return null;
  }

  /** The route for the next request, running the handshake when nothing current is known. */
  route(): Promise<ChatRoute> {
    const known = this.current();
    if (known !== null) return Promise.resolve(known);
    if (this.state.kind === 'probing') return this.state.done;
    const done = this.handshake().then((outcome) => {
      const previous = this.lastRoute;
      this.lastRoute = outcome.route;
      this.state =
        outcome.route === 'socket'
          ? { kind: 'socket', endpoint: outcome.endpoint }
          : {
              kind: outcome.route,
              until: Date.now() + (outcome.route === 'legacy' ? LEGACY_RECHECK_MS : UNAVAILABLE_RECHECK_MS),
            };
      if (outcome.route !== previous) for (const listener of this.routeListeners) listener(outcome.route);
      if (outcome.route === 'socket') this.ensureSocket();
      return outcome.route;
    });
    this.state = { kind: 'probing', done };
    return done;
  }

  /**
   * CDXC:AgentModelCatalog 2026-10-17 WHY: gxserver serves the model lineups its own CLIs print, so
   * each computer's catalog is its own (the Mac's Cursor account lists other models than the
   * Windows machine's). The catalog a computer pushes reaches only that computer's chats, as on
   * desktop (`adopt_catalog` in apps/desktop/src/app/gx_chat/transport.rs); until 2026-10-17 the
   * phone dropped the pushes and every chat showed the build's bundled list.
   */
  currentModelCatalog(): unknown {
    return this.modelCatalog;
  }

  /** Hears every model catalog this computer pushes. */
  onModelCatalog(listener: (catalog: unknown) => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  /** Called with each new route once the handshake settles on a different one. */
  onRouteChange(listener: (route: ChatRoute) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  /** Whether the chat socket is open now (Voice mode's "reconnecting" line and 5-minute rule). */
  socketUp(): boolean {
    return this.socketOpen;
  }

  /** Hears the chat socket open and close. */
  onSocketChange(listener: (open: boolean) => void): () => void {
    this.socketListeners.add(listener);
    return () => this.socketListeners.delete(listener);
  }

  private setSocketOpen(open: boolean): void {
    if (this.socketOpen === open) return;
    this.socketOpen = open;
    if (open) this.heard();
    else if (this.followers.size > 0) this.setSilence(this.silence ?? Date.now());
    for (const listener of this.socketListeners) listener(open);
  }

  /**
   * Since when this computer's open chats have heard nothing from gxserver (a `Date.now()` time),
   * or null while they do: their socket is down (closed, or not open yet), or it went quiet and
   * gxserver did not answer `GET /api/health` in time (`watchSilence`). A chat on the exec route
   * follows no socket and is never silent here.
   */
  silentSince(): number | null {
    return this.silence;
  }

  /**
   * Hears every change of `silentSince` while a chat on this computer is on screen. While anyone
   * watches, a socket that has heard nothing for `QUIET_MS` asks gxserver whether it is still there.
   *
   * CDXC:SessionChat 2026-10-23 WHY: the socket rides an SSH port forward, so when the network stops
   * carrying packets (Wi-Fi gone dead, a stalled tunnel) nothing closes: SSH notices only once its
   * keepalives go unanswered, minutes later at the default 30-second interval, and until then the
   * chat looked live. An iPhone test cut the network for 20 seconds and the chat said nothing; the
   * user asked for that to be fixed. The question is gxserver's open `GET /api/health`, which every
   * version answers without a token.
   */
  watchSilence(listener: () => void): () => void {
    this.silenceListeners.add(listener);
    this.quietTimer ??= setInterval(() => this.checkQuiet(), QUIET_CHECK_MS);
    return () => {
      this.silenceListeners.delete(listener);
      if (this.silenceListeners.size > 0 || this.quietTimer === null) return;
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    };
  }

  private setSilence(since: number | null): void {
    if (this.silence === since) return;
    this.silence = since;
    for (const listener of this.silenceListeners) listener();
  }

  /** gxserver answered something. Until the socket is open the chat is not live, so it stays silent. */
  private heard(): void {
    this.lastHeardAt = Date.now();
    if (this.socketOpen) this.setSilence(null);
  }

  private checkQuiet(): void {
    const state = this.state;
    if (this.probing || !this.socketOpen || state.kind !== 'socket' || !foreground()) return;
    if (Date.now() - this.lastHeardAt < QUIET_MS) return;
    this.probing = true;
    const askedAt = Date.now();
    const generation = this.socketGeneration;
    void this.probe(state.endpoint).then((answered) => {
      this.probing = false;
      if (answered) this.heard();
      // A socket replaced meanwhile, or a frame that came in while the question hung, says nothing about now.
      else if (
        generation === this.socketGeneration &&
        this.lastHeardAt < askedAt &&
        this.socketOpen &&
        this.followers.size > 0
      ) {
        this.setSilence(this.silence ?? this.lastHeardAt);
      }
    });
  }

  /**
   * Whether gxserver answers `GET /api/health` over the forward within `PROBE_TIMEOUT_MS`. Any answer
   * counts. It asks the forward as it is and never dials: that is the reconnect's job.
   */
  private async probe(endpoint: Endpoint): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, PROBE_TIMEOUT_MS);
    });
    const asked = (async () => {
      const { localPort } = await GhostexNative.startPortForward(this.machine.id, endpoint.port, GXSERVER_FORWARD_HOST);
      const response = await fetch(`http://127.0.0.1:${localPort}/api/health`, { signal: controller.signal });
      await response.text();
      return true;
    })().catch(() => false);
    try {
      return await Promise.race([asked, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** What this computer's gxserver advertised, once a handshake settled on the socket route. */
  capabilities(): readonly string[] | null {
    return this.state.kind === 'socket' ? this.state.endpoint.capabilities : null;
  }

  /**
   * The loopback forward and token for another socket to this computer's gxserver (the voice
   * agent's `/api/voice`), or null when the computer has no socket route. `repair` first rebuilds
   * a forward a socket was just lost on (the same repair a lost chat request runs).
   */
  async gxserverLink(options: { repair?: boolean } = {}): Promise<GxserverLink | null> {
    if (options.repair === true) await this.repair();
    if ((await this.route()) !== 'socket') return null;
    const state = this.state;
    if (state.kind !== 'socket') return null;
    const localPort = await this.forward(state.endpoint);
    return { localPort, authToken: state.endpoint.authToken, capabilities: state.endpoint.capabilities };
  }

  // ---- the handshake -----------------------------------------------------------------------------

  private async handshake(): Promise<{ route: 'socket'; endpoint: Endpoint } | { route: 'legacy' | 'unavailable' }> {
    try {
      const answer = await readServerEndpoint(this.machine);
      if (answer.kind === 'unsupported') return { route: 'legacy' };
      if (answer.kind === 'failed') return { route: 'unavailable' };
      // A computer on another wire protocol keeps the exec path, whose CLI speaks its own daemon's.
      if (answer.protocolVersion !== PROTOCOL_VERSION) return { route: 'legacy' };
      await GhostexNative.startPortForward(this.machine.id, answer.port, GXSERVER_FORWARD_HOST);
      const sendLedger = answer.capabilities.includes('sendRequestLedger');
      return {
        route: 'socket',
        endpoint: { port: answer.port, authToken: answer.authToken, sendLedger, capabilities: answer.capabilities },
      };
    } catch (error) {
      // An sshd with `AllowTcpForwarding no` will never carry the link; anything else may pass.
      return { route: errorCode(error) === 'E_FORWARDING_PROHIBITED' ? 'legacy' : 'unavailable' };
    }
  }

  /** Forgets the endpoint so the next request or reconnect asks the computer again. */
  private recheck(): void {
    if (this.state.kind === 'socket') this.state = { kind: 'unknown' };
  }

  /**
   * Rebuilds the route after a request or socket was lost on the forward.
   *
   * CDXC:Mobile 2026-10-09 WHY: the forward's loopback listener accepts every connection even when
   * the SSH channel behind it cannot be opened (SSH dropped, the tunnel stalled, gxserver
   * restarting), and it closes each one at once, which OkHttp reports as "unexpected end of
   * stream". `startPortForward` hands back a cached listener without probing it, so asking it again
   * kept every request and the chat socket on the dead one. Here the cached forward is closed, the
   * SSH connection is verified (`ensureConnected` with `verify`, the reconnect rule), and the
   * handshake runs again, which opens and probes a fresh forward. Once per `REPAIR_MIN_INTERVAL_MS`.
   */
  private repair(): Promise<void> {
    if (this.repairing !== null) return this.repairing;
    if (Date.now() - this.lastRepairAt < REPAIR_MIN_INTERVAL_MS) return Promise.resolve();
    this.lastRepairAt = Date.now();
    const state = this.state;
    this.repairing = (async () => {
      if (state.kind === 'socket') {
        this.state = { kind: 'unknown' };
        await GhostexNative.stopPortForward(this.machine.id, state.endpoint.port).catch(() => undefined);
      }
      await ensureConnected(this.machine, { verify: true }).catch(() => undefined);
      await this.route();
    })().finally(() => {
      this.repairing = null;
    });
    return this.repairing;
  }

  /**
   * Whether a request lost on the forward may be sent again. Reads may. A send may only when
   * gxserver advertised its send ledger and the request names its `sendRequestId`: the first attempt
   * may already have typed the message, and the ledger answers a repeat from that attempt instead of
   * typing it twice. Every other request is left to the user.
   */
  private retrySafe(method: string, params: unknown, endpoint: Endpoint): boolean {
    if (READ_ONLY_METHODS.has(method)) return true;
    const sendRequestId = (params as { sendRequestId?: unknown } | null)?.sendRequestId;
    return LEDGER_SEND_METHODS.has(method) && endpoint.sendLedger && typeof sendRequestId === 'string';
  }

  /**
   * The phone's loopback port for this computer's gxserver. Both calls are cheap when the SSH
   * connection and the forward are alive; after a reconnect (which closes every forward) they
   * dial and forward again.
   */
  private async forward(endpoint: Endpoint): Promise<number> {
    await ensureConnected(this.machine);
    try {
      const { localPort } = await GhostexNative.startPortForward(this.machine.id, endpoint.port, GXSERVER_FORWARD_HOST);
      return localPort;
    } catch (error) {
      // Nothing listens on the old port: gxserver is down or moved.
      if (errorCode(error) === 'E_PORT_NOT_LISTENING') this.recheck();
      throw error;
    }
  }

  // ---- requests ----------------------------------------------------------------------------------

  /**
   * One chat request over the forward, answered in the core's terms like `native_chat/rpc.rs`.
   * Never throws. A request lost on the forward repairs the link, then a read (or a ledger send) is
   * sent once more over the fresh forward and, failing that, handed to the exec route; anything
   * else answers `unreachable` with one plain sentence, which the core treats like a failed SSH
   * command (a read retries quietly, a send returns to the composer under the same
   * `sendRequestId`).
   */
  async request(method: string, params: unknown, timeoutMs: number): Promise<LinkAnswer> {
    const endpoint = `/api/${method}`;
    const state = this.state;
    if (state.kind !== 'socket') return { kind: 'fallBack' };
    const retrySafe = this.retrySafe(method, params, state.endpoint);
    const first = await this.attempt(state.endpoint, method, params, timeoutMs);
    if (first.kind === 'answered') return first;
    if (first.kind === 'notSent') return { kind: 'fallBack' };
    // A timed-out request may still be running on the computer; the core decides what follows.
    if (first.timedOut) return unreachable(endpoint, TIMEOUT_MESSAGE);
    await this.repair();
    if (!retrySafe) return unreachable(endpoint, UNREACHABLE_MESSAGE);
    const repaired = this.state;
    if (repaired.kind === 'socket') {
      const second = await this.attempt(repaired.endpoint, method, params, timeoutMs);
      if (second.kind === 'answered') return second;
      if (second.kind === 'lost' && second.timedOut) return unreachable(endpoint, TIMEOUT_MESSAGE);
    }
    return { kind: 'fallBack' };
  }

  /** `request` for a caller with no exec route of its own: a fall-back answers `unreachable`. */
  async rpc(method: string, params: unknown, timeoutMs: number): Promise<RpcAnswer> {
    const sent = await this.request(method, params, timeoutMs);
    if (sent.kind === 'answered') return sent.answer;
    return { error: { code: 'unreachable', message: UNREACHABLE_MESSAGE, endpoint: `/api/${method}` } };
  }

  /**
   * One HTTP attempt through the forward, sent again while gxserver answers that it is still
   * starting (HTTP 503 `serverStarting`), after the delay it advises and within `timeoutMs`: such a
   * request used to wait in the starting gxserver's listen backlog, and nothing ran behind that
   * answer, so a resend cannot run it twice (the rule: packages/gx-protocol/src/starting.rs).
   */
  private async attempt(endpointInfo: Endpoint, method: string, params: unknown, timeoutMs: number): Promise<Attempt> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.attemptOnce(endpointInfo, method, params, Math.max(1, deadline - Date.now()));
      const retryAfterMs = result.kind === 'answered' ? result.startingRetryAfterMs : undefined;
      if (retryAfterMs === undefined || Date.now() + retryAfterMs >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }

  private async attemptOnce(
    endpointInfo: Endpoint,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Attempt & { startingRetryAfterMs?: number }> {
    const endpoint = `/api/${method}`;
    let localPort: number;
    try {
      localPort = await this.forward(endpointInfo);
    } catch {
      return { kind: 'notSent' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpointInfo.authToken}`,
          'Content-Type': 'application/json',
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, params: params ?? {} }),
        signal: controller.signal,
      });
      const text = await response.text();
      this.heard();
      // A refused token means gxserver issued a new one; the next request asks for it.
      if (response.status === 401) this.recheck();
      let envelope: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === 'object' && parsed !== null) envelope = parsed as Record<string, unknown>;
      } catch {
        // Answered below.
      }
      if (envelope === null) {
        const message = "Ghostex on this computer sent an answer the phone couldn't read.";
        return { kind: 'answered', answer: { error: { code: null, message, endpoint } } };
      }
      if (envelope.ok === false) {
        const error = {
          code: typeof envelope.error === 'string' ? envelope.error : null,
          message: typeof envelope.message === 'string' ? envelope.message : 'Request failed.',
          endpoint,
        };
        const startingRetryAfterMs =
          response.status === 503 && envelope.product === 'gxserver' && envelope.error === 'serverStarting'
            ? Math.min(2_000, Math.max(50, typeof envelope.retryAfterMs === 'number' ? envelope.retryAfterMs : 250))
            : undefined;
        return { kind: 'answered', answer: { error }, startingRetryAfterMs };
      }
      if (!response.ok || envelope.ok !== true) {
        const message = `gxserver request failed with HTTP ${response.status}.`;
        return { kind: 'answered', answer: { error: { code: null, message, endpoint } } };
      }
      return { kind: 'answered', answer: { result: envelope.result ?? null, error: null } };
    } catch (error) {
      // The raw OkHttp text ("unexpected end of stream on http://127.0.0.1:…") is for logcat only.
      console.warn(`[chat-link] ${method} lost: ${errorMessage(error)}`);
      return { kind: 'lost', timedOut: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- the socket --------------------------------------------------------------------------------

  /**
   * Follows a conversation with at least `limit` messages. The first follow subscribes it on the
   * wire; a repeat only records the wider window for the next (re)subscribe, `ChatStreams::follow`'s
   * rule.
   */
  follow(projectId: string, sessionId: string, limit: number, onFrame: (frame: Record<string, unknown>) => void): void {
    const key = followerKey(projectId, sessionId);
    const existing = this.followers.get(key);
    if (existing !== undefined) {
      existing.limit = Math.max(existing.limit, limit);
      existing.onFrame = onFrame;
      return;
    }
    this.followers.set(key, { projectId, sessionId, limit, onFrame });
    // The chat is not live until the socket opens (`silentSince`).
    if (!this.socketOpen) this.setSilence(this.silence ?? Date.now());
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.socketOpen) this.send(this.subscribeMessage(this.followers.get(key)!));
    else this.ensureSocket();
  }

  /** Subscribes a followed conversation again, which makes gxserver send a fresh snapshot. */
  refresh(projectId: string, sessionId: string): void {
    const follower = this.followers.get(followerKey(projectId, sessionId));
    if (follower !== undefined && this.socketOpen) this.send(this.subscribeMessage(follower));
  }

  /** Stops following a conversation. The socket closes a while after its last follower leaves. */
  unfollow(projectId: string, sessionId: string): void {
    const key = followerKey(projectId, sessionId);
    if (!this.followers.delete(key)) return;
    if (this.followers.size === 0) this.setSilence(null);
    if (this.socketOpen) this.send(JSON.stringify({ type: 'unsubscribeSessionChat', projectId, sessionId }));
    if (this.followers.size > 0 || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.followers.size === 0) this.closeSocket();
    }, IDLE_CLOSE_MS);
  }

  private subscribeMessage(follower: Follower): string {
    return JSON.stringify({
      type: 'subscribeSessionChat',
      projectId: follower.projectId,
      sessionId: follower.sessionId,
      limit: follower.limit,
    });
  }

  private send(message: string): void {
    try {
      this.socket?.send(message);
    } catch {
      // A socket that cannot send is closing; its close handler reconnects and resubscribes.
    }
  }

  /** Opens the socket when a chat follows this computer and none is open or opening. */
  private ensureSocket(): void {
    if (this.followers.size === 0 || this.socket !== null || this.connecting || this.retryTimer !== null) return;
    void this.connect();
  }

  /** Back in the foreground, or SSH just reconnected: try at once instead of waiting out the ladder. */
  private reconnectNow(): void {
    if (this.socket !== null || this.connecting || this.followers.size === 0) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failedOpens = 0;
    void this.connect();
  }

  /**
   * CDXC:RemoteMachines 2026-10-16 WHY:
   * iOS suspends the app's sockets in the background, and one it killed there can still read as
   * open on return, so the chat sat on a socket that would never deliver another frame. Back from
   * the background every follower subscribes again (gxserver answers each with a fresh snapshot,
   * which also replaces anything missed while suspended); a socket that sends nothing within
   * `RESUME_ANSWER_MS` is dropped and a new one opened.
   */
  private checkResumedSocket(): void {
    if (!this.socketOpen) {
      this.replaceSocket();
      return;
    }
    for (const follower of this.followers.values()) this.send(this.subscribeMessage(follower));
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    const generation = this.socketGeneration;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (generation === this.socketGeneration) this.replaceSocket();
    }, RESUME_ANSWER_MS);
  }

  /** Drops the current socket without waiting for its close and opens a fresh one now. */
  private replaceSocket(): void {
    this.closeSocket();
    this.reconnectNow();
  }

  private async connect(): Promise<void> {
    if (this.connecting || !mayReconnect(this.machine.id)) return;
    this.connecting = true;
    try {
      const route = await this.route();
      // A computer that turned out to be old: its followers move to the exec long poll themselves.
      if (route === 'legacy' || this.followers.size === 0) return;
      const state = this.state;
      if (route !== 'socket' || state.kind !== 'socket') {
        this.openFailed();
        return;
      }
      let localPort: number;
      try {
        localPort = await this.forward(state.endpoint);
      } catch {
        this.openFailed();
        return;
      }
      if (this.followers.size === 0) return;
      this.open(localPort, state.endpoint);
    } finally {
      this.connecting = false;
    }
  }

  private open(localPort: number, endpoint: Endpoint): void {
    const generation = ++this.socketGeneration;
    const url = `ws://127.0.0.1:${localPort}/api/events?protocolVersion=${PROTOCOL_VERSION}&stream=sessionChat`;
    // React Native's WebSocket takes headers, so the token never travels in the URL.
    const socket = new (WebSocket as unknown as HeaderWebSocket)(url, undefined, {
      headers: { Authorization: `Bearer ${endpoint.authToken}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    });
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.socketGeneration) return;
      this.setSocketOpen(true);
      this.failedOpens = 0;
      // gxserver has no replay: every open subscribes every follower, and each answers with a
      // fresh snapshot that replaces whatever a dropped socket lost.
      for (const follower of this.followers.values()) this.send(this.subscribeMessage(follower));
    };
    socket.onmessage = (event: WebSocketMessageEvent) => {
      if (generation !== this.socketGeneration || typeof event.data !== 'string') return;
      if (this.resumeTimer !== null) {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
      }
      this.heard();
      this.receive(event.data);
    };
    socket.onerror = () => {
      // `onclose` follows and does the work.
    };
    socket.onclose = () => {
      if (generation !== this.socketGeneration) return;
      const wasOpen = this.socketOpen;
      this.socket = null;
      this.setSocketOpen(false);
      if (this.followers.size === 0) return;
      if (wasOpen) this.scheduleReconnect();
      else this.openFailed();
    };
  }

  private openFailed(): void {
    this.failedOpens += 1;
    if (this.failedOpens >= FAILED_OPENS_BEFORE_RECHECK) {
      this.failedOpens = 0;
      // The same dead listener would refuse every later open too (`repair`).
      void this.repair().then(() => this.scheduleReconnect());
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * The next ladder step. In the background nothing is scheduled (`active` reconnects at once),
   * except for Voice mode's computer, on the slower background steps.
   */
  private scheduleReconnect(): void {
    if (this.retryTimer !== null || this.followers.size === 0 || !mayReconnect(this.machine.id)) return;
    const ladder = foreground() ? RECONNECT_DELAYS_MS : BACKGROUND_RECONNECT_DELAYS_MS;
    const delay = ladder[Math.min(this.failedOpens, ladder.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private closeSocket(): void {
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    this.setSocketOpen(false);
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }

  /**
   * Routes one socket message to the chat that follows its conversation: the checks `route` in
   * `wire.rs` makes. A model catalog push is kept for this computer's chats; the
   * `eventStreamReady` header and frames for a conversation unfollowed a moment ago are dropped.
   */
  private receive(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === 'agentModelCatalogChanged' && typeof frame.catalog === 'object' && frame.catalog !== null) {
      this.modelCatalog = frame.catalog;
      for (const listener of this.catalogListeners) listener(frame.catalog);
      return;
    }
    if (
      typeof frame.type !== 'string' ||
      !FRAME_TYPES.has(frame.type) ||
      typeof frame.epoch !== 'number' ||
      typeof frame.seq !== 'number' ||
      typeof frame.serverId !== 'string' ||
      frame.protocolVersion !== PROTOCOL_VERSION ||
      typeof frame.projectId !== 'string' ||
      typeof frame.sessionId !== 'string'
    ) {
      return;
    }
    this.followers.get(followerKey(frame.projectId, frame.sessionId))?.onFrame(frame);
  }
}

const links = new Map<string, ChatMachineLink>();

/** The one chat link for a computer, created on first use and kept for the life of the app. */
export function chatMachineLink(machine: MachineConnectionTarget): ChatMachineLink {
  let link = links.get(machine.id);
  if (link === undefined) {
    link = new ChatMachineLink(machine);
    links.set(machine.id, link);
  } else {
    link.retarget(machine);
  }
  return link;
}

export type { ChatMachineLink };
