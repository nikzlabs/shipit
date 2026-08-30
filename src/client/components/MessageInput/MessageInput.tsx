// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { useNarrowContainer } from "../../hooks/useNarrowContainer.js";
import { PlusIcon, StopIcon, ArrowUpIcon, GitBranchIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { usePrStore } from "../../stores/pr-store.js";
import {
  PermissionModeSelector,
  type NetworkSectionProps,
} from "../PermissionModeSelector.js";
import { HarnessSelector, ModelSelector } from "../ModelPicker.js";
import { ReasoningSelector } from "../ReasoningSelector.js";
import { FileAutoComplete } from "../FileAutoComplete.js";
import { SkillAutoComplete, type SlashCommand } from "../SkillAutoComplete.js";
import { FileAttachmentChips } from "../FileAttachmentChips.js";
import { FileUploadChips } from "../FileUploadChips.js";
import { Popover, PopoverAnchor } from "../ui/popover.js";
import { WithTooltip } from "../ui/tooltip.js";
import { MicButton } from "../MicButton.js";
import { MobileRecordingOverlay } from "../MobileRecordingOverlay.js";
import { useVoiceInput } from "../../voice/use-voice-input.js";
import { spliceTranscript } from "../../voice/insert-transcript.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useKeybinding } from "../../keybindings/use-keybinding.js";
import { ContextDialMount } from "./ContextDialMount.js";
import { ComposerSettingsMenu } from "./ComposerSettingsMenu.js";
import { RoleSelector, useRolePickerState } from "./RoleSelector.js";
import { getSavedRoleName } from "../../utils/local-storage.js";
import { applyRoleSeeds } from "../../utils/role-seed.js";
import { useTextareaSizing } from "./hooks/useTextareaSizing.js";
import { useMessageDraft } from "./hooks/useMessageDraft.js";
import { useUploadBackend } from "./hooks/useUploadBackend.js";
import type { PermissionMode, FileContextRef, FileTreeNode, AgentId, SkillInfo, UploadRef } from "../../../server/shared/types.js";
import type { UploadItem } from "../../hooks/useFileUpload.js";
import type { AgentOption, ModelChoice } from "../../agent-types.js";
import type { ModelInfo } from "../../utils/model-info.js";

/**
 * docs/260-composer-toolbar-layout req 3 — below this many px of the COMPOSER's own width the toolbar
 * collapses to `+ · settings · ring ⟶ mic · stop · send`. At or above it the row
 * is exactly what shipped before. Deliberately a composer width and not a
 * viewport one: the chat panel is a draggable split, so a wide window with a
 * narrow panel needs the compact row and a media query cannot tell.
 */
const COMPOSER_NARROW_PX = 700;

/** Render a hotkey string like "ctrl+shift+space" as "Ctrl+Shift+Space" for tooltips. */
function formatHotkeyLabel(hotkey: string): string {
  return hotkey
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === "mod" ? "Cmd/Ctrl" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}

/**
 * Payload handed to `onSend`. Carries everything the parent needs to dispatch
 * the prompt — the typed text, plus the upload state at submission time. The
 * payload shape is the same regardless of `sessionId` presence: in session
 * mode (`sessionId` set), `uploadRefs` carries already-POSTed `/uploads/...`
 * paths and `deferredFiles` is empty; in session-less mode (no `sessionId`,
 * e.g. the quick-capture overlay), uploads weren't sent anywhere yet and the
 * raw `File[]` lives in `deferredFiles` for the parent to multipart-POST.
 *
 * Both parents see the same contract — the upload backend swap is internal to
 * MessageInput. See `docs/145-quick-capture-overlay/plan.md` for why the
 * sessionless case exists.
 */
export interface SendPayload {
  text: string;
  uploadRefs: UploadRef[];
  /** Full upload items at send time — used by chat for optimistic image/file display. */
  uploads: UploadItem[];
  /** Raw File objects for session-less callers that POST multipart themselves. */
  deferredFiles: File[];
  /**
   * docs/218 — per-send intent for the "start from the latest base" control.
   * Only set when the control was visible at send time: `false` = the user
   * unticked it (skip the reset this turn), `true` = leave it on. Undefined when
   * the control wasn't shown (no eligible reset) — the server follows the global
   * setting. Non-sticky.
   */
  resetMergedBranch?: boolean;
  /**
   * docs/144 — some or all of `text` was dictated by voice rather than typed.
   * Forwarded to the server, which adds a `<dictated_input>` note to the prompt
   * so the agent reads mis-heard terms and absent punctuation as transcription
   * artifacts instead of intent. Absent when nothing was dictated.
   */
  dictated?: boolean;
}

export function MessageInput({
  onSend,
  disabled,
  disabledReason,
  isLoading = false,
  onInterrupt,
  permissionMode = "auto",
  onPermissionModeChange,
  pendingFiles = [],
  onRemoveFile,
  onAddFile,
  fileTree = [],
  skills = [],
  sessionId,
  agents = [],
  activeAgentId = "claude",
  onAgentChange,
  onModelChange,
  onReasoningChange,
  sessionReasoning,
  sessionRoleName,
  onRoleChange,
  roleLocked = false,
  modelInfo,
  contextTokens = 0,
  hasActiveSession = false,
  onOpenUsageDetails,
  focusKey,
  liveSteeringActive = false,
  surface = "chat",
  network,
}: {
  onSend: (payload: SendPayload) => void;
  disabled: boolean;
  /**
   * docs/257 req 3 — when set, the composer is dead **as a whole** and this
   * string is why, shown as the textarea's placeholder.
   *
   * Distinct from `disabled`, which only guards submission: with `disabled` the
   * user can still type, attach files and dictate, and discovers the rule when
   * Send does nothing. That is the "block at submit" failure req 3's receipt
   * rejected. `disabledReason` instead disables the textarea, the attach button,
   * paste/drag-drop ingestion, the mic and the permission selector — and renders
   * the textarea EMPTY, so a retained draft or a prefill cannot hide the
   * explanation behind text that cannot be sent. The draft itself is kept in the
   * store and comes back when the input is live again.
   */
  disabledReason?: string;
  isLoading?: boolean;
  onInterrupt?: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  pendingFiles?: FileContextRef[];
  onRemoveFile?: (index: number) => void;
  onAddFile?: (filePath: string) => void;
  fileTree?: FileTreeNode[];
  /** User-invocable skills for `/` autocomplete (doc 138). */
  skills?: SkillInfo[];
  /**
   * The session this composer's uploads belong to. When set, the "+" button
   * and drop-zone POST through `useFileUpload(sessionId)` and chip state lives
   * in the global file-store (so the FileTree side panel sees them too). When
   * undefined (e.g. the quick-capture overlay), files are buffered as raw
   * `File[]` in component-local state and surfaced via `SendPayload.deferredFiles`
   * for the parent to multipart-POST alongside the prompt.
   */
  sessionId?: string;
  agents?: AgentOption[];
  activeAgentId?: AgentId;
  onAgentChange?: (agentId: AgentId) => void;
  onModelChange?: (selection: ModelChoice) => void;
  /** docs/217 — per-session reasoning effort change; `null` clears to default. */
  onReasoningChange?: (effort: string | null) => void;
  /** docs/217 — the active session's persisted reasoning effort, if any. */
  sessionReasoning?: string;
  /**
   * docs/272-user-selectable-roles reqs 5, 13 — the role currently IN FORCE, if any.
   *
   * The server's answer, never derived here: a session whose harness, model and
   * level happen to equal a role's is not that role, because selecting one also
   * puts its standing instructions in force and moving three controls does not.
   * When set, the three selectors it replaced come out of the row and this name
   * stands in their place.
   */
  sessionRoleName?: string;
  /**
   * docs/272 reqs 1, 18 — start this session on the named role, or take the role
   * off it with `undefined`. Absent ⇒ no role control at all.
   */
  onRoleChange?: (roleName: string | undefined) => void;
  /**
   * docs/272 req 4 — the session has taken its first turn, so no role applies any
   * more. The same fact that pins the harness, and shown the same way.
   */
  roleLocked?: boolean;
  modelInfo?: ModelInfo | null;
  contextTokens?: number;
  hasActiveSession?: boolean;
  /**
   * Click handler for the cost / usage entry point. The standalone cost pill
   * was removed when the cost surface was merged into the context dial — the
   * dial's popover now wires this to its "Total cost" row.
   */
  onOpenUsageDetails?: () => void;
  /** Changed value triggers textarea focus (e.g. session ID or route change). */
  focusKey?: string;
  /** When true, show both Stop and Send buttons simultaneously (live steering active). */
  liveSteeringActive?: boolean;
  surface?: "chat" | "overlay";
  /**
   * docs/285 — the session's network mode, rendered as the second section of the
   * permission-mode control (reqs 5, 6). Supplied by the caller rather than read
   * here, because the two surfaces get it from different places: the chat
   * composer from the server (through `useComposerNetworkMode`), Quick Capture
   * from a local draft it sends with the create request, since that session does
   * not exist yet.
   *
   * Omitted for a sandbox session, whose network access IS one of its capability
   * grants (docs/211, docs/279) — two controls over one session's egress.
   */
  network?: NetworkSectionProps & {
    /**
     * A write is in flight, or a failed one has not yet reverted. **Bars Send**:
     * without it, picking Contained and pressing Send at once lets the server
     * resolve the OLD value, see no mismatch, and run the first turn under the
     * wrong policy — requirement 3 lost to ordinary mutation ordering.
     */
     saving: boolean;
  };
}) {
  const isMobile = useIsMobile();
  // docs/260-composer-toolbar-layout req 2/3 — measured on the COMPOSER, not the window. The chat panel
  // is a draggable split, so a wide window with a narrow panel is exactly the
  // case a media query cannot see and the reported bug. `useNarrowContainer`
  // reports `false` until measured and where ResizeObserver is absent (jsdom),
  // so the first paint and every existing test get the wide row.
  const composerRef = useRef<HTMLDivElement>(null);
  const narrowComposer = useNarrowContainer(composerRef, COMPOSER_NARROW_PX);
  // docs/257 req 3 — "disabled as a whole". Every affordance below reads this
  // rather than `disabled`, which guards submission only.
  const inert = !!disabledReason;
  /**
   * docs/285 — the network-mode save barrier. Send waits for the write the user
   * just triggered, because a first turn dispatched before it lands resolves the
   * OLD mode server-side, finds no mismatch to reconcile, and runs under the
   * wrong policy.
   *
   * Deliberately narrow: it gates Send alone, never the composer as a whole, and
   * never the network control itself — the user must be able to correct a pick
   * (or undo one whose write failed) without waiting on anything.
   */
  const networkSaving = network?.saving ?? false;
  const [text, setText] = useState("");
  // ── docs/272-user-selectable-roles — the role control's three states ─────────────────────
  // 1. no roles configured → nothing at all, the row exactly as it is today (req 16)
  // 2. roles exist, none in force → today's three controls plus the bare mark
  // 3. a role in force → the role's name INSTEAD of the three controls (req 5)
  //
  // `roleParamsRevealed` is the fourth thing that can happen and is not a fourth
  // state: "Adjust parameters…" brings the three controls back beside the name
  // (req 15). The role stays in force until one of them actually moves, and the
  // reveal is deliberately local and unpersisted — it is a look, not a setting.
  // It is keyed by both the composer scope and the role name: switching role
  // folds the parameters away again, while switching sessions cannot carry an
  // expanded role into another session that happens to use the same role.
  // Keeping one entry per scope also restores the expanded state if the user
  // returns to that session while this composer remains mounted.
  const { roles, hasRoles } = useRolePickerState();
  const roleRevealScope = sessionId ?? focusKey ?? surface;
  const [revealedRoleByScope, setRevealedRoleByScope] = useState<Record<string, string>>({});
  // **Before a session is active there is no row to read the role from**, and
  // that is where this was reported broken: on `/{repo}/new` the composer sits
  // on a WARM session, `SessionManager.list()` filters `warm = 0`, so the
  // browser's session list has no row for it — the server applied the role and
  // its answer landed on nothing, leaving the control reading "None" forever.
  // Quick Capture has no session at all and reaches the same place.
  //
  // So before a session is active the seed IS the display, exactly as
  // `seedFromHistory` makes the seed the display for the harness, model and
  // reasoning pickers on this same route. Held in state as well as in
  // localStorage because React cannot subscribe to localStorage, and initialised
  // from it so a role chosen before a reload is still named after one.
  const [pendingRole, setPendingRole] = useState<string | undefined>(() => getSavedRoleName());
  // Once a session IS active its role is the SERVER's answer and nothing else.
  // The seed may name a role this session never took — it is chosen for the
  // *next* one — so falling back to it there would name a role the session is
  // not running, which is the one thing req 13 rules out.
  const roleInForce = hasActiveSession ? sessionRoleName : (sessionRoleName ?? pendingRole);
  /**
   * req 15, for the session-less composer: moving one of the three controls a
   * role set leaves the role here too.
   *
   * A bound session gets this from the server, which answers on the row and only
   * when something actually moved. With no session there is no server to ask, so
   * the local rule is the blunter one — any pick from those three menus drops the
   * pending role. It errs toward *not* naming a role, which is the safe
   * direction: the alternative is a composer claiming a role the session it
   * creates will not be started on.
   */
  const leavePendingRole = () => setPendingRole(undefined);
  const roleView = roles.find((r) => r.name === roleInForce);
  // The seed slots the three pickers DISPLAY have to hold the role's own
  // parameters, or the composer names a role beside a model that role will not
  // run — reported as "the model name is incorrect".
  //
  // Picking a role writes them (`handleRoleChange`), but a role can also arrive
  // from the slot on a page load, and then nothing has written them this
  // session: a seed left over from earlier work stays on screen under the
  // role's name. So they are reconciled here too. `applyRoleSeeds` reports
  // whether it moved anything, which is what keeps this from looping, and the
  // bump is needed because localStorage is not something React can subscribe to.
  const [, noteSeedWrite] = useState(0);
  // eslint-disable-next-line no-restricted-syntax -- reconciles an external store (localStorage) the pickers read during render; there is nothing else to subscribe to
  useEffect(() => {
    if (!roleInForce || hasActiveSession) return;
    if (applyRoleSeeds(roleView)) noteSeedWrite((n) => n + 1);
  }, [roleInForce, hasActiveSession, roleView]);
  // req 4, second half — **the lock takes the CHOICE of role, and nothing else.**
  //
  // Note what is NOT in this condition: `roleLocked`. It was, briefly, and that
  // was the second of two opposite mistakes. As first shipped a locked role had
  // no menu at all (a readout does not open) and "Adjust parameters…" lives
  // inside that menu, so a session started on a role lost its model and reasoning
  // controls at the first turn and never got them back — while an identical
  // hand-configured session kept both. Nothing server-side was refusing them; the
  // composer would not draw them. `|| roleLocked` un-caged that by showing the
  // three controls unconditionally, which grows the row a role exists to shorten,
  // at the first turn, without being asked (req 5).
  //
  // A cage is fixed by giving it a door, not by removing it: the LOCKED CONTROL
  // OPENS (see `RoleSelector`), and offers the parameters and no role. So the
  // reveal stays what it has always been — the user's own act — and req 5 holds
  // for the whole of a session's life rather than for its first turn.
  const roleParamsRevealed =
    !roleInForce || revealedRoleByScope[roleRevealScope] === roleInForce;
  const revealRoleParameters = () => {
    if (!roleInForce) return;
    setRevealedRoleByScope((current) => ({
      ...current,
      [roleRevealScope]: roleInForce,
    }));
  };
  const foldRoleParameters = () => {
    setRevealedRoleByScope((current) => {
      if (!(roleRevealScope in current)) return current;
      const next = { ...current };
      Reflect.deleteProperty(next, roleRevealScope);
      return next;
    });
  };
  const showRoleControl = !!onRoleChange && (hasRoles || !!roleInForce);
  const [isDragging, setIsDragging] = useState(false);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

  // ── docs/218 — "start from the latest base" control ───────────────────────
  // Shown only when the session is reset-eligible (server signal: merged +
  // branch untouched since the merge + clean tree) AND the global setting is on.
  // Checked by default; the per-send untick is non-sticky (re-checks each time
  // the control reappears). Correctness is server-side — the checkbox is intent.
  const autoResetMergedBranch = useSettingsStore((s) => s.autoResetMergedBranch);
  const resetEligible = usePrStore((s) => (sessionId ? s.resetEligibleBySession[sessionId] ?? false : false));
  const showResetControl = resetEligible && autoResetMergedBranch;
  const [resetChecked, setResetChecked] = useState(true);
  // eslint-disable-next-line no-restricted-syntax -- syncs local opt-out to the external (WS-driven) eligibility signal: re-check whenever the control reappears so the untick is non-sticky
  useEffect(() => {
    // Non-sticky: default back to checked whenever the control (re)appears.
    if (showResetControl) setResetChecked(true);
  }, [showResetControl]);

  // ── Upload backend ───────────────────────────────────────────────────────
  // Two modes share the same surface (chip rendering, +/drop-zone, submit
  // clear), split by `surface`. See `useUploadBackend` for the full rationale.
  const {
    isOverlay,
    localFiles,
    displayUploads,
    allUploads,
    handleAddFiles,
    handleRemoveUploadChip,
    handleRetryUploadChip,
    getUploadRefs,
    clearUploads,
  } = useUploadBackend({ surface, sessionId });

  // ── Voice dictation (docs/144) ───────────────────────────────────────────
  // Mode A wires into the chat MessageInput; Mode B into the overlay's. The
  // hook is mode-agnostic — it produces a cleaned transcript and we splice it
  // into `text`. There is no path from here to a send action: the textarea
  // always gets the words, the user always presses Send.
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const voiceHotkeyModeA = useKeybinding("voice-mode-a");
  const voiceHotkeyModeB = useKeybinding("voice-mode-b");
  const quickCaptureAutoMic = useUiStore((s) => s.quickCaptureAutoMic);

  const voice = useVoiceInput({
    // docs/257 req 3 — `!inert` is what actually turns dictation off. Hiding the
    // mic button is not enough: the hook registers GLOBAL push-to-talk keydown
    // listeners off `enabled`, so a hidden mic would still record on the hotkey
    // and splice the transcript into a draft that cannot be sent.
    enabled: voiceInputEnabled && !inert,
    hotkey: isOverlay ? voiceHotkeyModeB : voiceHotkeyModeA,
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,
    // Distinct ids so a session switch aborts a chat recording; the overlay
    // is its own short-lived surface and never "switches" underneath itself.
    sessionId: isOverlay ? "overlay" : sessionId,
  });
  // Destructured so the effects below can depend on the individual callbacks
  // rather than the whole `voice` object — both are `useCallback`s with stable
  // identities, so an effect keyed on them wires up exactly once.
  const { onTranscript, cancelRecording } = voice;

  // docs/144 — whether the draft currently in the composer contains dictated
  // text. Set when a transcript is spliced in, cleared on send and whenever the
  // composer goes empty (the transcript is gone, so anything typed next is
  // typed, not spoken). Ships to the server as `dictated` so the agent is told
  // the message was transcribed and can read mis-hearings as artifacts. A
  // partly-dictated message still counts: the artifacts are in there either way.
  const [draftDictated, setDraftDictated] = useState(false);
  const markTyped = useCallback((next: string) => {
    if (next.trim() === "") setDraftDictated(false);
  }, []);

  // The single transcript→textarea splice. Cursor/selection come from the
  // live textarea so dictation stitches into partially-typed text.
  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return onTranscript((transcript) => {
      const ta = textareaRef.current;
      setDraftDictated(true);
      setText((prev) => {
        const res = spliceTranscript({
          value: prev,
          selectionStart: ta?.selectionStart,
          selectionEnd: ta?.selectionEnd,
          transcript,
        });
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(res.cursor, res.cursor);
          }
        });
        return res.value;
      });
    });
  }, [onTranscript]);

  // docs/257 req 3 — the install can lose its last credential mid-recording
  // (another tab signs out). Dropping the hotkey listeners does not stop a
  // capture already running, and its transcript would land in a hidden draft.
  // eslint-disable-next-line no-restricted-syntax -- abort an external capture when the composer dies under it
  useEffect(() => {
    if (inert) cancelRecording();
  }, [inert, cancelRecording]);

  // Mode B: when the overlay was opened via the voice hotkey, auto-start mic.
  // `voice.startRecording` is deliberately not a dependency: unlike the other
  // voice callbacks its identity changes with the recorder's own `state`, so
  // depending on it would re-run this arm-the-mic effect on every transition
  // of the recording it just started. Keyed on the open/eligibility inputs only.
  // eslint-disable-next-line no-restricted-syntax -- one-shot auto-start on overlay open
  useEffect(() => {
    if (!isOverlay) return;
    // docs/257 req 3 — Quick Capture can be opened by the voice hotkey, which
    // auto-arms the mic. On an install that cannot run a turn that would start
    // recording a message with nowhere to go, so the auto-start is skipped
    // along with the mic itself. The pending flag is cleared either way, so a
    // later open doesn't inherit an arm the user has forgotten about.
    if (quickCaptureAutoMic && voiceInputEnabled) {
      if (!inert) voice.startRecording();
      useUiStore.getState().setQuickCaptureAutoMic(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `voice.startRecording`'s identity changes with the recorder's own state, so depending on it would re-run this one-shot arm-the-mic effect mid-recording
  }, [isOverlay, quickCaptureAutoMic, voiceInputEnabled, inert]);

  // Per-session draft persistence: remember/restore typed text across session
  // switches and reloads. Skipped for the overlay surface. See `useMessageDraft`.
  const persistDraft = surface !== "overlay";
  useMessageDraft({ focusKey, persistDraft, text, setText });

  // docs/144 — a session switch swaps the draft underneath us. Drafts persist
  // their text, not their provenance, so a restored draft is treated as typed
  // rather than inheriting the outgoing session's dictation flag.
  // eslint-disable-next-line no-restricted-syntax -- reset per-draft state when the composer's session changes
  useEffect(() => {
    setDraftDictated(false);
  }, [focusKey]);

  // Fallback auto-grow for browsers without `field-sizing: content` support.
  useTextareaSizing(textareaRef, text);

  // Consume prefill text from store (e.g. "Start Session" from docs viewer, "Send to Agent" from services panel)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (prefill: string | undefined) => {
      if (!prefill) return;
      // docs/257 req 3 — DEFER while the composer is dead, don't consume. The
      // textarea renders empty, so consuming here would silently replace the
      // user's retained draft with text they can neither see nor send. Leaving
      // it in the store means this effect (which depends on `inert`) picks it up
      // the moment the install becomes runnable.
      if (inert) return;
      setText(prefill);
      // Prefill REPLACES the draft, so whatever was dictated into it is gone.
      setDraftDictated(false);
      useSessionStore.getState().setPrefillText(undefined);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(prefill.length, prefill.length);
        }
      });
    };
    // Check on mount
    consume(useSessionStore.getState().prefillText);
    // Subscribe to future changes
    return useSessionStore.subscribe((state) => {
      consume(state.prefillText);
    });
  }, [surface, inert]);

  // planning#12 — consume a quote-reply blockquote from the store and *append* it to
  // the current draft (unlike prefill, which replaces). This lets the user
  // quote a passage from a chat bubble without losing what they've already
  // typed. We focus the textarea and drop the cursor on the trailing blank line
  // below the quote so they can start typing their reply immediately.
  // eslint-disable-next-line no-restricted-syntax -- consume quote-reply text from external store
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (quote: string | undefined) => {
      if (!quote) return;
      // docs/257 req 3 — deferred for the same reason as the prefill above: this
      // one APPENDS to the draft, so consuming it into an invisible textarea
      // would leave the user with a quote they cannot see, send, or undo.
      if (inert) return;
      useSessionStore.getState().setQuoteReplyText(undefined);
      setText((prev) => {
        // Separate from existing draft with a blank line; the blockquote needs
        // a trailing blank line of its own so markdown closes the quote and the
        // reply lands as a normal paragraph.
        const lead = prev.trim() === "" ? "" : prev.endsWith("\n") ? "\n" : "\n\n";
        const next = `${prev}${lead}${quote}\n\n`;
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) {
            ta.focus();
            ta.setSelectionRange(next.length, next.length);
          }
        });
        return next;
      });
    };
    consume(useSessionStore.getState().quoteReplyText);
    return useSessionStore.subscribe((state) => {
      consume(state.quoteReplyText);
    });
  }, [surface, inert]);

  // Auto-focus textarea on mount and on session change (e.g. "New Session" click,
  // session switch). The ref is intentionally seeded with `undefined` (not `focusKey`)
  // so the very first render with a defined focusKey triggers focus — otherwise focus
  // would be deferred until focusKey transitions from the new-session view's key
  // to the real session ID, which causes a visible delay on "New Session" clicks.
  //
  // Skip on mobile: focusing the textarea pops the on-screen keyboard, which is
  // intrusive when the user is just navigating between sessions. The user can tap
  // the input to summon the keyboard when they actually want to type. We still
  // advance prevFocusKeyRef so a later viewport resize from mobile → desktop
  // doesn't retroactively fire focus for a session change we already saw.
  const prevFocusKeyRef = useRef<string | undefined>(undefined);
  if (surface === "chat" && focusKey && focusKey !== prevFocusKeyRef.current) {
    prevFocusKeyRef.current = focusKey;
    if (!isMobile) {
      // Schedule focus after paint — safe to call during render since it's a microtask
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }

  // The quick-capture overlay suppresses the chat/session focus path above so
  // it cannot race the underlying chat composer, but it still needs to focus
  // its own textarea when mounted. Focus on both desktop and mobile — the
  // overlay is a deliberate, user-initiated surface, so popping the mobile
  // keyboard on open is the wanted behavior, not focus theft.
  // eslint-disable-next-line no-restricted-syntax -- overlay mount autofocus
  useEffect(() => {
    if (surface !== "overlay") return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [surface]);

  // Guard against iframe focus theft on LOAD only: when the textarea is focused
  // and an iframe (e.g. the preview reloading after an edit) finishes loading and
  // pulls focus to itself, the textarea fires a blur with no relatedTarget
  // (cross-origin iframes don't expose it). That steal is involuntary — the user
  // was typing, not navigating — so we reclaim it.
  //
  // EVERY other focus loss is the user's own doing and must be left alone:
  //   - mousedown on non-focusable chat text to start a selection (activeElement
  //     becomes <body>) — reclaiming there cancels the in-progress selection;
  //   - deliberately clicking into the preview iframe (canvas/WebGL games,
  //     embedded apps), switching to the Present tab, or interacting with a doc —
  //     reclaiming there fights the user for the cursor while they work on the
  //     right side, which is the annoyance this guard now avoids.
  //
  // So the reclaim is gated strictly on "an iframe just fired a load event": we
  // record the timestamp of the most-recent iframe load via a capture-phase
  // listener (load doesn't bubble, but a capture-phase listener on the document
  // still sees it for any descendant iframe) and only reclaim if the blur lands
  // within a short window after that load.
  const lastIframeLoadRef = useRef(0);
  useEventListener(document, "load", (e) => {
    const target = e.target as Element | null;
    if (target?.tagName === "IFRAME") {
      lastIframeLoadRef.current = Date.now();
    }
  }, true);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    // relatedTarget is set when focus moves to another focusable element in the
    // same document (e.g. a button click). When an iframe steals focus, or when
    // mousedown happens on a non-focusable element, relatedTarget is null — we
    // need the activeElement check below to disambiguate those two cases.
    if (e.relatedTarget) return;
    requestAnimationFrame(() => {
      // Only an iframe taking focus is a candidate. Body becoming the active
      // element means the user clicked outside any focusable widget (typically to
      // start a text selection); leave focus alone there.
      const active = document.activeElement;
      if (active?.tagName !== "IFRAME") return;
      // Reclaim ONLY if an iframe just finished loading — that's the involuntary
      // load-time focus steal. With no recent load, the user deliberately moved
      // into the iframe (preview click, Present tab, doc), so leave focus there.
      if (Date.now() - lastIframeLoadRef.current > 500) return;
      textareaRef.current?.focus();
    });
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      handleAddFiles(fileArray);
    },
    [handleAddFiles],
  );

  const handleSubmit = () => {
    const trimmed = text.trim();
    // `inert` as well as `disabled`: a retained draft still lives in `text`
    // while the input is dead (it is simply not rendered), so submission has to
    // be refused here and not just hidden behind an empty-looking textarea.
    //
    // docs/285 — `networkSaving` too, and it must be refused HERE and not only
    // on the button: Enter reaches this directly, and pressing Contained then
    // Enter in one breath is precisely the sequence the barrier exists for.
    if (!trimmed || disabled || inert || networkSaving) return;
    const uploadRefs = getUploadRefs();
    const payload: SendPayload = {
      text: trimmed,
      uploadRefs,
      uploads: displayUploads,
      deferredFiles: isOverlay ? localFiles : [],
      // docs/218 — only carry the intent when the control was actually shown.
      ...(showResetControl ? { resetMergedBranch: resetChecked } : {}),
      // docs/144 — omitted entirely when the draft was typed.
      ...(draftDictated ? { dictated: true } : {}),
    };
    // docs/218 — when this send carries the reset intent, the branch is about to
    // be reset to the latest base, which makes the session no longer
    // reset-eligible. Optimistically clear the signal so the control disappears
    // immediately instead of lingering through the turn until the post-turn
    // `reset_eligible: false` arrives. The server's post-turn recompute is
    // authoritative and reconciles (re-arming the control if the reset was
    // unticked or didn't run).
    if (showResetControl && resetChecked && sessionId) {
      usePrStore.getState().setResetEligible(sessionId, false);
    }
    onSend(payload);
    setText("");
    setDraftDictated(false);
    // The transcript the cleanup notice referred to has now left the composer —
    // drop the notice so it doesn't linger over an empty input.
    voice.dismissCleanupWarning();
    clearUploads();
    setShowAutoComplete(false);
    setShowSkillMenu(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't handle Enter/Escape if an autocomplete menu is open — let it handle them
    if (showAutoComplete || showSkillMenu) return;
    // On mobile, Enter inserts a newline (matches native chat-app behavior — the
    // on-screen keyboard's return key shouldn't fire-and-forget a message). The
    // user sends via the send button instead.
    if (isMobile) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);
    markTyped(newText);

    const cursorPos = e.target.selectionStart ?? newText.length;
    const textBeforeCursor = newText.slice(0, cursorPos);

    // Detect a leading `/` for skill autocomplete. Skills only resolve when the
    // `/name` token sits at the very start of the prompt (the CLI requirement),
    // so the menu only opens while the cursor is inside that first token.
    //
    // The `:` is allowed for plugin-namespaced skills installed via docs/149's
    // `<plugin>__<skill>/SKILL.md` layout with frontmatter `name: <plugin>:<skill>`
    // — typing `/foo:bar` should keep the menu open through the namespace
    // separator. The companion regex in `agent-execution.ts` is not end-anchored,
    // so it already handles `:` correctly; no change needed there.
    const slashMatch = /^\/([a-zA-Z0-9._:-]*)$/.exec(textBeforeCursor);
    if (slashMatch && (skills.length > 0 || slashCommands.length > 0)) {
      setSkillQuery(slashMatch[1]);
      setShowSkillMenu(true);
      setShowAutoComplete(false);
      return;
    }
    setShowSkillMenu(false);

    // Detect @ trigger for file autocomplete
    if (onAddFile && fileTree.length > 0) {
      // Find the last @ that's not preceded by a word character (to avoid email addresses)
      const atMatch = /(?:^|[^a-zA-Z0-9])@([^\s]*)$/.exec(textBeforeCursor);
      if (atMatch) {
        const query = atMatch[1];
        setAutoCompleteQuery(query);
        setShowAutoComplete(true);
      } else {
        setShowAutoComplete(false);
      }
    }
  };

  // The `/` trigger that opens the skill menu stays the same for both
  // backends (doc 138 §5) — only the inserted token differs. The prefix
  // travels over the wire from the agent registry's `skillInvocationPrefix`
  // capability, so a new backend's character is one entry in `AGENT_DEFS`
  // rather than another inline branch here. (docs/155)
  const skillTokenPrefix =
    agents.find((a) => a.id === activeAgentId)?.skillInvocationPrefix ?? "/";

  // docs/178 — ShipIt-native `/` commands offered in the `/` menu, gated by the
  // active agent's capabilities. `/compact` only when the backend can compact.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const supportsCompaction =
      agents.find((a) => a.id === activeAgentId)?.supportsCompaction ?? false;
    return supportsCompaction
      ? [{ name: "compact", description: "Summarize the conversation to free up context" }]
      : [];
  }, [agents, activeAgentId]);

  const handleCommandSelect = useCallback(
    (commandName: string) => {
      // Commands are ShipIt constructs — always `/`-prefixed (never the skill
      // token). Insert `/<name>` at the start; no trailing space since commands
      // take no argument, so the user can press Enter to send immediately.
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      const newText = `/${commandName}${text.slice(cursorPos)}`;
      setText(newText);
      setShowSkillMenu(false);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = commandName.length + 1; // "/" + name
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [text],
  );

  const handleSkillSelect = useCallback(
    (skillName: string) => {
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      // The token is always at index 0, so replace everything up to the cursor
      // with `<prefix><name> ` and keep the rest of the message intact.
      const newText = `${skillTokenPrefix}${skillName} ${text.slice(cursorPos)}`;
      setText(newText);
      setShowSkillMenu(false);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = skillName.length + 2; // prefix + name + " "
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [text, skillTokenPrefix],
  );

  const handleSkillDismiss = useCallback(() => {
    setShowSkillMenu(false);
  }, []);

  const handleAutoCompleteSelect = useCallback(
    (filePath: string) => {
      if (onAddFile) {
        onAddFile(filePath);
      }
      // Replace the @query in the text with just @filepath
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      const textBeforeCursor = text.slice(0, cursorPos);
      const atMatch = /(?:^|[^a-zA-Z0-9])@([^\s]*)$/.exec(textBeforeCursor);
      if (atMatch) {
        const startIdx = textBeforeCursor.lastIndexOf(`@${  atMatch[1]}`);
        const newText = `${text.slice(0, startIdx)  }@${  filePath  } ${  text.slice(cursorPos)}`;
        setText(newText);
      }
      setShowAutoComplete(false);
      textareaRef.current?.focus();
    },
    [onAddFile, text],
  );

  const handleAutoCompleteDismiss = useCallback(() => {
    setShowAutoComplete(false);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // docs/257 req 3 — attaching to a message that cannot be sent is the same
      // dead input as typing one.
      if (inert) return;
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles, inert],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // docs/257 req 3 — no drop-zone affordance over a dead input.
    if (inert) return;
    dragCountRef.current++;
    if (dragCountRef.current === 1) {
      setIsDragging(true);
    }
  }, [inert]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragging(false);
      if (inert) return;

      // Check for ShipIt file drag from file tree
      const fileData = e.dataTransfer?.getData("application/x-shipit-file");
      if (fileData && onAddFile) {
        try {
          const { path } = JSON.parse(fileData) as { path: string };
          onAddFile(path);
          return;
        } catch {
          // Not valid JSON — fall through to image handling
        }
      }

      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles, onAddFile, inert],
  );

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    // Reset so the same file can be re-selected
    e.target.value = "";
  };

  return (
    <div
      ref={composerRef}
      className="px-4 pb-3 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-(--color-accent)/10 border-2 border-dashed border-(--color-accent) rounded-lg pointer-events-none">
          <span className="text-(--color-accent) text-sm font-medium">Drop files here</span>
        </div>
      )}

      <Popover open={showAutoComplete || showSkillMenu} modal={false}>
      <PopoverAnchor asChild>
      <div className="relative">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
          data-testid="file-input"
        />

        {/* Unified input box */}
        <div className="flex flex-col rounded-xl bg-(--color-bg-secondary) border border-(--color-border-secondary) focus-within:border-(--color-accent)/80 focus-within:ring-1 focus-within:ring-(--color-accent)/80">
          {/* docs/218 — "start from the latest base" control. Lives INSIDE the
              border as the top row (placement B) — same containment as the
              footer controls, so the input's corners never change. Shown only
              when the session is reset-eligible AND the setting is on; the
              per-send untick is non-sticky. */}
          {showResetControl && (
            <button
              type="button"
              data-testid="reset-merged-branch-control"
              aria-pressed={resetChecked}
              onClick={() => setResetChecked((v) => !v)}
              className="flex items-start gap-2.5 px-3 py-2.5 text-left rounded-t-xl border-b border-(--color-border-secondary) bg-(--color-accent-subtle)"
            >
              <span
                className={`shrink-0 mt-0.5 grid place-items-center w-4 h-4 rounded ${
                  resetChecked
                    ? "bg-(--color-accent) text-white"
                    : "border border-(--color-border-secondary) bg-(--color-bg-tertiary)"
                }`}
              >
                {resetChecked && <CheckIcon size={12} weight="bold" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-medium text-(--color-text-primary)">
                  <GitBranchIcon size={ICON_SIZE.XS} /> Start from the latest base
                </span>
                <span className="block text-[11px] text-(--color-text-tertiary) mt-0.5">
                  Your PR merged — this branch will reset to the latest base before your message runs, so the agent builds on current code.
                </span>
              </span>
            </button>
          )}
          {/* Attachment chips — rendered inside the input box, above the
              textarea, so they're visually contained within the input dialog
              rather than floating above it and overlapping the chat history. */}
          {(pendingFiles.length > 0 || displayUploads.length > 0) && (
            <div className="px-3 pt-3 space-y-2">
              {pendingFiles.length > 0 && onRemoveFile && (
                <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
              )}
              {displayUploads.length > 0 && (
                <FileUploadChips uploads={displayUploads} onRemove={handleRemoveUploadChip} onRetry={handleRetryUploadChip} />
              )}
            </div>
          )}

          {/* Textarea — full width on top */}
          {/* docs/257 req 3 — while `disabledReason` is set the textarea renders
              EMPTY and disabled, with the reason as its placeholder. Empty
              because the value is controlled: a per-session draft or a
              `setPrefillText` seed would otherwise cover the explanation with
              text that cannot be sent. The draft survives in the store and
              returns the moment the install becomes runnable. */}
          <textarea
            ref={textareaRef}
            data-chat-input
            value={inert ? "" : text}
            disabled={inert}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onPaste={handlePaste}
            placeholder={disabledReason ?? "Describe what to build... (type @ to attach files)"}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none field-sizing-content max-h-[40vh] overflow-y-auto disabled:cursor-not-allowed"
          />

          {/* ── Narrow toolbar row (docs/260) ──────────────────────────────
              Below 700px of the COMPOSER's own width — not the window's — the
              permission mode, harness, model and reasoning controls leave the
              row and live behind `ComposerSettingsMenu`, whose anchor carries
              the model name (req 3, 4, 6).

              The overflow guarantee (req 1) is structural, not arithmetic:
              mic/stop/send sit OUTSIDE the clipping group and are `shrink-0`,
              so no amount of content on the left can move them. Inside the
              group the anchor is the only elastic item, so the model name
              ellipsises first and the ring is only ever cut at the group's
              edge — which is flush against the mic (no gap), so it reads as
              clipped by the mic's own square (req 8). Measured: the ring only
              starts to be cut below ~280px, narrower than any phone. */}
          {narrowComposer ? (
            <div className="flex items-center px-2 pb-2">
              <div className="flex flex-1 min-w-0 items-center gap-1 overflow-hidden">
                <WithTooltip label="Add files">
                  <button
                    onClick={handleAttachClick}
                    disabled={inert}
                    className="flex shrink-0 items-center justify-center rounded-lg p-1.5 text-(--color-text-tertiary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary) disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-(--color-text-tertiary)"
                    aria-label="Add files"
                  >
                    <PlusIcon size={ICON_SIZE.SM} />
                  </button>
                </WithTooltip>

                {/* docs/285 reqs 5, 6 — mode AND network access, in one control, on
                    every viewport. It is offered here and nowhere else: the
                    settings menu below no longer carries a Mode row, so there is
                    one place to change one setting.

                    docs/260 req 19 previously gave the mode back to this row
                    only in the desktop quick-capture overlay, on the reasoning
                    that a surface which starts a session and sends its first
                    message in one act needs it most. That reasoning now applies
                    everywhere, because the network mode has exactly the same
                    "decided before the first turn" character.

                    Placed before the settings anchor rather than after it because
                    the anchor is the group's one elastic item: req 8's clipping
                    depends on it being last, so it truncates before anything is
                    cut at the mic's edge. */}
                {(onPermissionModeChange ?? network) && (
                  <div className="flex shrink-0 items-center">
                    <PermissionModeSelector
                      mode={permissionMode}
                      onChange={onPermissionModeChange ?? (() => {})}
                      agents={agents}
                      activeAgentId={activeAgentId}
                      modelInfo={modelInfo}
                      disabled={inert}
                      {...(network ? { network } : {})}
                    />
                  </div>
                )}

                <ComposerSettingsMenu
                  // Keyed on the session so an optimistic pick can't linger across a switch,
                  // for the same reason `ReasoningSelector` is keyed in the wide row.
                  key={sessionId ?? "__new__"}
                  agents={agents}
                  activeAgentId={activeAgentId}
                  onAgentChange={onAgentChange}
                  onModelChange={onModelChange}
                  onReasoningChange={onReasoningChange}
                  sessionReasoning={sessionReasoning}
                  // docs/272 req 15 — the same fact in docs/260's shape: below
                  // 700px the role folds into this one menu, alongside the
                  // controls it sets. The reveal state is shared with the wide
                  // row so crossing the breakpoint does not re-fold what the
                  // user just opened.
                  {...(onRoleChange
                    ? {
                        onRoleChange: (name: string | undefined) => {
                          setPendingRole(name);
                          onRoleChange(name);
                        },
                      }
                    : {})}
                  {...(roleInForce ? { sessionRoleName: roleInForce } : {})}
                  roleParamsRevealed={roleParamsRevealed}
                  onAdjustRoleParameters={revealRoleParameters}
                  onRoleSelected={foldRoleParameters}
                  onLeaveRole={leavePendingRole}
                  roleLocked={roleLocked}
                  modelInfo={modelInfo ?? null}
                  hasActiveSession={hasActiveSession}
                  // Same split the wide row makes three lines apart: the harness
                  // and model pickers key off "is a session bound", reasoning off
                  // "is a session active".
                  seedFromHistory={!sessionId}
                  // docs/260 req 19 — the menu drops its Mode row when the row
                  // carries the control. The handler still goes in: the menu
                  // reads the mode for nothing else, and a menu that could not
                  // be told the mode would have to guess it back.
                  // Only `inert` closes the anchor. A running turn locks the
                  // three pickers instead, so the mode stays changeable and the
                  // settings stay readable — matching the wide row exactly.
                  disabled={inert}
                  pickersLocked={disabled || isLoading}
                />

                {surface === "chat" && (modelInfo ?? contextTokens > 0) && (
                  <div className="flex shrink-0 items-center">
                    <ContextDialMount
                      modelInfo={modelInfo ?? null}
                      contextTokensFallback={contextTokens}
                      onOpenUsageDetails={onOpenUsageDetails}
                      compact
                    />
                  </div>
                )}
              </div>

              {voiceInputEnabled && !inert && (
                <div className="flex shrink-0 items-center">
                  <MicButton
                    voice={voice}
                    large={isMobile}
                    hotkeyLabel={formatHotkeyLabel(isOverlay ? voiceHotkeyModeB : voiceHotkeyModeA)}
                    onOpenSettings={() => {
                      const ui = useUiStore.getState();
                      ui.setSettingsTab("voice");
                      ui.setSettingsOpen(true);
                    }}
                  />
                </div>
              )}
              {voiceInputEnabled && !inert && isMobile && <MobileRecordingOverlay voice={voice} />}

              {isLoading && onInterrupt ? (
                <>
                  <WithTooltip label="Stop the agent">
                    <button
                      onClick={onInterrupt}
                      className={`ml-1 flex shrink-0 items-center justify-center rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-error) text-white transition-colors hover:brightness-110`}
                      aria-label="Stop the agent"
                      data-testid="stop-button"
                    >
                      <StopIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="fill" />
                    </button>
                  </WithTooltip>
                  {liveSteeringActive && (
                    <button
                      onClick={handleSubmit}
                      disabled={disabled || inert || networkSaving || !text.trim()}
                      className={`ml-1 flex shrink-0 items-center justify-center rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-accent) text-white transition-colors hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-30`}
                      aria-label="Send message"
                      data-testid="send-button"
                    >
                      <ArrowUpIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="bold" />
                    </button>
                  )}
                </>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={disabled || inert || networkSaving || !text.trim()}
                  className={`ml-1 flex shrink-0 items-center justify-center rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-accent) text-white transition-colors hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-30`}
                  aria-label="Send message"
                  data-testid="send-button"
                >
                  <ArrowUpIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="bold" />
                </button>
              )}
            </div>
          ) : (
          /* Toolbar row — below textarea.
              Desktop keeps the conventional split (add/mic/mode on the left,
              cost/model/send on the right) to match Claude Code and other
              desktop chat UIs. On mobile the order is swapped via CSS `order`
              so the frequently-tapped mic + send sit together as large thumb
              targets on the right, and the rarely-tapped add/mode/cost/model
              pack to the left (docs/144). The numeric `order` values leave gaps
              so items can be inserted later without renumbering.

              docs/260 — this is now the WIDE row: it renders only when the
              composer is at least 700px across. The `isMobile` order swaps stay
              because a tablet can be both `isMobile` and ≥700px wide. */
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Add files button. Enabled even before a session is ready —
                files attached then are buffered by useFileUpload and uploaded
                once sessionId resolves — but NOT while `disabledReason` is set:
                attaching to a message that cannot be sent is the same dead
                input as typing one (docs/257 req 3). */}
            <div className="flex items-center shrink-0" style={{ order: 10 }}>
            <WithTooltip label="Add files">
            <button
              onClick={handleAttachClick}
              disabled={inert}
              className="flex items-center justify-center shrink-0 rounded-lg p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-(--color-text-tertiary)"
              aria-label="Add files"
            >
              <PlusIcon size={ICON_SIZE.SM} />
            </button>
            </WithTooltip>
            </div>

            {/* Mic — dictation entry point (docs/144). Only when voice input is
                enabled in settings, so the endpoint surface stays off for users
                who don't opt in. On mobile it moves to the right, just left of
                Send (order 60); on desktop it stays in the left group (20). */}
            {/* docs/257 req 3 — hidden rather than disabled while the input is
                inert: MicButton is a state machine (recording / transcribing /
                error popover) with nothing to disable, and a visible mic that
                does nothing is the dead control req 10 refuses to show. */}
            {voiceInputEnabled && !inert && (
              <div className="flex items-center shrink-0" style={{ order: isMobile ? 60 : 20 }}>
                <MicButton
                  voice={voice}
                  large={isMobile}
                  hotkeyLabel={formatHotkeyLabel(isOverlay ? voiceHotkeyModeB : voiceHotkeyModeA)}
                  onOpenSettings={() => {
                    const ui = useUiStore.getState();
                    ui.setSettingsTab("voice");
                    ui.setSettingsOpen(true);
                  }}
                />
              </div>
            )}

            {/* Mobile-only full-screen recording surface (docs/144): a big
                central Stop button + Cancel, shown while recording. Desktop
                keeps the inline icon + push-to-talk hotkey. Out of flow
                (fixed) and null when idle, so its default order is harmless. */}
            {voiceInputEnabled && !inert && isMobile && <MobileRecordingOverlay voice={voice} />}

            {/* Permission mode selector (3-state, agent-aware — docs/138), which
                docs/285 also made the session's network control (reqs 5, 6): one
                trigger, the same on every viewport, for new and running sessions
                alike. It renders for a network section alone, so a harness with
                one permission mode (Codex) keeps the control rather than taking
                network access down with it. */}
            {(onPermissionModeChange ?? network) && (
              <div className="flex items-center shrink-0" style={{ order: isMobile ? 20 : 30 }}>
                <PermissionModeSelector
                  mode={permissionMode}
                  onChange={onPermissionModeChange ?? (() => {})}
                  agents={agents}
                  activeAgentId={activeAgentId}
                  modelInfo={modelInfo}
                  disabled={inert}
                  {...(network ? { network } : {})}
                />
              </div>
            )}

            {/* Spacer — splits the left (infrequent) group from the right
                (mic + send). After mode on desktop (40), after the model
                selector on mobile (50). */}
            <div className="flex-1" style={{ order: isMobile ? 50 : 40 }} />

            {/* Context dial — per-turn breakdown popover (105). The dial is now
             * also the cost surface: its trigger shows running session cost
             * and its popover row opens the usage modal. The standalone cost
             * pill was removed to eliminate a stale-vs-authoritative
             * discrepancy between the two. */}
            {/* docs/260-composer-toolbar-layout req 1 / req 8 — the wide row's clipping group. The four
                labelled controls (dial, harness, model, reasoning) sit inside a
                `min-w-0 overflow-hidden` box so that when the row runs out of
                width their LABELS are cut, instead of the row overflowing and
                carrying Send off the right edge — which is what shipped, and
                what still happened between 700 and ~808px after the compact row
                was added below 700.

                Note this clips the MIDDLE, not the left, which is the difference
                from the compact row: in the wide layout the mic sits on the far
                left, and req 1 protects the mic as well as Stop and Send. So
                both ends are pinned and the labels in between give way.

                The children keep no `order` of their own — their DOM order is
                already the order both layouts asked for — and the group takes
                the order the first of them used to have. */}
            <div
              className="flex min-w-0 items-center gap-1 overflow-hidden"
              style={{ order: isMobile ? 30 : 50 }}
              data-testid="wide-row-clip-group"
            >
            {surface === "chat" && (modelInfo ?? contextTokens > 0) && (
              <div className="flex items-center shrink-0">
                <ContextDialMount
                  modelInfo={modelInfo ?? null}
                  contextTokensFallback={contextTokens}
                  onOpenUsageDetails={onOpenUsageDetails}
                />
              </div>
            )}

            {/* docs/272-user-selectable-roles reqs 5, 14, 16 — the role control. It sits at the
                head of the three selectors it can replace, because when a role
                is in force it stands exactly where they would have. Inside the
                clip group with them, and cheap to keep there: a row showing a
                role is SHORTER than today's, so this can only reduce the width
                pressure docs/260 manages, never add to it. */}
            {showRoleControl && (
              <div className="flex items-center shrink-0">
                <RoleSelector
                  roles={roles}
                  {...(roleInForce ? { selectedRole: roleInForce } : {})}
                  onSelectRole={(name) => {
                    // A fresh pick folds the parameters away: they described the
                    // role the user has just left behind. "No role" (req 18)
                    // needs no fold — with nothing in force the three controls
                    // are back on their own (`roleParamsRevealed`).
                    foldRoleParameters();
                    setPendingRole(name);
                    onRoleChange?.(name);
                  }}
                  {...(roleInForce && !roleParamsRevealed
                    ? { onAdjustParameters: revealRoleParameters }
                    : {})}
                  locked={roleLocked}
                  disabled={disabled || isLoading || inert}
                />
              </div>
            )}

            {/* docs/252 phase 3 — harness and model are two controls, not one
                grouped dropdown. The harness is irreversible once the session
                pins it and the model is not, so the asymmetry is structural
                rather than a lock badge inside a menu.

                docs/272 req 5 — hidden while a role is in force and its
                parameters have not been asked for: the role IS these three, so
                restating them says nothing the user did not just decide. */}
            {onAgentChange && roleParamsRevealed && (
              <div className="flex items-center shrink-0">
                <HarnessSelector
                  agents={agents}
                  activeAgentId={activeAgentId}
                  // docs/272 req 15 — see `leavePendingRole`.
                  onAgentChange={(id) => { leavePendingRole(); onAgentChange(id); }}
                  hasActiveSession={hasActiveSession}
                  // No session bound to this composer at all (Quick Capture, or
                  // the new-session route before its warm session is claimed),
                  // so the picker previews what the next session inherits rather
                  // than describing whichever session is active behind it.
                  seedFromHistory={!sessionId}
                  // `inert` too — req 3 disables the composer "as a whole", and
                  // these three were the affordances left live: with no runnable
                  // service the harness menu opened onto rows that are all
                  // unselectable and the model menu onto nothing at all. The
                  // compact row already read `inert` on its anchor, so the two
                  // layouts disagreed about the same fact.
                  disabled={disabled || isLoading || inert}
                />
              </div>
            )}
            {onAgentChange && roleParamsRevealed && (
              <div className="flex items-center shrink-0">
                <ModelSelector
                  agents={agents}
                  activeAgentId={activeAgentId}
                  onModelChange={(selection) => { leavePendingRole(); onModelChange?.(selection); }}
                  modelInfo={modelInfo ?? null}
                  hasActiveSession={hasActiveSession}
                  seedFromHistory={!sessionId}
                  disabled={disabled || isLoading || inert}
                />
              </div>
            )}

            {/* docs/217 — Control B: per-session reasoning effort, beside the
                model selector. Self-hides when the active agent has no knob. */}
            {onReasoningChange && roleParamsRevealed && (
              <div className="flex items-center shrink-0">
                <ReasoningSelector
                  // Key on the session so the optimistic pick never lingers across a switch.
                  key={sessionId ?? "__new__"}
                  agent={agents.find((a) => a.id === activeAgentId)}
                  sessionReasoning={sessionReasoning}
                  onChange={(effort) => { leavePendingRole(); onReasoningChange(effort); }}
                  disabled={disabled || isLoading || inert}
                  seedFromHistory={!hasActiveSession}
                />
              </div>
            )}

            </div>

            {/* Send / Stop button — pinned right (order 80) with a small gap
                from the item before it. On mobile the icon (MD) and hit area
                (≥44px) grow to match the bottom-bar thumb targets; desktop
                stays compact (docs/144). */}
            <div className="flex items-center gap-1 shrink-0 ml-1" style={{ order: 80 }}>
            {isLoading && onInterrupt ? (
              <>
                <WithTooltip label="Stop the agent">
                <button
                  onClick={onInterrupt}
                  className={`flex items-center justify-center shrink-0 rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-error) text-white hover:brightness-110 transition-colors`}
                  aria-label="Stop the agent"
                  data-testid="stop-button"
                >
                  <StopIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="fill" />
                </button>
                </WithTooltip>
                {liveSteeringActive && (
                  <button
                    onClick={handleSubmit}
                    disabled={disabled || inert || networkSaving || !text.trim()}
                    className={`flex items-center justify-center shrink-0 rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                    aria-label="Send message"
                    data-testid="send-button"
                  >
                    <ArrowUpIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="bold" />
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={disabled || inert || networkSaving || !text.trim()}
                className={`flex items-center justify-center shrink-0 rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                aria-label="Send message"
                data-testid="send-button"
              >
                <ArrowUpIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="bold" />
              </button>
            )}
            </div>
          </div>
          )}

          {/* Cleanup fell through to the raw transcript — non-fatal, dismissed
              on the next successful dictation (docs/144). */}
          {voice.cleanupWarning && (
            <div className="px-3 pb-2 text-xs text-(--color-text-tertiary)">
              {voice.cleanupWarning}
            </div>
          )}
        </div>
      </div>
      </PopoverAnchor>
      {showAutoComplete && (
        <FileAutoComplete
          query={autoCompleteQuery}
          fileTree={fileTree}
          onSelect={handleAutoCompleteSelect}
          onDismiss={handleAutoCompleteDismiss}
          uploadPaths={allUploads.filter((u) => u.status === "ready" && u.path).map((u) => u.path!)}
        />
      )}
      {showSkillMenu && (
        <SkillAutoComplete
          query={skillQuery}
          skills={skills}
          commands={slashCommands}
          tokenPrefix={skillTokenPrefix}
          onSelect={handleSkillSelect}
          onCommandSelect={handleCommandSelect}
          onDismiss={handleSkillDismiss}
        />
      )}
      </Popover>
    </div>
  );
}
