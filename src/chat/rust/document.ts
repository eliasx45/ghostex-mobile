/**
 * The "what to draw" contract: the frame the Rust chat core drains and the document inside it.
 *
 * Source of truth: `packages/gx-chat-core/src/document/` in the Ghostex main repo (`frame.rs`,
 * `snapshot.rs`, `transcript.rs`, `composer.rs`, `panels.rs`, `queue.rs`, `question.rs`,
 * `view.rs`). Every key below is the serde spelling of that crate, and the desktop renderer
 * (`apps/desktop/src/app/native_chat/`) reads the same JSON by key. Each field says which desktop
 * file draws it, so a screen agent can open that file to see exactly what the value looks like on
 * screen.
 *
 * Wire rules that are easy to get wrong:
 *
 * - Absent, `null` and a value are three different things. A field typed `?:` can be missing from
 *   the JSON (Rust `Tri` with `skip_serializing_if = "Tri::is_absent"`, or an `Option` that is
 *   skipped). A field typed `T | null` is always present and may be `null`. Keep the difference:
 *   "absent" usually means "not known yet", `null` means "known to be nothing".
 * - Rust `Tri<T>` fields WITHOUT the skip attribute (most of the `Tri<Value>` ones below) are
 *   always present: absent and null both serialize as `null`.
 * - Integers stay integers.
 * - `serde_json::Value` subtrees are typed `unknown` or with a loose record here. They belong to a
 *   port family that has not typed them in Rust yet; the desktop file named beside each one is the
 *   authority on what it reads.
 */

/** Any JSON value, for the subtrees the Rust core has not typed yet. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object whose keys the Rust core keeps free-form. */
export type JsonObject = { [key: string]: Json };

/** The Run on row above a new thread's composer (gx-chat-core `menus/run_location.rs`). */
export type RunLocationRow = {
  label: string;
  /** The selected chip's `runLocation`: `local` or `agentbox:<provider>`. */
  selected: string;
  /** A switch is in flight. */
  busy: boolean;
  options: {
    runLocation: string;
    label: string;
    icon: 'computer' | 'box' | 'server' | 'cloud';
    tooltip: string | null;
  }[];
};

// ---------------------------------------------------------------------------------------------
// The frame envelope
// ---------------------------------------------------------------------------------------------

/**
 * One drain of the core (`Frame` in `document/frame.rs`): what changed since the host's last
 * revision. Every optional channel is left out when it did not change; a missing channel means
 * "keep what you have". Desktop applies it in `native_chat/state.rs` (`apply_output`).
 */
export type ChatFrame = {
  /** The changed window of the main transcript list. Apply it with {@link applyItemsSplice}. */
  itemsSplice?: ItemsSplice;
  /** The minimap rail, shipped whole and only when it changed. Desktop: `minimap.rs`. */
  minimap?: MinimapMarker[];
  /** The open subagent viewer's own transcript list, as a splice on its own channel.
   * Desktop: `subagent_view.rs`. */
  subagentSplice?: ItemsSplice;
  /** Details of the rows the screen reported open (the `rowDetails` action, as desktop sends it),
   * keyed by the screen's own row key. Replaces the previous map whole. Desktop: `row_details.rs`. */
  rowDetails?: RowDetails;
  /** Bumped once per publish. Pass the last value you applied back into the next drain. */
  revision: number;
  /** The whole view document, present only when `revision` moved past the one you passed. */
  snapshot?: ChatDocument;
  /** Always `[]` from the mobile binding: effects come back from `handle()` instead. */
  requests: unknown[];
  /** Milliseconds until the core's next timer, or `null` when none is armed. */
  nextWakeMs: number | null;
};

/**
 * Replace `deleteCount` items at `start` with `items` (`ItemsSplice` in `document/frame.rs`).
 * The first drain (and the first after `forgetSent`) is a splice from an empty list.
 */
export type ItemsSplice = {
  start: number;
  deleteCount: number;
  items: TranscriptItem[];
  /** The producer's own list length after the splice. Desktop ignores it; handy as a check. */
  length: number;
};

/**
 * Applies a splice to a copy of `current`. Unchanged items keep their object identity, so a
 * `FlatList` keyed by {@link transcriptItemKey} re-renders only the rows that moved.
 */
export function applyItemsSplice(current: readonly TranscriptItem[], splice: ItemsSplice): TranscriptItem[] {
  const start = Math.min(Math.max(0, splice.start), current.length);
  const end = Math.min(current.length, start + Math.max(0, splice.deleteCount));
  return [...current.slice(0, start), ...splice.items, ...current.slice(end)];
}

/** A stable React key for a transcript item: `native-presentation.ts`'s `transcriptItemKey`. */
export function transcriptItemKey(item: TranscriptItem): string {
  if (item.kind === 'message') {
    const id = (item.message as { id?: unknown } | undefined)?.id;
    return `message:${typeof id === 'string' ? id : ''}`;
  }
  const id = (item as { id?: unknown }).id;
  return `${String(item.kind)}:${typeof id === 'string' ? id : ''}`;
}

/**
 * One dash on the transcript minimap (`packages/gx-chat-core/src/extras/minimap.rs`). Desktop:
 * `minimap.rs`.
 */
export type MinimapMarker = {
  /** The user prompt's message id. */
  id: string;
  /** Index into the main transcript item list that the dash scrolls to. */
  item: number;
  /** One-line preview of the prompt, for the hover card. */
  prompt: string;
  /** One-line preview of the reply. */
  reply: string;
};

/**
 * Open-row details by the screen's row key. A file change card's value holds its diff lines; a
 * tool row's value holds its call arguments and result. Desktop: `row_details.rs`, drawn by
 * `file_change_card.rs` and `tool_run.rs`.
 */
export type RowDetails = { [rowKey: string]: Json };

// ---------------------------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------------------------

/**
 * One row group in the transcript (`TranscriptItem` in `document/transcript.rs`), tagged by
 * `kind`. Desktop dispatches on `kind` alone in `transcript.rs`.
 */
export type TranscriptItem = MessageItem | SummaryItem | CompletedWorkItem | UnknownItem;

/** A single message card. Desktop: `transcript.rs` then the per-kind row files. */
export type MessageItem = { kind: 'message'; message: ProjectedMessage };

/** One user turn in summary mode (the composer's Summary toggle): prompt, reply, and the work
 * between them folded. Desktop: `transcript.rs` (`item["kind"] == "summary"`). */
export type SummaryItem = {
  kind: 'summary';
  id: string;
  user: ProjectedMessage;
  /** The turn's reply, or `null` while the turn is still running. */
  final: ProjectedMessage | null;
  /** The replies before `final` in the same turn, oldest first (one per stretch a background task
   * finishing broke the turn into). Drawn above `final`. */
  earlierReplies?: ProjectedMessage[];
  /** The turn is the live one. */
  active: boolean;
  /** The running turn's rows behind its "Active work" fold. */
  work: ProjectedMessage[];
  /** The running turn's "Active work" fold starts open (gx-chat-core `summary_mode_turns`). */
  workOpen?: boolean;
  /** What ended a turn the agent wrote no reply to: a slash command's output ("Set effort level to
   * High") or the "Agent was interrupted" marker. Drawn under the prompt without a fold. */
  outcome?: ProjectedMessage[];
  /** The newest turn that has a reply: its "Agent reply" fold starts open. */
  latestReply?: boolean;
};

/** One count beside a finished turn's "Worked for 2m 5s" (gx-chat-core `work_summary.rs`). */
export type WorkStat = {
  /** Picks the chip's glyph and tone. */
  kind: 'tools' | 'files' | 'failed' | 'recovered';
  /** "4 tool calls", "1 file", "1 failed, then passed". */
  label: string;
};

/** A finished turn in verbose mode: "Worked for 2m 5s" with its counts, plus its file changes in one
 * fold. Desktop: `completed_work_row.rs`, `deferred_work.rs`. */
export type CompletedWorkItem = {
  kind: 'completed-work';
  id: string;
  /** "Worked for 2m 5s". */
  label: string;
  /** The counts the summary bar shows beside the label; omitted when there are none. */
  stats?: WorkStat[];
  /** File change rows of the whole turn (same row shape as {@link ProjectedMessage.files}). */
  files: Json[];
  /** The file change card's header over `files` (`file_change_card` in the core). */
  filesCard?: Json;
  /** "N files changed" in verbose mode. */
  filesLabel: string;
  /** The same count in simple mode wording. */
  simpleFilesLabel: string;
  /** Whether the fold can open at all. */
  expandable: boolean;
  /** Present when the turn's work rows are not in the document and must be read on demand:
   * dispatch `{type: 'loadWork', id, work: deferred}`. Its load state is `document.deferredWork[id]`. */
  deferred?: Json;
  work: ProjectedMessage[];
  /** Answered question cards, hoisted out of the fold so they stay visible. */
  questions: Json[];
  /** Cards for the messages the turn's work sent other agents, hoisted out of the fold (same
   * shape as {@link ProjectedMessage.sentMessages}); omitted when there are none. */
  sentMessages?: Json[];
  /** The folded rows' Workflow call ids, whose cards (`document.workflowCards`) are drawn outside
   * the fold; omitted when there are none. */
  workflows?: Json[];
  /** Rows that stay outside the fold (images and similar artifacts). */
  artifacts: ProjectedMessage[];
  /** The turn's reply; omitted (not null) when the turn has none. */
  final?: ProjectedMessage;
};

/** A kind this build does not know, kept verbatim so one new row cannot drop the list. Draw
 * nothing for it. */
export type UnknownItem = { kind: string } & JsonObject;

/**
 * A projected message: the wire message plus everything the renderer needs to draw it without
 * re-parsing markdown. Free-form in Rust; the producer is
 * `packages/gx-chat-core/src/transcript/presentation.rs`. The keys desktop reads are typed below;
 * the rest ride along in the index signature.
 *
 * A row with `pending: true` is a placeholder that the core fills in a following frame (the
 * backfill); draw it as a skeleton of its role.
 */
export type ProjectedMessage = {
  /** The transcript row id. Also the key every per-message action carries (`messageId`). */
  id: string;
  /** `user`, `assistant`, `reasoning`, `tool`, `system`. */
  role: string;
  /** Raw content blocks from the wire (`ChatBlock`), for anything not projected below. */
  blocks?: Json[];
  /** Epoch ms, or null. */
  timestamp?: number | null;
  /** `transcript`, `hook`, or `client` (an optimistic echo of this device's send). */
  source?: string;
  turnId?: string;
  /** A prompt sitting in the agent CLI's own queue, not handed to the model yet. */
  queued?: boolean;
  /** A client echo of an accepted send still waiting for the terminal: `{promptId, state:
   * 'queued' | 'sending' | 'reconnecting' | 'failed', errorMessage?}`. Desktop: `startup_delivery.rs`. */
  startupDelivery?: { promptId: string; state: string; errorMessage?: string };
  /** Markdown body with the native marks (code block headers, alerts, typed file paths).
   * Desktop: `rich_markdown.rs`, `markdown_style.rs`, `code_block.rs`. */
  text?: string;
  /** What Copy copies. Desktop: `message_actions.rs`. */
  copyText?: string;
  /** Whether Rewind is offered on this row. Desktop: `message_actions.rs`, `rewind.rs`. */
  canRewind?: boolean;
  /** Text the per-message actions (save prompt, copy) act on. */
  actionContent?: string;
  /** The row's time label. Desktop: `transcript.rs`. */
  time?: Json;
  /** Links and file references inside `text`, with their ranges. Desktop: `markdown_links.rs`. */
  markdownReferences?: Json;
  /** A long prompt's first lines, shown with Show more until it is expanded; null when the
   * prompt is short. Core: `long_prompt.rs`. Desktop: `transcript.rs` `prompt_body`. */
  collapsedText?: string | null;
  /** `markdownReferences` for `collapsedText`. */
  collapsedReferences?: Json;
  /** A reasoning row split into headline and body. Desktop: `thinking.rs`. */
  reasoning?: Json;
  /** A message from another agent, with its display name. Desktop: `inter_agent_message.rs`. */
  agentMessage?: Json;
  /** A user row that is really an inter-agent handoff. Desktop: `inter_agent_message.rs`. */
  interAgentMessage?: Json;
  /** Question / answer exchanges on this row. Desktop: `question_exchange.rs`. */
  questions?: Json;
  /** Messages this row's tool calls sent other agents: `{key, title, detail, body, markdown,
   * markdownReferences, failed}`. Desktop: `inter_agent_message.rs`. */
  sentMessages?: Json;
  /** The Workflow calls this row made, by call id; each one's card is `document.workflowCards[id]`.
   * Desktop: `workflow_card.rs`. */
  workflows?: Json;
  /** Image sources on the row (machine paths). Load bytes with `{type: 'loadImage', path}`.
   * Desktop: `images.rs`. */
  images?: Json[];
  /** How a suppressed row is presented, or null. */
  suppressed?: Json;
  /** A `/btw` side question kept in the transcript: `{question, answer, answerMarkdown, answerReferences}`. */
  sideQuestion?: Json;
  /** A system card (compaction, errors, agent messages...), or null. Desktop: `system_cards.rs`. */
  systemCard?: Json;
  /** A failed API call the agent recorded: `{kind, title, detail, icon}`, or null. Desktop: `api_error_card.rs`. */
  apiError?: Json;
  /** File change rows. Desktop: `file_change_card.rs`, `file_change_rows` in the core. */
  files?: Json[];
  /** The file change card's header over `files` (`file_change_card` in the core). */
  fileCard?: Json;
  /** "Edited N files" in simple mode. */
  simpleFileLabel?: string;
  /** "N tool calls" in simple mode. */
  simpleToolLabel?: string;
  /** Tool call rows: `{name, label, glyph, preview, failed, status: 'done' | 'failed' | 'running',
   * failure, duration, description, hasCall, hasDetail, exchange, sentMessage, subagent}`; `failure`
   * is what a failed call reported, `duration` how long it ran ("14.3s"), `description` the line
   * the agent gave the call and `label` what the row reads (that description in every mode, else
   * `name`), each empty when unknown.
   * Desktop: `tool_run.rs`, `terminal_tool_row.rs`. */
  tools?: Json[];
  /** How the tool rows fold. Desktop: `tool_run.rs`. */
  toolFold?: Json;
  /** Whether every tool row shows without a "show more". */
  toolsShowAllRows?: boolean;
  /** Inside a turn fold: the text owns none of its calls, which follow it at the same level. */
  toolsFlat?: boolean;
  /** A running summary turn's newest row: its tool calls start open (gx-chat-core `summary_mode_turns` in `transcript/turns.rs`). */
  toolsOpen?: boolean;
  /** A thought of the running turn, drawn as one closed line (gx-chat-core `transcript/thinking_card.rs`):
   * `live` while it is the row being written, `preview` its newest finished line. */
  thinkingCard?: { live: boolean; preview: string };
  /** A thought's one line and whether opening it shows more (gx-chat-core `thinking_row`). */
  thinkingRow?: {
    preview: string;
    expandable: boolean;
    /** "Thought for 12s" (gx-chat-core thinking_card.rs, 2026-10-28). */
    label?: string;
    startedAt?: number | null;
    /** Claude Code's live ladder: `[fromMs, label]`. */
    liveLabels?: [number, string][];
  };
  /** The live terminal tool row synthesized from the agent's screen. Desktop: `terminal_tool_row.rs`. */
  terminalTool?: Json;
  /** A `!` command the user ran, drawn as its tool card in the user's place. Desktop: `shell_command_card` in `tool_run.rs`. */
  shellCommand?: boolean;
  /** That card's header and output (gx-chat-core's `shell_card`): `{command, fullCommand, commandBody,
   * running, status, failed, stdout, stderr, hasBody, openByDefault}`, or null. */
  shellCard?: Json;
  /** A placeholder row the backfill has not projected yet. */
  pending?: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

/**
 * Everything the chat screen draws, in one value (`Document` in `document/snapshot.rs`).
 * Unknown keys are carried through (`extra` in Rust), hence the index signature.
 */
export type ChatDocument = {
  // ---- transcript state -------------------------------------------------------------------

  /** Which transcript picture to draw. Desktop: `new_session_welcome.rs`, `transcript_reveal.rs`. */
  view: ViewState;
  /** `loading`, `ready`, `working`, `error`, `notFound`, `starting`. Desktop: `launch.rs`,
   * `transcript_reveal.rs`, `composer.rs`. */
  status: string;
  /** The live turn's lifecycle `{state, turnId, timestamp}`, or null. Not drawn directly. */
  lifecycle: Json;
  /** The agent's blocking question or approval request, or null. Drawn through `questionCard`.
   * Desktop: `question.rs`, `approval.rs`, `keyboard.rs`. */
  prompt: Json;
  /** Async question ids already retired on the daemon. Not drawn. */
  retiredAsyncQuestionIds?: string[];
  /** The turn is live (the Stop button, the working strip). Desktop: `send_control.rs`. */
  working: boolean;
  /** Whether the transcript keeps the newest turn open. Consumed by the core's projection. */
  transcriptWorking: boolean;
  /** The session activity gxserver presents (the same source as the sidebar spinner). */
  sessionWorking: boolean;
  /** Model and effort read off the agent's own terminal. Feeds `optionLabels`. */
  selectedOptions: Json;
  /** The blocking or failed terminal state with its choices. Desktop: `notice.rs`,
   * `terminal_dialog.rs`. */
  terminalNotice: Json;
  /** The prompt the agent handed back after an Escape, or null. Handled through effects. */
  returnedPrompt: Json;
  /** Live on-screen progress such as compaction. Drawn through `workingStrip`. */
  terminalActivity: Json;
  /** Subagents the agent is running. Drawn through `agentFleetStrip`. */
  agentFleet: Json;
  /** The agent's task list. Drawn through `agentTasksPanel`. */
  agentTasks: Json;
  /** Latched once gxserver has read this session's screen. */
  screenProbed: boolean;
  /** Transcript agent family (`claude`, `codex`, ...), or null. */
  agent: string | null;
  agentSessionId: string | null;
  /** A draft session's agent choices, or null. */
  availableAgents: Json;
  /** Same-family accounts the session can resume under. Desktop: `actions.rs` (Switch Account). */
  switchableAgents: Json;
  /** A draft's Run on row, absent when hidden. Desktop: `run_location.rs`. */
  runLocation?: RunLocationRow;
  /** The session's own launch agent id. Desktop: `launch.rs`. */
  sessionAgentId: string | null;
  /** The transcript-level failure copy, or null. */
  error: string | null;
  /** Whether older history exists above the first row. Desktop: `pagination.rs`. */
  hasMore: boolean;
  /** Byte cursor after the most recently accepted history window. */
  earlierPageCursor: number;
  /** A "Load earlier" read is in flight. Desktop: `pagination.rs`. */
  loadingEarlier: boolean;
  /** Ids of turns whose reply is final (per-message actions show only there).
   * Desktop: `message_actions.rs`. */
  finalIds: string[];
  /** Pages published with `ghostex show` whose answers arrived (gx-chat-core `page_answers.rs`). */
  answeredPages?: string[];
  /** Question pages not answered whose questions were withdrawn, some or all, by page id
   * (gx-chat-core `open_questions.rs` `withdrawn_pages`). */
  withdrawnPages?: { [pageId: string]: { tags: string[]; total: number } };
  /** The question forms (```questions blocks) by id (`questions/forms.rs`). */
  questionForms?: { [id: string]: Json };
  /** The Previous question pill and the jumps to a question (`questions/open_questions.rs`).
   * Desktop: `open_questions.rs`. */
  openQuestions?: OpenQuestionsState;
  /** Per completed-work row id: its on-demand read is loading, or failed with a retry.
   * Desktop: `deferred_work.rs`. */
  deferredWork: { [itemId: string]: DeferredWorkRow };
  /** Claude Code workflow runs drawn as cards, by Workflow call id (gx-chat-core
   * `transcript/workflow_card.rs`); a tool row's `workflow` names its card. Omitted when none. */
  workflowCards?: { [callId: string]: Json };

  // ---- composer ---------------------------------------------------------------------------

  /** Ghostex's own prompt queue above the composer. Desktop: `queue.rs`, `send_control.rs`. */
  queue: Queue;
  /**
   * The messages the agent itself queued that Back to composer is offered on, oldest first.
   * Desktop: `message_actions.rs`; the core's `composer/queue_take_back.rs`.
   */
  queueTakeBackIds: string[];
  /** The message a Back to composer is taking back right now, or null. */
  queueTakeBackBusy: string | null;
  /** The desktop composer's key for Back to composer, which its tooltip names. */
  queueTakeBackHotkey: string;
  /** The cross-client composer draft. Desktop: `composer.rs` (incoming draft bar). */
  draft: DraftState;
  /** Placeholder text for the composer field. Desktop: `state.rs` (`ensure_input`). */
  composerPlaceholder: string;
  /** The composer's how-to, the field's hint since the placeholder became one line (CP5). */
  composerHint?: string;
  /** Why sending is blocked, or null. Send shows the `sendBlockedToast` query's text instead.
   * Desktop: `composer.rs`, `send_control.rs`. */
  sendBlockedReason: string | null;
  /** Whether the composer may collapse while the transcript scrolls. Desktop: `composer_scroll.rs`. */
  composerCollapseEligible: boolean;
  composerCollapsed: boolean;
  /** Which toolbar controls did not fit (fold them into More actions). Desktop: `toolbar.rs`. */
  composerOverflow: ComposerOverflow;
  /** Which composer controls this host can serve. Desktop: `toolbar.rs`. */
  composerActions: ComposerActions;
  /** The note dot, stash badge and pressed states. Desktop: `composer.rs`. */
  composerChrome: ComposerChrome;
  /** The slash command Send would complete to, or null (Send then dispatches
   * `completeComposerCommand` instead of sending). Desktop: `composer.rs`. */
  composerCommand: string | null;
  /** The `@` / `$` / `/` suggestion popup, or null when closed. Desktop: `suggestions/render.rs`,
   * `suggestions/window.rs`. */
  suggestions: Json;
  /** Up/Down currently walk the sent-prompt history. Desktop: `keyboard.rs`. */
  historyActive: boolean;
  /** Attachments still uploading (the send button spins). Desktop: `attachment_previews.rs`. */
  pendingAttachments: number;
  /** A draft handed to this chat from elsewhere, offered before it replaces the text.
   * Actions: `useIncomingDraft`, `dismissIncomingDraft`. Desktop: `composer.rs`. */
  incomingDraft: IncomingDraft | null;
  /** The session note sheet. Desktop: `note.rs`. */
  note: NoteState;
  /** The Catch me up button and card (`composer/catch_up.rs`). Desktop: `catch_up.rs`. */
  catchUp?: CatchUpState;
  filesLinks?: FilesLinksState;
  /** Timings both renderers share. Desktop: `send_control.rs`. */
  interaction: Interaction;
  /** The toast drawn in the Scroll to bottom pill's place: `notice` while a first Escape waits,
   * `error` (red) for "Agent was interrupted". Absent otherwise. Desktop: `scroll_bottom.rs`. */
  interruptToast?: { text: string; tone: 'notice' | 'error' } | null;
  /** The More actions menu's host rows. Desktop: `actions.rs`. */
  hostActions: HostActionRow[];
  /** The Side chat prefix (`/btw `) when the agent takes side questions, else null (`side_chat.rs`). */
  sideChat?: string | null;
  /** More actions > Skills: the Ghostex skills the agent has installed (core `ghostex_skills.rs`). */
  ghostexSkills?: GhostexSkill[];

  // ---- questions and notices --------------------------------------------------------------

  /** The blocking question card. Desktop: `question.rs`, `approval.rs`. */
  questionCard: QuestionCard;
  /** The async question strip a working agent shows. Desktop: `async_questions.rs`. */
  asyncQuestions: AsyncQuestions;
  /** Whether the terminal notice card shows. Desktop: `notice.rs`. */
  noticeVisible: boolean;
  noticeError?: string | null;
  /** The last refused operation's message. Desktop: `composer_not_ready.rs`, `composer.rs`. */
  operationError?: string | null;
  /** The refusal's code, so the composer can draw its not-ready card instead of an error line. */
  operationErrorCode: string | null;

  // ---- options, model picker, accounts ----------------------------------------------------

  /** The pill labels under the composer. Desktop: `option_pills.rs`, `toolbar.rs`. */
  optionLabels: Json;
  /** The menus behind those pills. Desktop: `option_menu/window.rs`, `option_pills.rs`. */
  optionMenus: Json;
  /** The session's option state and catalog. Not drawn directly. */
  sessionOptions: Json;
  /** The model menu's inputs. Not drawn directly. */
  modelMenuContext: Json;
  /** The projected model menu, or null when closed. Desktop: `option_menu/model_menu/`. */
  modelMenu: Json;
  /** Provider the model pills belong to; absent before the agent is known. */
  modelProvider?: string | null;
  /** The queued model selection and its outbox. Not drawn directly. */
  modelSelection: Json;
  /** The option dispatch in flight, or null. */
  optionDispatchId: string | null;
  /** The accounts read; absent until it answers. Desktop: `option_menu/accounts.rs`. */
  accounts?: Json;
  accountError?: string | null;
  /** The account switch's progress. */
  accountStatus: AccountStatus;
  /** The accounts panel (Switch Account), or null. Desktop: `option_menu/window.rs`, `notice.rs`. */
  accountPanel: Json;
  /** The account switch card, or null. Desktop: `account_switch_card.rs`. */
  accountSwitchCard: Json;
  /** The open API error card with gxserver's retry (`{messageId, kind, icon, tone, title, detail, status, actions}`), or null. Desktop: `api_error_card.rs`. */
  apiErrorCard?: Json;
  /** Handover heading color strength, 0 to 99 percent; absent at full colour
   * (gx-chat-core `transcript/marked_sections.rs` `heading_strength`). */
  markedHeadingStrength?: number;
  /** The switch gxserver reports, or null. */
  accountSwitch: Json;
  /** A model selection waiting on the agent. */
  pendingModelSelection?: Json;

  // ---- context ----------------------------------------------------------------------------

  /** The context meter under the composer, or null. Desktop: `context_meter.rs`. */
  contextMeter: Json;
  /** The context rows editor, or null when closed. Desktop: `context_editor/`. */
  contextEditor: Json;

  // ---- panels and extras ------------------------------------------------------------------

  /** The working word and live activity the working card reads them from (`workingCard`). */
  workingStrip: WorkingStrip;
  /** The agent terminal's last lines. Desktop: `terminal_ready.rs`, `composer_not_ready.rs`. */
  terminalTail: TerminalTail;
  /** The agent fleet strip, or null. Desktop: `agent_fleet.rs`. */
  agentFleetStrip: Json;
  /** The task panel, or null. Desktop: `agent_tasks.rs`. */
  agentTasksPanel: Json;
  /** A coordinator's Threads panel, or null. Desktop: `coordinator_threads.rs`. */
  coordinatorThreadsPanel: Json;
  /** The background tasks the agent left running, or null; the Background pill's sheet. Desktop: `background_tasks.rs`. */
  backgroundTasksPanel: Json;
  /** The working card's pills, each opening the menu of one of the panels above. Desktop: `chat_pills.rs`. */
  chatPills: ChatPill[];
  /** The working card right above the composer. Desktop: `working_card.rs`. */
  workingCard?: WorkingCard;
  /** The subagent viewer header state, or null when closed (its rows come in `subagentSplice`).
   * Desktop: `subagent_view.rs`. */
  subagent: Json;
  /** Transcript search, or null when closed. Desktop: `search.rs`. */
  transcriptSearch: Json;
  /** The fork branch picker, or null. Desktop: `fork_branches.rs`. */
  forkBranches: Json;
  /** The Save to Markdown sheet, or null. Desktop: `save_markdown/`. */
  saveMarkdown: Json;
  /** The rewind confirmation, or null. Desktop: `rewind.rs`. */
  rewind: Json;
  /** Whether this host can rewind at all. Desktop: `message_actions.rs`. */
  rewindAvailable: boolean;
  /** Whether rewinding is allowed right now. */
  rewindEnabled: boolean;
  /** Message ids that already have a saved prompt. Desktop: `message_actions.rs`. */
  savedPrompts: { [messageId: string]: Json };
  /** Read aloud's controls (core `read_aloud/document.rs`): the reply row and the ⋯ menu rows. */
  readAloud?: ReadAloudState;

  // ---- modes and loading ------------------------------------------------------------------

  /** One row per turn. Desktop: `toolbar.rs`. */
  summaryMode: boolean;
  /** The user's verbose override, or null to follow the setting. Desktop: `appearance.rs`. */
  verboseOverride: boolean | null;
  /** Headline and detail of an empty transcript. Desktop: `new_session_welcome.rs`. */
  emptyState: EmptyState;
  /** The greeting a brand new session shows, or null. Desktop: `new_session_welcome.rs`. */
  newSessionWelcome: NewSessionWelcome | null;
  /** `blank`, `indicator` or `retry` while loading; null otherwise. Desktop: `transcript_reveal.rs`. */
  loadingStage: string | null;
  /** What the loading hold says once a read runs long, above its Try now button; null while it
   * stays blank. Desktop: `transcript_reveal.rs`. */
  loadingNotice?: LoadingNotice | null;
  /** The loading hold draws the skeleton rows: Ghostex is not answering and the core is retrying.
   * Desktop: `transcript_reveal.rs`. */
  transcriptSkeleton?: boolean;
  skillsLoading: boolean;
  filesLoading: boolean;
  /** A preview's own display settings; absent on a real session. */
  previewSettings?: JsonObject;

  [key: string]: unknown;
};

/** The document's `readAloud` key. */
export type ReadAloudState = {
  /** Draw the controls at all: the computer has Read aloud on and the phone has a voice. */
  available: boolean;
  /** The ⋯ menu's Auto-read row is checked. */
  autoRead: boolean;
  /** Something of this chat is being read: the ⋯ menu shows Stop reading. */
  speaking: boolean;
  /** The reply being read, whose row reads Stop reading. */
  speakingId: string | null;
  /** Why Auto-read is quiet for now, or null. */
  autoReadHeld: 'voiceConversation' | 'dictation' | null;
};

export type ViewState = {
  /** `ready`, `empty`, `loading`, `starting`, `notFound`, `error`. */
  kind: string;
  isWorking?: boolean | null;
  error?: string | null;
};

export type EmptyState = { title: string; detail: string; action?: string };

export type LoadingNotice = { title: string; detail: string; action: string };

export type NewSessionWelcome = {
  /** The agent's display name, or null when unknown. */
  agentName: string | null;
  /** The agent mark, or null. */
  icon: string | null;
  /** False once a notice or question card takes the space below the mark. */
  showTitle: boolean;
  title: string;
};

export type DeferredWorkRow = { loading: boolean; error?: string | null };

export type Queue = {
  capabilities: QueueCapabilities;
  /** Authoritative order, head first. */
  prompts: QueuedPrompt[];
};

/** `supported` stays false until a read carries a queue; hide every queue control until then. */
export type QueueCapabilities = {
  supported: boolean;
  canQueue: boolean;
  canEdit: boolean;
  canRemove: boolean;
  canReorder: boolean;
  canRetry: boolean;
  canSendNow: boolean;
  canSyncDraft: boolean;
};

export type QueuedPrompt = {
  id: string;
  /** A normal send held during startup: drawn in the transcript, not above the composer. */
  startupSend?: boolean | null;
  text: string;
  /** `queued`, `sending`, `failed`. */
  state: string;
  /** Why the delivery failed, only when `state` is `failed`. */
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  /** The one line the row shows. */
  preview: string;
  /** The row's controls are held while it is mid-flight. */
  busy: boolean;
  [key: string]: unknown;
};

export type DraftState = {
  /** This client's opaque id. */
  clientId: string;
  /** False means local-only drafts. */
  canSync: boolean;
  /** The latest draft gxserver reported from any device, or null. */
  synced: Json;
};

export type ComposerOverflow = { overflowed: string[]; optionsOverflowed: boolean };

export type ComposerActions = {
  summary: boolean;
  note: boolean;
  stash: boolean;
  attach: boolean;
  terminal: boolean;
  /** Files and links: the session has a conversation to list. Absent from an older core. */
  files?: boolean;
};

export type ComposerChrome = {
  notePresence: boolean;
  notePressed: boolean;
  /** The stash button's count as TEXT (`"1"`..`"9"`), or null when nothing is stashed. */
  stashBadge: string | null;
  summaryPressed: boolean;
};

export type NoteState = { open: boolean; value: string; saved: string; edited: boolean; loading: boolean };

/** `enabled` shows the composer's button; `markdown` has its marked sections tagged like a reply's. */
export type CatchUpState = {
  enabled: boolean;
  /** The composer shows the button: `enabled` and the chat box is empty. */
  button: boolean;
  open: boolean;
  loading: boolean;
  markdown: string;
  references: Json[];
  copyText: string;
  error: string | null;
  caption: string | null;
};

/** One Files and links row (core `composer/files_links.rs`). `icon` is photo, file, folder or link; `open` is the
 * action a tap runs, unless `image` is a picture the viewer can show; `jumps` are `{label, tooltip, command}`. */
export type FilesLinksRow = {
  key: string;
  label: string;
  detail: string;
  icon: string;
  tag: string | null;
  meta: string;
  open: Json;
  image: Json | null;
  jumps: { label: string; tooltip: string; command: Json }[];
  /** The file's or folder's path, for Copy Path; absent for a web link. */
  path?: string;
};

export type FilesLinksGroup = { key: string; title: string; rows: FilesLinksRow[] };

export type FilesLinksSection = {
  id: string;
  label: string;
  count: number;
  groups: FilesLinksGroup[];
  moreLabel: string;
};

/** The Files and links card: every attachment, file and link the session (and a coordinator's threads) mentioned. */
export type OpenQuestionsState = {
  /** Unanswered forms and question pages; the pill shows while this is above zero. */
  count: number;
  /** The pill's text: "❓ 2 · Previous question ↑". */
  text: string;
  accessibilityLabel: string;
  /**
   * The newest unanswered form's or page's id, or null when none waits. A change without `count`
   * dropping means a new question arrived, which pings the pill (`ChatPills.tsx`).
   */
  newest?: string | null;
  /**
   * Scroll to `item` once per `revision`, then highlight `target` (a form's or page's id);
   * `question` is the tag a Q-tag link named, the form question the jump lands on.
   */
  jump: { revision: number; item: number; target: string; question?: string | null } | null;
};

export type FilesLinksState = {
  enabled: boolean;
  open: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  /** The list is long enough for the filter box. */
  filter: boolean;
  sections: FilesLinksSection[];
  caption: string;
  emptyLabel: string;
  /** Where the transcript scrolls, once per `revision`. */
  jump: { item: number; revision: number } | null;
};

export type Interaction = { queueLongPressMs: number; stopButtonCooldownMs: number };

export type IncomingDraft = { content: string; version?: Json; [key: string]: unknown };

/** One More actions row. `group` is `agent` or `session`. Pressing it is an app-shell action. */
export type HostActionRow = {
  id: string;
  label: string;
  hotkey?: string | null;
  group: string;
  [key: string]: unknown;
};

/** One row of More actions > Skills (core `composer/ghostex_skills.rs`). */
export type GhostexSkill = { name: string; description?: string | null; invocation?: string | null };

export type QuestionCard = {
  visible: boolean;
  /** Which question of the set the card shows. */
  questionIndex: number;
  controls: { hasAnswer: boolean; disabled: boolean; label: string };
  drafts: QuestionDraft[];
  answering: boolean;
  busy: boolean;
  loading: boolean;
  /** An approval card's question, worded for its tool ("Allow this edit?"); empty for a question. */
  approvalAsk?: string;
  /** An approval card's title in plain words ("Claude Code wants to run a command"). */
  approvalTitle?: string;
  /** The muted line under it: the tool, and the folder it runs in when known. */
  approvalDetail?: string;
  /** The answer went out while gxserver was away and goes again once it is back. */
  reconnecting?: boolean;
};

export type QuestionDraft = { indices: number[]; other: string };

export type AsyncQuestions = {
  /** The question showing; absent when nothing is pending. */
  question?: { title: string; options?: string[]; key: string };
  draft: QuestionDraft;
  index: number;
  count: number;
  answer: string;
  disabled: boolean;
  canSend: boolean;
  working: boolean;
  collapsed: boolean;
  submitting: boolean;
  loading: boolean;
  error: string;
  previousDisabled: boolean;
  nextDisabled: boolean;
  selected: number[];
  previousKey?: string;
  nextKey?: string;
};

export type AccountStatus = {
  /** The card to draw, or null. */
  visible: Json;
  /** The clock the card's relative times are measured against. */
  now: number;
  /** A switch is in flight, so sending is held. */
  busy: boolean;
  [key: string]: unknown;
};

/** One pill on the working card (gx-chat-core `extras/chat_pills.rs`): one panel, whose rows its menu shows. */
export type ChatPill = {
  /** `threads`, `tasks`, `subagents` or `background`: which panel the card's section draws. */
  id: string;
  label: string;
  /** The number after the label ("3", "4/9"), or "" for none. */
  count: string;
  /** Something in the sheet needs the user (a thread waiting on an approval): an amber dot. */
  attention: boolean;
  /** A subagent or thread in the sheet is working: the ? pill's amber corner dot, pulsing. */
  running: boolean;
  /** The panel's muted detail ("2 working · 212 threads"). */
  meta: string;
  ariaLabel: string;
};

/** The working card right above the composer (gx-chat-core `extras/working_card.rs`). It never opens. */
export type WorkingCard = {
  /** The row above the composer shows the card. */
  visible: boolean;
  phase: 'working' | 'worked' | 'idle';
  /** The spark turns. */
  working: boolean;
  /** One line: the running tool's, a live activity's, the working word or "Worked for 2m 13s"; null with pills only. */
  label: string | null;
  labelKind: 'tool' | 'activity' | 'word' | 'worked' | null;
  /** A live activity's clock and progress: `elapsedLabel`, `tokens`, `percent`, `indeterminate`, `hint`. */
  activity: Json;
  /** The pill ids (`chatPills`) on the card, in order. */
  pills: string[];
  ariaLabel: string;
};

export type WorkingStrip = {
  /** The working word plus its clock, or null when idle. */
  label: string | null;
  activity: Json;
  presentation: Json;
  [key: string]: unknown;
};

export type TerminalTail = {
  readiness: string | null;
  /** The single line the composer shows. */
  preview: string;
  reason: string | null;
  notice: {
    open: boolean;
    loading: boolean;
    error: string | null;
    excerpt: string;
    /** Why the sheet is empty, as a sentence, or null. */
    empty: string | null;
  };
};
