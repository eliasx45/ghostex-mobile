/**
 * App settings store. Group/row order mirrors the legacy Android Settings page
 * (artifacts/001-mobile-settings-report/report.md): Terminal behavior, Extra
 * keys, Font size, Scrollback, Cursor, Alerts and hardware keys, then the
 * appended SSH connection group. Persisted to AsyncStorage under settings.v1
 * (new fields sanitize to their defaults for existing installs).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';

import type { CursorStyle } from '../../modules/ghostex-native/src/GhostexNative.types';
import type { ChatBrain } from '../chat/rust/core-backend';
import {
  clampSidebarContrast,
  DEFAULT_SIDEBAR_BACKGROUND_CONTRAST,
  DEFAULT_SIDEBAR_BACKGROUND_TINT,
  normalizeSidebarTint,
} from '../theme/sidebarAppearance';

const SETTINGS_STORAGE_KEY = 'settings.v1';

export type BellBehavior = 'vibrate' | 'beep' | 'ignore';
export type SessionChatTheme = 'dark' | 'light';
/**
 * How the chat colours the sections an agent marks: the desktop's `markedHandoversStyle` values, plus
 * `plain` because the phone cannot see whether the computer's Marked handovers is on.
 */
export type MarkedHandoversStyle = 'labels' | 'rule' | 'badge' | 'plain';
/** Same value space as the desktop app's global Default Agent View setting. */
export type PreferredAgentInterface = 'terminal' | 'chat';

export type GhostexSettings = {
  // Terminal behavior (legacy Android row order).
  autoScroll: boolean;
  extraKeysToolbarVisible: boolean;
  softKeyboardEnabled: boolean;
  keepScreenOn: boolean;
  refreshButtonVisible: boolean;
  fileUploadButtonVisible: boolean;
  keyboardButtonVisible: boolean;
  doneNotificationSound: boolean;
  hideKeyboardOnStartup: boolean;
  openUrlsOnTap: boolean;
  confirmTabClose: boolean;
  /** Haptic tick on key-bar presses + lock-in buzz on held modifiers. */
  keyBarHapticsEnabled: boolean;
  /** Terminal font size in pt (iOS) / sp (Android). Range 4-32. */
  fontSize: number;
  /** Scrollback rows for newly created terminal buffers. */
  scrollbackRows: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  bellBehavior: BellBehavior;
  /** GPUI-parity constrained sidebar background contrast (85-100). */
  sidebarBackgroundContrast: number;
  /** GPUI-parity sidebar background tint as a normalized #rrggbb value. */
  sidebarBackgroundTint: string;
  /** Opacity percentage for sidebar collection-panel backgrounds and borders. */
  sidebarGroupsOpacityPercent: number;
  /**
   * Which view chat-capable agent sessions open in when the user has not
   * flipped that session's own toggle yet (desktop-parity Default Agent View).
   */
  preferredAgentInterface: PreferredAgentInterface;
  /** Theme for chat content only; the surrounding mobile app remains dark. */
  sessionChatTheme: SessionChatTheme;
  /** Whether the transcript uses a custom width instead of the composer column. */
  sessionChatCustomTranscriptWidthEnabled: boolean;
  /** Width of the message transcript; the prompt composer keeps its full width. */
  sessionChatTranscriptWidthPercent: number;
  /**
   * Simplify every chat: hide tool command previews and fold tool runs and file edits behind
   * expandable counts. Same key and default as the desktop's `sessionChatSimpleMode`.
   */
  sessionChatSimpleMode: boolean;
  /**
   * Draw the chat's question cards in Claude Code's look (desktop `sessionChatClaudeLook`, on by
   * default). The phone has no owner pack, so its Claude look uses its own theme's colours.
   */
  sessionChatClaudeLook: boolean;
  /** Reveal thinking-owned tool calls by default. */
  sessionChatVerboseMode: boolean;
  /**
   * The session links sheet's folded groups (`open`, `finished`, `suggested`, `removed`), one
   * choice per group for every session; the desktop's `sessionLinksFoldedGroups`
   * (SessionLinksSheet.tsx).
   */
  sessionLinksFoldedGroups: string[];
  sessionChatFileEditPreviews: boolean;
  /** Grey thinking: the agent's thinking in the muted tone, its replies in the full foreground. */
  sessionChatMutedThinking: boolean;
  /**
   * Draw the chat transcript with the desktop's own GPUI renderer (`packages/gpui-mobile` in the
   * main repo) instead of the React Native one. Only builds of the phone library made with
   * `build.sh --gpui` can; the switch is hidden otherwise.
   */
  sessionChatGpuiTranscript: boolean;
  /**
   * Which chat brain runs a chat: the Rust chat core built into the app, or the same core as
   * WebAssembly in a hidden WebView, which updates over the air (`src/chat/rust/core-backend.ts`,
   * CDXC:SessionChat 2026-10-23 DECISION in `src/chat/rust/wasm-core/bridge.ts`). Read when a chat
   * opens. Built-in until the user makes the WebView the default.
   */
  sessionChatBrain: ChatBrain;
  markedHandoversStyle: MarkedHandoversStyle;
  /** Show the marker emoji in coloured marked sections (desktop `markedHandoversEmoji`, off by default). */
  markedHandoversEmoji: boolean;
  /**
   * Read aloud's voice on this phone: a voice name of the phone's text-to-speech engine, or `''`
   * for its default. The phone's own, never the computer's `readAloudVoice` (spec 6.4).
   */
  readAloudVoice: string;
  /** Read aloud's speed on this phone, a multiple of the engine's normal rate ({@link READ_ALOUD_RATES}). */
  readAloudRate: number;
  // SSH connection (appended group).
  autoReconnect: boolean;
  keepAliveEnabled: boolean;
  /** Keep-alive interval in seconds, 10-120 in 10-second steps. */
  keepAliveIntervalSec: number;
};

export const TERMINAL_FONT_SIZE_MIN = 4;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const SCROLLBACK_ROWS_MIN = 500;
export const SCROLLBACK_ROWS_MAX = 20_000;
export const SCROLLBACK_ROWS_STEP = 500;
export const CURSOR_STYLE_OPTIONS: CursorStyle[] = ['block', 'underline', 'bar'];
export const BELL_BEHAVIOR_OPTIONS: BellBehavior[] = ['vibrate', 'beep', 'ignore'];

export const KEEP_ALIVE_INTERVAL_MIN_SEC = 10;
export const KEEP_ALIVE_INTERVAL_MAX_SEC = 120;
export const KEEP_ALIVE_INTERVAL_STEP_SEC = 10;

/** The Speed choices, the same as the desktop's `readAloudRate` row. */
export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export const SIDEBAR_SURFACE_OPACITY_MIN = 0;
export const SIDEBAR_SURFACE_OPACITY_MAX = 100;

export const MIN_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT = 50;
export const MAX_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT = 100;
export const SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT_STEP = 5;
export const DEFAULT_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT = 100;

export function clampSessionChatTranscriptWidthPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT;
  const clamped = Math.min(
    MAX_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT,
    Math.max(MIN_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT, value),
  );
  return Math.round(clamped / SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT_STEP) * SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT_STEP;
}

export function defaultFontSize(): number {
  return Platform.OS === 'ios' ? 10 : 13;
}

export function defaultSettings(): GhostexSettings {
  return {
    autoScroll: true,
    extraKeysToolbarVisible: true,
    softKeyboardEnabled: true,
    keepScreenOn: false,
    refreshButtonVisible: false,
    fileUploadButtonVisible: true,
    keyboardButtonVisible: false,
    doneNotificationSound: true,
    hideKeyboardOnStartup: true,
    openUrlsOnTap: true,
    confirmTabClose: false,
    keyBarHapticsEnabled: true,
    fontSize: defaultFontSize(),
    scrollbackRows: 2_000,
    cursorStyle: 'bar',
    cursorBlink: true,
    bellBehavior: 'vibrate',
    sidebarBackgroundContrast: DEFAULT_SIDEBAR_BACKGROUND_CONTRAST,
    sidebarBackgroundTint: DEFAULT_SIDEBAR_BACKGROUND_TINT,
    sidebarGroupsOpacityPercent: SIDEBAR_SURFACE_OPACITY_MIN,
    preferredAgentInterface: 'chat',
    sessionChatTheme: 'dark',
    sessionChatCustomTranscriptWidthEnabled: false,
    sessionChatTranscriptWidthPercent: DEFAULT_SESSION_CHAT_TRANSCRIPT_WIDTH_PERCENT,
    sessionChatSimpleMode: true,
    sessionChatClaudeLook: true,
    sessionChatVerboseMode: false,
    sessionLinksFoldedGroups: ['finished', 'removed'],
    sessionChatFileEditPreviews: false,
    sessionChatMutedThinking: false,
    sessionChatGpuiTranscript: false,
    sessionChatBrain: 'builtIn',
    markedHandoversStyle: 'labels',
    markedHandoversEmoji: false,
    readAloudVoice: '',
    readAloudRate: 1,
    autoReconnect: true,
    keepAliveEnabled: true,
    keepAliveIntervalSec: 30,
  };
}

function clampKeepAliveInterval(value: number): number {
  const stepped = Math.round(value / KEEP_ALIVE_INTERVAL_STEP_SEC) * KEEP_ALIVE_INTERVAL_STEP_SEC;
  return Math.min(KEEP_ALIVE_INTERVAL_MAX_SEC, Math.max(KEEP_ALIVE_INTERVAL_MIN_SEC, stepped));
}

function clampSidebarSurfaceOpacity(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(SIDEBAR_SURFACE_OPACITY_MAX, Math.max(SIDEBAR_SURFACE_OPACITY_MIN, Math.round(value)));
}

export function clampScrollbackRows(value: number): number {
  const stepped = Math.round(value / SCROLLBACK_ROWS_STEP) * SCROLLBACK_ROWS_STEP;
  return Math.min(SCROLLBACK_ROWS_MAX, Math.max(SCROLLBACK_ROWS_MIN, stepped));
}

function sanitizeSettings(value: unknown): GhostexSettings {
  const defaults = defaultSettings();
  if (typeof value !== 'object' || value === null) return defaults;
  const record = value as Record<string, unknown>;
  const bool = (key: keyof GhostexSettings, fallback: boolean): boolean =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback;
  const fontSize =
    typeof record.fontSize === 'number' && Number.isFinite(record.fontSize)
      ? Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(record.fontSize)))
      : defaults.fontSize;
  const scrollbackRows =
    typeof record.scrollbackRows === 'number' && Number.isFinite(record.scrollbackRows)
      ? clampScrollbackRows(record.scrollbackRows)
      : defaults.scrollbackRows;
  const cursorStyle = CURSOR_STYLE_OPTIONS.includes(record.cursorStyle as CursorStyle)
    ? (record.cursorStyle as CursorStyle)
    : defaults.cursorStyle;
  const bellBehavior = BELL_BEHAVIOR_OPTIONS.includes(record.bellBehavior as BellBehavior)
    ? (record.bellBehavior as BellBehavior)
    : defaults.bellBehavior;
  const keepAliveIntervalSec =
    typeof record.keepAliveIntervalSec === 'number' && Number.isFinite(record.keepAliveIntervalSec)
      ? clampKeepAliveInterval(record.keepAliveIntervalSec)
      : defaults.keepAliveIntervalSec;
  const sidebarBackgroundContrast =
    typeof record.sidebarBackgroundContrast === 'number'
      ? clampSidebarContrast(record.sidebarBackgroundContrast)
      : defaults.sidebarBackgroundContrast;
  const sidebarBackgroundTint =
    typeof record.sidebarBackgroundTint === 'string'
      ? normalizeSidebarTint(record.sidebarBackgroundTint)
      : defaults.sidebarBackgroundTint;
  const sidebarGroupsOpacityPercent =
    typeof record.sidebarGroupsOpacityPercent === 'number'
      ? clampSidebarSurfaceOpacity(record.sidebarGroupsOpacityPercent, defaults.sidebarGroupsOpacityPercent)
      : defaults.sidebarGroupsOpacityPercent;
  const preferredAgentInterface =
    record.preferredAgentInterface === 'terminal' || record.preferredAgentInterface === 'chat'
      ? record.preferredAgentInterface
      : defaults.preferredAgentInterface;
  const sessionChatTheme =
    record.sessionChatTheme === 'dark' || record.sessionChatTheme === 'light'
      ? record.sessionChatTheme
      : defaults.sessionChatTheme;
  const sessionChatTranscriptWidthPercent =
    typeof record.sessionChatTranscriptWidthPercent === 'number'
      ? clampSessionChatTranscriptWidthPercent(record.sessionChatTranscriptWidthPercent)
      : defaults.sessionChatTranscriptWidthPercent;
  return {
    autoScroll: bool('autoScroll', defaults.autoScroll),
    extraKeysToolbarVisible: bool('extraKeysToolbarVisible', defaults.extraKeysToolbarVisible),
    softKeyboardEnabled: bool('softKeyboardEnabled', defaults.softKeyboardEnabled),
    keepScreenOn: bool('keepScreenOn', defaults.keepScreenOn),
    refreshButtonVisible: bool('refreshButtonVisible', defaults.refreshButtonVisible),
    fileUploadButtonVisible: bool('fileUploadButtonVisible', defaults.fileUploadButtonVisible),
    keyboardButtonVisible: bool('keyboardButtonVisible', defaults.keyboardButtonVisible),
    doneNotificationSound: bool('doneNotificationSound', defaults.doneNotificationSound),
    hideKeyboardOnStartup: bool('hideKeyboardOnStartup', defaults.hideKeyboardOnStartup),
    openUrlsOnTap: bool('openUrlsOnTap', defaults.openUrlsOnTap),
    confirmTabClose: bool('confirmTabClose', defaults.confirmTabClose),
    keyBarHapticsEnabled: bool('keyBarHapticsEnabled', defaults.keyBarHapticsEnabled),
    fontSize,
    scrollbackRows,
    cursorStyle,
    cursorBlink: bool('cursorBlink', defaults.cursorBlink),
    bellBehavior,
    sidebarBackgroundContrast,
    sidebarBackgroundTint,
    sidebarGroupsOpacityPercent,
    preferredAgentInterface,
    sessionChatTheme,
    sessionChatCustomTranscriptWidthEnabled: bool(
      'sessionChatCustomTranscriptWidthEnabled',
      defaults.sessionChatCustomTranscriptWidthEnabled,
    ),
    sessionChatTranscriptWidthPercent,
    sessionChatFileEditPreviews: bool('sessionChatFileEditPreviews', defaults.sessionChatFileEditPreviews),
    sessionChatMutedThinking: bool('sessionChatMutedThinking', defaults.sessionChatMutedThinking),
    sessionChatSimpleMode: bool('sessionChatSimpleMode', defaults.sessionChatSimpleMode),
    sessionChatClaudeLook: bool('sessionChatClaudeLook', defaults.sessionChatClaudeLook),
    sessionChatVerboseMode: bool('sessionChatVerboseMode', defaults.sessionChatVerboseMode),
    sessionLinksFoldedGroups: Array.isArray(record.sessionLinksFoldedGroups)
      ? record.sessionLinksFoldedGroups.filter((group): group is string => typeof group === 'string')
      : defaults.sessionLinksFoldedGroups,
    sessionChatGpuiTranscript: bool('sessionChatGpuiTranscript', defaults.sessionChatGpuiTranscript),
    sessionChatBrain:
      record.sessionChatBrain === 'builtIn' || record.sessionChatBrain === 'browserView'
        ? record.sessionChatBrain
        : defaults.sessionChatBrain,
    markedHandoversStyle:
      record.markedHandoversStyle === 'labels' ||
      record.markedHandoversStyle === 'rule' ||
      record.markedHandoversStyle === 'badge' ||
      record.markedHandoversStyle === 'plain'
        ? record.markedHandoversStyle
        : defaults.markedHandoversStyle,
    markedHandoversEmoji: bool('markedHandoversEmoji', defaults.markedHandoversEmoji),
    readAloudVoice: typeof record.readAloudVoice === 'string' ? record.readAloudVoice : defaults.readAloudVoice,
    readAloudRate: (READ_ALOUD_RATES as readonly number[]).includes(record.readAloudRate as number)
      ? (record.readAloudRate as number)
      : defaults.readAloudRate,
    autoReconnect: bool('autoReconnect', defaults.autoReconnect),
    keepAliveEnabled: bool('keepAliveEnabled', defaults.keepAliveEnabled),
    keepAliveIntervalSec,
  };
}

type SettingsState = {
  hydrated: boolean;
  settings: GhostexSettings;
  hydrate: () => Promise<void>;
  setSetting: <K extends keyof GhostexSettings>(key: K, value: GhostexSettings[K]) => void;
};

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  hydrated: false,
  settings: defaultSettings(),

  hydrate: async () => {
    if (get().hydrated) return;
    let settings = defaultSettings();
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw !== null) settings = sanitizeSettings(JSON.parse(raw));
    } catch {
      // Corrupt persisted settings fall back to defaults.
    }
    set({ hydrated: true, settings });
  },

  setSetting: (key, value) => {
    const settings = { ...get().settings, [key]: value };
    set({ settings });
    void AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  },
}));
