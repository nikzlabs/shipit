// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { useFileUpload } from "../hooks/useFileUpload.js";
import { PlusIcon, StopIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { PermissionModeSelector } from "./PermissionModeSelector.js";
import { ModelAgentSelector } from "./ModelAgentSelector.js";
import { ContextDial } from "./ContextDial.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import { SkillAutoComplete, type SlashCommand } from "./SkillAutoComplete.js";
import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileUploadChips } from "./FileUploadChips.js";
import { Popover, PopoverAnchor } from "./ui/popover.js";
import { WithTooltip } from "./ui/tooltip.js";
import { MicButton } from "./MicButton.js";
import { MobileRecordingOverlay } from "./MobileRecordingOverlay.js";
import { useVoiceInput } from "../voice/use-voice-input.js";
import { spliceTranscript } from "../voice/insert-transcript.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { getSavedDraftMessage, saveDraftMessage } from "../utils/local-storage.js";
import type { PermissionMode, FileContextRef, FileTreeNode, AgentId, SkillInfo, UploadRef } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";
import type { AgentOption } from "../agent-types.js";
import type { ModelInfo } from "../utils/model-info.js";

// `field-sizing: content` (the CSS that grows the textarea with its content)
// is supported on Chrome/Edge and Firefox desktop, but missing on Firefox for
// Android and Safari. When unsupported we resize manually in a layout effect.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("field-sizing", "content")
    : false;

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
}

export function MessageInput({
  onSend,
  disabled,
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
  modelInfo,
  contextTokens = 0,
  hasActiveSession = false,
  onOpenUsageDetails,
  focusKey,
  liveSteeringActive = false,
  surface = "chat",
}: {
  onSend: (payload: SendPayload) => void;
  disabled: boolean;
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
  onModelChange?: (model: string) => void;
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
}) {
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

  // ── Upload backend ───────────────────────────────────────────────────────
  // Two modes share the same surface (chip rendering, +/drop-zone, submit
  // clear). The split is by `surface`, not by `sessionId` presence:
  //   - "chat":   route through `useFileUpload(sessionId)`. POSTs land in
  //               the global file-store; when sessionId is temporarily
  //               undefined (the /{slug}/new view, before claimSession
  //               resolves), useFileUpload buffers and drains on its own.
  //   - "overlay": buffer raw Files in component-local state. The overlay
  //                creates a brand-new session on send and ships the files
  //                multipart in the same call, so the global store must
  //                stay untouched — a chat input is still mounted behind
  //                the modal and would otherwise sprout phantom chips.
  // `useFileUpload` is always called (hooks rule); in overlay mode we just
  // never invoke its `uploadFiles`, so no store writes happen.
  const isOverlay = surface === "overlay";
  const sessionUpload = useFileUpload(isOverlay ? undefined : sessionId);
  const allSessionUploads = useFileStore((s) => s.sessionUploads);
  const [localFiles, setLocalFiles] = useState<File[]>([]);

  // Map raw Files into UploadItem placeholders so the chip renderer treats
  // both modes identically. Status is "ready" — no progress bar, no retry,
  // since these are kept entirely local until the parent ships them.
  const localUploadItems = useMemo<UploadItem[]>(
    () =>
      localFiles.map((f, i) => ({
        id: `local-${i}-${f.name}`,
        name: f.name,
        status: "ready" as const,
        size: f.size,
        progress: 100,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
        mimeType: f.type.startsWith("image/") ? f.type : undefined,
        pending: true,
      })),
    [localFiles],
  );
  // Revoke object URLs when the chip set churns to keep memory bounded.
  // We can't derive this — URL.revokeObjectURL is a browser-side side effect
  // that must happen when the item leaves the set, not during render.
  // eslint-disable-next-line no-restricted-syntax -- browser API cleanup tied to item lifetime
  useEffect(() => {
    const items = localUploadItems;
    return () => {
      for (const item of items) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, [localUploadItems]);

  const displayUploads = isOverlay ? localUploadItems : sessionUpload.uploads;
  const allUploads = isOverlay ? localUploadItems : allSessionUploads;

  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (isOverlay) {
        setLocalFiles((prev) => [...prev, ...files]);
      } else {
        void sessionUpload.uploadFiles(files);
      }
    },
    [isOverlay, sessionUpload],
  );

  const handleRemoveUploadChip = useCallback(
    (index: number) => {
      if (isOverlay) {
        setLocalFiles((prev) => prev.filter((_, i) => i !== index));
      } else {
        sessionUpload.removeUpload(index);
      }
    },
    [isOverlay, sessionUpload],
  );

  const handleRetryUploadChip = useCallback(
    (index: number) => {
      if (!isOverlay) sessionUpload.retryUpload(index);
      // Overlay-mode retry is a no-op — local items never enter an error state.
    },
    [isOverlay, sessionUpload],
  );

  // ── Voice dictation (docs/144) ───────────────────────────────────────────
  // Mode A wires into the chat MessageInput; Mode B into the overlay's. The
  // hook is mode-agnostic — it produces a cleaned transcript and we splice it
  // into `text`. There is no path from here to a send action: the textarea
  // always gets the words, the user always presses Send.
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const voiceHotkeyModeA = useSettingsStore((s) => s.voiceHotkeyModeA);
  const voiceHotkeyModeB = useSettingsStore((s) => s.voiceHotkeyModeB);
  const quickCaptureAutoMic = useUiStore((s) => s.quickCaptureAutoMic);

  const voice = useVoiceInput({
    enabled: voiceInputEnabled,
    hotkey: isOverlay ? voiceHotkeyModeB : voiceHotkeyModeA,
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,
    // Distinct ids so a session switch aborts a chat recording; the overlay
    // is its own short-lived surface and never "switches" underneath itself.
    sessionId: isOverlay ? "overlay" : sessionId,
  });

  // The single transcript→textarea splice. Cursor/selection come from the
  // live textarea so dictation stitches into partially-typed text.
  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return voice.onTranscript((transcript) => {
      const ta = textareaRef.current;
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
  }, [voice.onTranscript]);

  // Mode B: when the overlay was opened via the voice hotkey, auto-start mic.
  // eslint-disable-next-line no-restricted-syntax -- one-shot auto-start on overlay open
  useEffect(() => {
    if (!isOverlay) return;
    if (quickCaptureAutoMic && voiceInputEnabled) {
      voice.startRecording();
      useUiStore.getState().setQuickCaptureAutoMic(false);
    }
  }, [isOverlay, quickCaptureAutoMic, voiceInputEnabled]);

  // Per-session draft persistence: remember what the user has typed when they
  // switch to a different session, and recover it when they switch back. Keyed
  // off `focusKey`, which is the session identity from this component's POV
  // ("new" for the new-session view, or the real session ID otherwise). We
  // detect focusKey changes during render — same pattern as the focus logic
  // below — so the swap is synchronous and doesn't flicker the previous text
  // into view for one frame. Saves on every keystroke as well (via the effect
  // further down) so the draft also survives reloads, not just session swaps.
  //
  // Skipped for the overlay surface: the quick-capture overlay is a fresh
  // "new session" launcher, not a per-session composer — restoring whatever
  // the user last typed there on each open is surprising rather than helpful.
  const persistDraft = surface !== "overlay";
  const draftFocusKeyRef = useRef<string | undefined>(undefined);
  if (persistDraft && focusKey !== draftFocusKeyRef.current) {
    // Persist the *previous* session's text under its key before swapping in
    // the new session's draft. `text` here is still the previous session's
    // value because state updates from this branch haven't applied yet.
    if (draftFocusKeyRef.current) {
      saveDraftMessage(draftFocusKeyRef.current, text);
    }
    draftFocusKeyRef.current = focusKey;
    const loaded = focusKey ? getSavedDraftMessage(focusKey) ?? "" : "";
    if (loaded !== text) setText(loaded);
  }

  // Fallback auto-grow for browsers without `field-sizing: content` support
  // (most notably Firefox on Android). On supported browsers the CSS does
  // this natively, so we short-circuit. The max-height cap stays on the
  // element via Tailwind's `max-h-[40vh]` and is honored by both paths.
  useLayoutEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const ta = textareaRef.current;
    if (!ta) return;
    // Collapse first so scrollHeight reflects the content height, not the
    // previously-set inline height (otherwise the textarea would only ever
    // grow, never shrink when the user deletes text).
    ta.style.height = "auto";
    const next = ta.scrollHeight;
    if (next > 0) ta.style.height = `${next}px`;
  }, [text]);

  // Mirror text into localStorage so the draft also survives a tab refresh.
  // Declared AFTER the prefill effect below in mount-time effect ordering so
  // a freshly-consumed prefill is what gets persisted (not the empty default).
  // eslint-disable-next-line no-restricted-syntax -- per-session draft persistence
  useEffect(() => {
    if (persistDraft && focusKey) saveDraftMessage(focusKey, text);
  }, [text, focusKey, persistDraft]);

  // Consume prefill text from store (e.g. "Start Session" from docs viewer, "Send to Agent" from services panel)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (prefill: string | undefined) => {
      if (!prefill) return;
      setText(prefill);
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
  }, [surface]);

  // SHI-10 — consume a quote-reply blockquote from the store and *append* it to
  // the current draft (unlike prefill, which replaces). This lets the user
  // quote a passage from a chat bubble without losing what they've already
  // typed. We focus the textarea and drop the cursor on the trailing blank line
  // below the quote so they can start typing their reply immediately.
  // eslint-disable-next-line no-restricted-syntax -- consume quote-reply text from external store
  useEffect(() => {
    if (surface === "overlay") return undefined;
    const consume = (quote: string | undefined) => {
      if (!quote) return;
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
  }, [surface]);

  // Auto-focus textarea on mount and on session change (e.g. "New Session" click,
  // session switch). The ref is intentionally seeded with `undefined` (not `focusKey`)
  // so the very first render with a defined focusKey triggers focus — otherwise focus
  // would be deferred until claimSession() resolves and focusKey transitions from
  // "new" to the real session ID, which causes a visible delay on "New Session" clicks.
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

  // Guard against iframe focus theft: when the textarea is focused and an iframe
  // (e.g. preview loading) steals focus, the textarea fires a blur event with no
  // relatedTarget (cross-origin iframes don't expose it). Reclaim focus in that case
  // ONLY — never reclaim when activeElement is <body>, because that's the normal
  // result of the user mousedown-ing on a non-focusable element (e.g. chat text)
  // to start a text selection. Reclaiming on body-blur would refocus the textarea
  // mid-drag and cancel the in-progress selection — see issue: text in conversation
  // wasn't selectable while the textarea was focused.
  //
  // ALSO never reclaim when the focus loss followed a user click on an iframe
  // — that's the user intentionally clicking the preview (e.g. to play a WebGL/
  // Canvas game where the canvas doesn't itself take focus). Reclaiming there
  // means subsequent keystrokes type into this textarea instead of reaching the
  // game. We track the most-recent iframe pointerdown via a capture-phase
  // listener on the document.
  const lastIframePointerDownRef = useRef(0);
  // eslint-disable-next-line no-restricted-syntax -- global listener for iframe-click detection
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.tagName === "IFRAME") {
        lastIframePointerDownRef.current = Date.now();
      }
    };
    // Capture phase so we see the event even if the iframe stops propagation.
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, []);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    // relatedTarget is set when focus moves to another focusable element in the
    // same document (e.g. a button click). When an iframe steals focus, or when
    // mousedown happens on a non-focusable element, relatedTarget is null — we
    // need the activeElement check below to disambiguate those two cases.
    if (e.relatedTarget) return;
    requestAnimationFrame(() => {
      // Only reclaim if focus actually went to an iframe. Body becoming the
      // active element means the user clicked outside any focusable widget
      // (typically to start a text selection); leave focus alone there.
      const active = document.activeElement;
      if (active?.tagName !== "IFRAME") return;
      // User just clicked the iframe → leave focus in the iframe so keystrokes
      // reach the preview (canvas/WebGL games, embedded apps, etc.).
      if (Date.now() - lastIframePointerDownRef.current < 500) return;
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
    if (!trimmed || disabled) return;
    const uploadRefs = isOverlay ? [] : sessionUpload.getUploadRefs();
    const payload: SendPayload = {
      text: trimmed,
      uploadRefs,
      uploads: displayUploads,
      deferredFiles: isOverlay ? localFiles : [],
    };
    onSend(payload);
    setText("");
    if (isOverlay) {
      setLocalFiles([]);
    } else {
      sessionUpload.clearUploads();
    }
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

  // docs/179 — ShipIt-native `/` commands offered in the `/` menu, gated by the
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
    [addFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (dragCountRef.current === 1) {
      setIsDragging(true);
    }
  }, []);

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
    [addFiles, onAddFile],
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
          <textarea
            ref={textareaRef}
            data-chat-input
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onPaste={handlePaste}
            placeholder="Describe what to build... (type @ to attach files)"
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none field-sizing-content max-h-[40vh] overflow-y-auto"
          />

          {/* Toolbar row — below textarea.
              Desktop keeps the conventional split (add/mic/mode on the left,
              cost/model/send on the right) to match Claude Code and other
              desktop chat UIs. On mobile the order is swapped via CSS `order`
              so the frequently-tapped mic + send sit together as large thumb
              targets on the right, and the rarely-tapped add/mode/cost/model
              pack to the left (docs/144). The numeric `order` values leave gaps
              so items can be inserted later without renumbering. */}
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Add files button — always enabled. Files attached before a
                session is ready are buffered by useFileUpload and uploaded
                once sessionId resolves. */}
            <div className="flex items-center shrink-0" style={{ order: 10 }}>
            <WithTooltip label="Add files">
            <button
              onClick={handleAttachClick}
              className="flex items-center justify-center shrink-0 rounded-lg p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
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
            {voiceInputEnabled && (
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
            {voiceInputEnabled && isMobile && <MobileRecordingOverlay voice={voice} />}

            {/* Permission mode selector (3-state, agent-aware — docs/138) */}
            {onPermissionModeChange && (
              <div className="flex items-center shrink-0" style={{ order: isMobile ? 20 : 30 }}>
                <PermissionModeSelector
                  mode={permissionMode}
                  onChange={onPermissionModeChange}
                  agents={agents}
                  activeAgentId={activeAgentId}
                  modelInfo={modelInfo}
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
            {surface === "chat" && (modelInfo ?? contextTokens > 0) && (
              <div className="flex items-center shrink-0" style={{ order: isMobile ? 30 : 50 }}>
                <ContextDialMount
                  modelInfo={modelInfo ?? null}
                  contextTokensFallback={contextTokens}
                  onOpenUsageDetails={onOpenUsageDetails}
                />
              </div>
            )}

            {/* Model / agent selector */}
            {onAgentChange && (
              <div className="flex items-center shrink-0" style={{ order: isMobile ? 40 : 60 }}>
                <ModelAgentSelector
                  agents={agents}
                  activeAgentId={activeAgentId}
                  onAgentChange={onAgentChange}
                  onModelChange={onModelChange}
                  modelInfo={modelInfo ?? null}
                  hasActiveSession={hasActiveSession}
                  disabled={disabled || isLoading}
                />
              </div>
            )}

            {/* Send / Stop button — pinned right (order 80) with a small gap
                from the item before it. On mobile the icon (MD) and hit area
                (≥44px) grow to match the bottom-bar thumb targets; desktop
                stays compact (docs/144). */}
            <div className="flex items-center gap-1 shrink-0 ml-1" style={{ order: 80 }}>
            {isLoading && onInterrupt ? (
              <>
                <WithTooltip label="Stop (Esc)">
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
                    disabled={disabled || !text.trim()}
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
                disabled={disabled || !text.trim()}
                className={`flex items-center justify-center shrink-0 rounded-lg ${isMobile ? "p-3 min-h-11 min-w-11" : "p-2"} bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                aria-label="Send message"
                data-testid="send-button"
              >
                <ArrowUpIcon size={isMobile ? ICON_SIZE.MD : ICON_SIZE.SM} weight="bold" />
              </button>
            )}
            </div>
          </div>

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

/** Stable empty fallback so the zustand selector never returns a fresh array. */
const EMPTY_TURN_USAGE: never[] = [];

/**
 * Pulls the per-turn usage history for the active session out of the session
 * store and feeds it to `ContextDial`. Kept as a tiny inner component so the
 * subscription cost only attaches when the dial is mounted.
 */
function ContextDialMount({
  modelInfo,
  contextTokensFallback,
  onOpenUsageDetails,
}: {
  modelInfo: ModelInfo | null;
  contextTokensFallback: number;
  onOpenUsageDetails?: () => void;
}) {
  // Two separate selector subscriptions, each returning a stable reference,
  // so React's `useSyncExternalStore` snapshot stays cached across renders.
  // (Combining into one object would create a fresh object every render.)
  const sessionId = useSessionStore((s) => s.sessionId);
  const turnUsage = useSessionStore((s) =>
    sessionId ? s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE : EMPTY_TURN_USAGE,
  );
  // docs/179 — authoritative "compacted recently" signal: a compaction card
  // present after the last user message. Self-clearing — a new user message
  // moves the boundary past the card. Drives the dial's compacted pill, with
  // ContextDial's `wasCompacted` heuristic as the fallback.
  const authoritativeCompacted = useSessionStore((s) => {
    let lastUserIndex = -1;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === "user") { lastUserIndex = i; break; }
    }
    for (let i = s.messages.length - 1; i > lastUserIndex; i--) {
      if (s.messages[i].compaction) return true;
    }
    return false;
  });
  // Authoritative session totals so the popover's "Total cost" row matches
  // the value shown in `UsageModal` rather than summing live-only turns.
  const sessionTotalCostUsd = useUiStore((s) => s.currentSessionUsage?.totalCostUsd);
  const cumulativeInputTokens = useUiStore((s) => s.cumulativeInputTokens);
  const cumulativeOutputTokens = useUiStore((s) => s.cumulativeOutputTokens);
  return (
    <ContextDial
      modelInfo={modelInfo}
      turnUsage={turnUsage}
      contextTokensOverride={turnUsage.length > 0 ? undefined : contextTokensFallback}
      sessionTotalCostUsd={sessionTotalCostUsd ?? undefined}
      cumulativeInputTokens={cumulativeInputTokens}
      cumulativeOutputTokens={cumulativeOutputTokens}
      onOpenUsageDetails={onOpenUsageDetails}
      authoritativeCompacted={authoritativeCompacted}
    />
  );
}
