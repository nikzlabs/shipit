// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { useNarrowContainer } from "../../hooks/useNarrowContainer.js";
import { PlusIcon, StopIcon, ArrowUpIcon, GitBranchIcon, CheckIcon, BroomIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { usePrStore } from "../../stores/pr-store.js";
import {
  PermissionModeSelector,
  type NetworkSectionProps,
} from "../PermissionModeSelector.js";
import { HarnessSelector, ModelSelector, useHarnessPickerState } from "../ModelPicker.js";
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
import {
  getSavedRoleName,
  saveRoleName,
  getSavedMergeContinueOptOut,
  type MergeContinueControl,
} from "../../utils/local-storage.js";
import { applyRoleSeeds } from "../../utils/role-seed.js";
import { useTextareaSizing } from "./hooks/useTextareaSizing.js";
import { useMessageDraft } from "./hooks/useMessageDraft.js";
import { useUploadBackend } from "./hooks/useUploadBackend.js";
import { isLargePaste, buildPastedTextFile } from "./large-paste.js";
import { isCompactCommand } from "../../../server/shared/compact-command.js";
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

/** docs/297 — offer only the goal actions the active harness has; absent means all. */
export function goalSlashCommands(actions: AgentOption["goalActions"]): SlashCommand[] {
  const offers = (action: "get" | "set" | "clear" | "pause" | "resume"): boolean =>
    !actions || actions[action] !== undefined;
  return [
    ...(offers("get")
      ? [{
          name: "goal",
          description: offers("set")
            ? "Show the goal — or type /goal <objective> to set one"
            : "Show the goal",
        }]
      : []),
    ...(offers("clear") ? [{ name: "goal clear", description: "Remove the goal" }] : []),
    ...(offers("pause") ? [{ name: "goal pause", description: "Pause the goal" }] : []),
    ...(offers("resume") ? [{ name: "goal resume", description: "Resume a paused goal" }] : []),
  ];
}

function formatHotkeyLabel(hotkey: string): string {
  return hotkey
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === "mod" ? "Cmd/Ctrl" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}

export interface SendPayload {
  text: string;
  uploadRefs: UploadRef[];

  uploads: UploadItem[];

  deferredFiles: File[];

  resetMergedBranch?: boolean;

  compactContext?: boolean;

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
  /**
   * Dispatch this send, and say whether it happened. `false` means **refused**:
   * nothing went out, so the composer keeps its text and its attachments
   * instead of clearing them into a message that never existed (docs/293
   * req 4). Required rather than optional on purpose — a handler that has to
   * answer cannot forget to, which is exactly how the original loss happened.
   */
  onSend: (payload: SendPayload) => boolean;
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

  skills?: SkillInfo[];

  sessionId?: string;
  agents?: AgentOption[];
  activeAgentId?: AgentId;
  onAgentChange?: (agentId: AgentId) => void;
  onModelChange?: (selection: ModelChoice) => void;

  onReasoningChange?: (effort: string | null) => void;

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

  onRoleChange?: (roleName: string | undefined) => void;

  roleLocked?: boolean;
  modelInfo?: ModelInfo | null;
  contextTokens?: number;
  hasActiveSession?: boolean;

  onOpenUsageDetails?: () => void;

  focusKey?: string;

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

     saving: boolean;
  };
}) {
  const isMobile = useIsMobile();

  // case a media query cannot see and the reported bug. `useNarrowContainer`

  const composerRef = useRef<HTMLDivElement>(null);
  const narrowComposer = useNarrowContainer(composerRef, COMPOSER_NARROW_PX);

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
  const networkSaving =
    (network?.saving ?? false)
    // req 10 — the control must state what it will do BEFORE the user commits.

    || (network ? !network.loaded : false);

  const settingsLocked = isLoading || (disabled && !!sessionId);
  const [text, setText] = useState("");

  // folds the parameters away again, while switching sessions cannot carry an

  const { roles, hasRoles } = useRolePickerState();
  const roleRevealScope = sessionId ?? focusKey ?? surface;
  const [revealedRoleByScope, setRevealedRoleByScope] = useState<Record<string, string>>({});

  // localStorage because React cannot subscribe to localStorage, and initialised

  const [pendingRole, setPendingRole] = useState<string | undefined>(() => getSavedRoleName());

  // The seed may name a role this session never took — it is chosen for the

  const roleInForce = hasActiveSession ? sessionRoleName : (sessionRoleName ?? pendingRole);

  const leavePendingRole = () => {
    setPendingRole(undefined);
    if (!hasActiveSession) saveRoleName(undefined);
  };
  const roleView = roles.find((r) => r.name === roleInForce);

  // bump is needed because localStorage is not something React can subscribe to.
  const [, noteSeedWrite] = useState(0);
  // eslint-disable-next-line no-restricted-syntax -- reconciles an external store (localStorage) the pickers read during render; there is nothing else to subscribe to
  useEffect(() => {
    if (!roleInForce || hasActiveSession) return;
    if (applyRoleSeeds(roleView)) noteSeedWrite((n) => n + 1);
  }, [roleInForce, hasActiveSession, roleView]);

  // controls at the first turn and never got them back — while an identical

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
  // The harness the picker beside it names: `activeAgentId` was a second rule,
  // and the two disagree wherever no session is bound.
  const displayedHarnessAgent = useHarnessPickerState({
    agents,
    activeAgentId,
    hasActiveSession,
    seedFromHistory: !sessionId,
  }).displayAgent;
  const [isDragging, setIsDragging] = useState(false);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

  // docs/218 — shown only when the session is reset-eligible (merged + branch
  // untouched since the merge + clean tree) AND the global setting is on.
  // Correctness is server-side; the checkbox is intent.
  const autoResetMergedBranch = useSettingsStore((s) => s.autoResetMergedBranch);
  const resetEligible = usePrStore((s) => (sessionId ? s.resetEligibleBySession[sessionId] ?? false : false));
  const showResetControl = resetEligible && autoResetMergedBranch;

  // docs/295 — offered whenever the reset control is (reqs 1, 3, 11), if the
  // backend can compact (req 10). No occupancy threshold (req 3).
  const agentSupportsCompaction =
    agents.find((a) => a.id === activeAgentId)?.supportsCompaction ?? false;
  const showCompactControl = showResetControl && agentSupportsCompaction;

  /**
   * Both controls' tick state, and why it is not component state.
   *
   * It was two `useState(true)` flags re-armed by an effect keyed on the
   * control becoming visible, and each half could silently discard an untick
   * the user was still looking at. The visibility is not an episode boundary
   * and is not under the user's control: several server paths recompute
   * eligibility between turns (including a debounced file-change recompute),
   * and `computeResetEligibility` fails closed, so a git read that throws
   * answers `false` for an eligible session. One such `false` re-ticks the box
   * on the way back to `true`, and a send made while the control is away used
   * to omit the field entirely. And the composer is remounted by more than a
   * reload — `AppLayout` swaps a Fragment for a `div` across the mobile
   * breakpoint, and App drops the composer whenever `showHomeScreen` turns
   * true — through all of which the draft text and the chips came back from
   * their stores while this one checkbox silently did not.
   *
   * So the untick belongs to the message being drafted and lives as long as
   * that draft does — in the store, mirrored to localStorage, keyed by session
   * — and only the send it was made for clears it (req 5). Nothing keys on a
   * transition. Read through the store, falling back to the durable mirror for
   * the reload case where localStorage is the only record.
   */
  const storedOptOut = usePrStore((s) => (sessionId ? s.mergeContinueOptOutBySession[sessionId] : undefined));
  const mergeOptOut = useMemo(
    () => storedOptOut ?? (sessionId ? getSavedMergeContinueOptOut(sessionId) : {}),
    [storedOptOut, sessionId],
  );
  const resetChecked = !mergeOptOut.reset;
  const compactChecked = !mergeOptOut.compact;
  const toggleMergeControl = (control: MergeContinueControl, currentlyChecked: boolean) => {
    if (!sessionId) return;
    usePrStore.getState().setMergeContinueOptOut(sessionId, control, currentlyChecked);
  };

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

  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const voiceHotkeyModeA = useKeybinding("voice-mode-a");
  const voiceHotkeyModeB = useKeybinding("voice-mode-b");
  const quickCaptureAutoMic = useUiStore((s) => s.quickCaptureAutoMic);

  const voice = useVoiceInput({

    // and splice the transcript into a draft that cannot be sent.
    enabled: voiceInputEnabled && !inert,
    hotkey: isOverlay ? voiceHotkeyModeB : voiceHotkeyModeA,
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,

    // is its own short-lived surface and never "switches" underneath itself.
    sessionId: isOverlay ? "overlay" : sessionId,
  });

  const { onTranscript, cancelRecording } = voice;

  const [draftDictated, setDraftDictated] = useState(false);
  const markTyped = useCallback((next: string) => {
    if (next.trim() === "") setDraftDictated(false);
  }, []);

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

  // eslint-disable-next-line no-restricted-syntax -- abort an external capture when the composer dies under it
  useEffect(() => {
    if (inert) cancelRecording();
  }, [inert, cancelRecording]);

  // eslint-disable-next-line no-restricted-syntax -- one-shot auto-start on overlay open
  useEffect(() => {
    if (!isOverlay) return;

    // auto-arms the mic. On an install that cannot run a turn that would start

    if (quickCaptureAutoMic && voiceInputEnabled) {
      if (!inert) voice.startRecording();
      useUiStore.getState().setQuickCaptureAutoMic(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `voice.startRecording`'s identity changes with the recorder's own state, so depending on it would re-run this one-shot arm-the-mic effect mid-recording
  }, [isOverlay, quickCaptureAutoMic, voiceInputEnabled, inert]);

  const persistDraft = surface !== "overlay";
  useMessageDraft({ focusKey, persistDraft, text, setText });

  // eslint-disable-next-line no-restricted-syntax -- reset per-draft state when the composer's session changes
  useEffect(() => {
    setDraftDictated(false);
  }, [focusKey]);

  useTextareaSizing(textareaRef, text);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (prefill: string | undefined) => {
      if (!prefill) return;

      if (inert) return;
      setText(prefill);

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

    consume(useSessionStore.getState().prefillText);

    return useSessionStore.subscribe((state) => {
      consume(state.prefillText);
    });
  }, [surface, inert]);

  // eslint-disable-next-line no-restricted-syntax -- consume quote-reply text from external store
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (quote: string | undefined) => {
      if (!quote) return;

      // would leave the user with a quote they cannot see, send, or undo.
      if (inert) return;
      useSessionStore.getState().setQuoteReplyText(undefined);
      setText((prev) => {

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

  // session switch). The ref is intentionally seeded with `undefined` (not `focusKey`)

  const prevFocusKeyRef = useRef<string | undefined>(undefined);
  if (surface === "chat" && focusKey && focusKey !== prevFocusKeyRef.current) {
    prevFocusKeyRef.current = focusKey;
    if (!isMobile) {

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }

  // it cannot race the underlying chat composer, but it still needs to focus

  // eslint-disable-next-line no-restricted-syntax -- overlay mount autofocus
  useEffect(() => {
    if (surface !== "overlay") return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [surface]);

  // EVERY other focus loss is the user's own doing and must be left alone:

  const lastIframeLoadRef = useRef(0);
  useEventListener(document, "load", (e) => {
    const target = e.target as Element | null;
    if (target?.tagName === "IFRAME") {
      lastIframeLoadRef.current = Date.now();
    }
  }, true);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {

    if (e.relatedTarget) return;
    requestAnimationFrame(() => {

      const active = document.activeElement;
      if (active?.tagName !== "IFRAME") return;

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

  /**
   * docs/294 reqs 5-6 — `/compact` in quick capture. Reqs 5 and 6 say the
   * attachment stays in the composer and the command carries none; on this
   * surface the composer is unmounted on send, so "stays" and "carries none"
   * cannot both hold for a message that goes. Refusing the send is what makes
   * them both true — and a brand-new session has no conversation to compact
   * anyway, so there was nothing for the command to do.
   */
  const compactInOverlay = isOverlay && isCompactCommand(text.trim());

  const uploadsInFlight = displayUploads.some((u) => u.status === "uploading");
  const uploadsFailed = displayUploads.some((u) => u.status === "error");

  const hasAttachment = pendingFiles.length > 0 || displayUploads.length > 0;
  const sendBlocked =
    disabled || inert || networkSaving
    || (!text.trim() && !hasAttachment)
    || uploadsInFlight                      
    || uploadsFailed                        
    || compactInOverlay;                       

  const sendBlockedReason = uploadsInFlight
    ? "Waiting for attachments to finish uploading"
    : uploadsFailed
      ? "An attachment failed to upload — retry or remove it"
      : compactInOverlay
        ? "There is nothing to compact in a new session"
        : undefined;

  const handleSubmit = () => {
    const trimmed = text.trim();
    // `sendBlocked` covers every bar, and it must be re-read HERE and not only

    if (sendBlocked) return;

    const isCompact = isCompactCommand(trimmed);
    const uploadRefs = isCompact ? [] : getUploadRefs();
    const payload: SendPayload = {
      text: trimmed,
      uploadRefs,
      uploads: isCompact ? [] : displayUploads,
      deferredFiles: isCompact || !isOverlay ? [] : localFiles,
      ...(draftDictated ? { dictated: true } : {}),
    };
    // docs/293 req 4 — the parent may refuse a send it never dispatched:

    // were lost for a send that never happened — an attachment dropped without

    if (!onSend(payload)) return;

    if (showResetControl && resetChecked && sessionId) {
      usePrStore.getState().setResetEligible(sessionId, false);
    }
    // NOT cleared here. `sendUserTurn` spends the untick when the frame goes,
    // and only then — a `/goal` submitted from this composer starts no turn and
    // carries no intent, so clearing on every accepted submit spent a choice
    // the user had made for their next real message.
    setText("");
    setDraftDictated(false);

    voice.dismissCleanupWarning();
    if (!isCompact) clearUploads();
    setShowAutoComplete(false);
    setShowSkillMenu(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {

    if (showAutoComplete || showSkillMenu) return;

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

    const slashMatch = /^\/([a-zA-Z0-9._:-]*)$/.exec(textBeforeCursor);
    if (slashMatch && (skills.length > 0 || slashCommands.length > 0)) {
      setSkillQuery(slashMatch[1]);
      setShowSkillMenu(true);
      setShowAutoComplete(false);
      return;
    }
    setShowSkillMenu(false);

    if (onAddFile && fileTree.length > 0) {

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

  const skillTokenPrefix =
    agents.find((a) => a.id === activeAgentId)?.skillInvocationPrefix ?? "/";

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const active = agents.find((a) => a.id === activeAgentId);
    return [
      ...(active?.supportsCompaction
        ? [{ name: "compact", description: "Summarize the conversation to free up context" }]
        : []),
      ...(active?.supportsGoals ? goalSlashCommands(active.goalActions) : []),
    ];
  }, [agents, activeAgentId]);

  const handleCommandSelect = useCallback(
    (commandName: string) => {
      // Commands are ShipIt constructs — always `/`-prefixed (never the skill

      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      const newText = `/${commandName}${text.slice(cursorPos)}`;
      setText(newText);
      setShowSkillMenu(false);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = commandName.length + 1;              
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

      const newText = `${skillTokenPrefix}${skillName} ${text.slice(cursorPos)}`;
      setText(newText);
      setShowSkillMenu(false);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = skillName.length + 2;                       
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
        return;
      }

      const pastedText = e.clipboardData.getData("text/plain");
      if (isLargePaste(pastedText)) {
        e.preventDefault();
        addFiles([buildPastedTextFile(pastedText)]);
      }
    },
    [addFiles, inert],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

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
            <div className="rounded-t-xl border-b border-(--color-border-secondary) bg-(--color-accent-subtle)">
              <button
                type="button"
                data-testid="reset-merged-branch-control"
                aria-pressed={resetChecked}
                onClick={() => toggleMergeControl("reset", resetChecked)}
                className="w-full flex items-start gap-2.5 px-3 pt-2.5 pb-1 text-left"
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
              {/* docs/295 — subordinate to the row above: one line, no description.
                  Its own top padding, not the reset row's bottom padding: the two
                  buttons abut, so the apparent breathing room above this checkbox
                  used to be a live hit target for the OTHER control, and a
                  near-miss silently unticked the branch reset while the tick the
                  user was aiming at stayed on. Same total gap, split between the
                  rows it looks like. */}
              {showCompactControl && (
                <button
                  type="button"
                  data-testid="compact-context-control"
                  aria-pressed={compactChecked}
                  onClick={() => toggleMergeControl("compact", compactChecked)}
                  className="w-full flex items-center gap-2.5 px-3 pt-1.5 pb-2.5 text-left"
                >
                  <span
                    className={`shrink-0 grid place-items-center w-4 h-4 rounded ${
                      compactChecked
                        ? "bg-(--color-accent) text-white"
                        : "border border-(--color-border-secondary) bg-(--color-bg-tertiary)"
                    }`}
                  >
                    {compactChecked && <CheckIcon size={12} weight="bold" />}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-(--color-text-primary)">
                    <BroomIcon size={ICON_SIZE.XS} /> Compact the context
                  </span>
                </button>
              )}
            </div>
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
                  // Remount after a role change so picker state cannot outlive the role.
                  key={`${sessionId ?? "__new__"}:${roleInForce ?? ""}`}
                  agents={agents}
                  activeAgentId={activeAgentId}
                  onAgentChange={onAgentChange}
                  onModelChange={onModelChange}
                  onReasoningChange={onReasoningChange}
                  sessionReasoning={sessionReasoning}

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

                  seedFromHistory={!sessionId}

                  disabled={inert}
                  pickersLocked={settingsLocked}
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
                      disabled={sendBlocked}
                      {...(sendBlockedReason ? { title: sendBlockedReason } : {})}
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
                  disabled={sendBlocked}
                  {...(sendBlockedReason ? { title: sendBlockedReason } : {})}
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

                    foldRoleParameters();
                    setPendingRole(name);
                    onRoleChange?.(name);
                  }}
                  {...(roleInForce && !roleParamsRevealed
                    ? { onAdjustParameters: revealRoleParameters }
                    : {})}
                  locked={roleLocked}
                  disabled={settingsLocked || inert}
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

                  onAgentChange={(id) => { leavePendingRole(); onAgentChange(id); }}
                  hasActiveSession={hasActiveSession}

                  seedFromHistory={!sessionId}

                  disabled={settingsLocked || inert}
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
                  disabled={settingsLocked || inert}
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
                  agent={displayedHarnessAgent}
                  sessionReasoning={sessionReasoning}
                  onChange={(effort) => { leavePendingRole(); onReasoningChange(effort); }}
                  disabled={settingsLocked || inert}
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
                    disabled={sendBlocked}
                    {...(sendBlockedReason ? { title: sendBlockedReason } : {})}
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
                disabled={sendBlocked}
                {...(sendBlockedReason ? { title: sendBlockedReason } : {})}
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
