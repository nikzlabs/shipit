// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { PlusIcon, StopIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { PermissionModeSelector } from "./PermissionModeSelector.js";
import { ModelAgentSelector } from "./ModelAgentSelector.js";
import { ContextDial } from "./ContextDial.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import { SkillAutoComplete } from "./SkillAutoComplete.js";
import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileUploadChips } from "./FileUploadChips.js";
import { Popover, PopoverAnchor } from "./ui/popover.js";
import { WithTooltip } from "./ui/tooltip.js";
import { getSavedDraftMessage, saveDraftMessage } from "../utils/local-storage.js";
import type { PermissionMode, FileContextRef, FileTreeNode, AgentId, SkillInfo } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";
import type { AgentOption } from "../agent-types.js";
import type { ModelInfo } from "../utils/model-info.js";

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
  uploads = [],
  allUploads,
  onUploadFiles,
  onRemoveUpload,
  onRetryUpload,
  agents = [],
  activeAgentId = "claude",
  onAgentChange,
  onModelChange,
  modelInfo,
  contextTokens = 0,
  hasActiveSession = false,
  onOpenUsageDetails,
  focusKey,
  hasPrCard = false,
  liveSteeringActive = false,
}: {
  onSend: (text: string) => void;
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
  uploads?: UploadItem[];
  /** All session uploads — for @-autocomplete (persists across sends). */
  allUploads?: UploadItem[];
  onUploadFiles?: (files: File[]) => void;
  onRemoveUpload?: (index: number) => void;
  onRetryUpload?: (index: number) => void;
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
  /** When true, only round bottom corners (PR card provides the top). */
  hasPrCard?: boolean;
  /** When true, show both Stop and Send buttons simultaneously (live steering active). */
  liveSteeringActive?: boolean;
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

  // Per-session draft persistence: remember what the user has typed when they
  // switch to a different session, and recover it when they switch back. Keyed
  // off `focusKey`, which is the session identity from this component's POV
  // ("new" for the new-session view, or the real session ID otherwise). We
  // detect focusKey changes during render — same pattern as the focus logic
  // below — so the swap is synchronous and doesn't flicker the previous text
  // into view for one frame. Saves on every keystroke as well (via the effect
  // further down) so the draft also survives reloads, not just session swaps.
  const draftFocusKeyRef = useRef<string | undefined>(undefined);
  if (focusKey !== draftFocusKeyRef.current) {
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

  // Mirror text into localStorage so the draft also survives a tab refresh.
  // Declared AFTER the prefill effect below in mount-time effect ordering so
  // a freshly-consumed prefill is what gets persisted (not the empty default).
  // eslint-disable-next-line no-restricted-syntax -- per-session draft persistence
  useEffect(() => {
    if (focusKey) saveDraftMessage(focusKey, text);
  }, [text, focusKey]);

  // Consume prefill text from store (e.g. "Start Session" from docs viewer, "Send to Agent" from services panel)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
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
  }, []);

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
  if (focusKey && focusKey !== prevFocusKeyRef.current) {
    prevFocusKeyRef.current = focusKey;
    if (!isMobile) {
      // Schedule focus after paint — safe to call during render since it's a microtask
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }

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
      if (fileArray.length > 0 && onUploadFiles) {
        onUploadFiles(fileArray);
      }
    },
    [onUploadFiles],
  );

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
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
    const slashMatch = /^\/([a-zA-Z0-9._-]*)$/.exec(textBeforeCursor);
    if (slashMatch && skills.length > 0) {
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

  // Codex invokes skills with `$name`, Claude with `/name`. The `/` trigger
  // that opens the menu stays the same for both backends (doc 138 §5) — only
  // the inserted token differs.
  const skillTokenPrefix = activeAgentId === "codex" ? "$" : "/";

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
        <div className={`flex flex-col ${hasPrCard ? "rounded-b-xl" : "rounded-xl"} bg-(--color-bg-secondary) border border-(--color-border-secondary) focus-within:border-(--color-accent)/80 focus-within:ring-1 focus-within:ring-(--color-accent)/80`}>
          {/* Attachment chips — rendered inside the input box, above the
              textarea, so they're visually contained within the input dialog
              rather than floating above it and overlapping the chat history. */}
          {(pendingFiles.length > 0 || uploads.length > 0) && (
            <div className="px-3 pt-3 space-y-2">
              {pendingFiles.length > 0 && onRemoveFile && (
                <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
              )}
              {uploads.length > 0 && onRemoveUpload && onRetryUpload && (
                <FileUploadChips uploads={uploads} onRemove={onRemoveUpload} onRetry={onRetryUpload} />
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

          {/* Toolbar row — below textarea */}
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Add files button — always enabled. Files attached before a
                session is ready are buffered by useFileUpload and uploaded
                once sessionId resolves. */}
            <WithTooltip label="Add files">
            <button
              onClick={handleAttachClick}
              className="flex items-center justify-center shrink-0 rounded-lg p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
              aria-label="Add files"
            >
              <PlusIcon size={ICON_SIZE.SM} />
            </button>
            </WithTooltip>

            {/* Permission mode selector (3-state, agent-aware — docs/138) */}
            {onPermissionModeChange && (
              <PermissionModeSelector
                mode={permissionMode}
                onChange={onPermissionModeChange}
                agents={agents}
                activeAgentId={activeAgentId}
                modelInfo={modelInfo}
              />
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Context dial — per-turn breakdown popover (105). The dial is now
             * also the cost surface: its trigger shows running session cost
             * and its popover row opens the usage modal. The standalone cost
             * pill was removed to eliminate a stale-vs-authoritative
             * discrepancy between the two. */}
            {(modelInfo ?? contextTokens > 0) && (
              <ContextDialMount
                modelInfo={modelInfo ?? null}
                contextTokensFallback={contextTokens}
                onOpenUsageDetails={onOpenUsageDetails}
              />
            )}

            {/* Model / agent selector */}
            {onAgentChange && (
              <ModelAgentSelector
                agents={agents}
                activeAgentId={activeAgentId}
                onAgentChange={onAgentChange}
                onModelChange={onModelChange}
                modelInfo={modelInfo ?? null}
                hasActiveSession={hasActiveSession}
                disabled={disabled || isLoading}
              />
            )}

            {/* Send / Stop button — extra gap from model selector */}
            <div className="w-1" />
            {isLoading && onInterrupt ? (
              <>
                <WithTooltip label="Stop (Esc)">
                <button
                  onClick={onInterrupt}
                  className="flex items-center justify-center shrink-0 rounded-lg p-2 bg-(--color-error) text-white hover:brightness-110 transition-colors"
                  aria-label="Stop the agent"
                  data-testid="stop-button"
                >
                  <StopIcon size={ICON_SIZE.SM} weight="fill" />
                </button>
                </WithTooltip>
                {liveSteeringActive && (
                  <button
                    onClick={handleSubmit}
                    disabled={disabled || !text.trim()}
                    className="flex items-center justify-center shrink-0 rounded-lg p-2 bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Send message"
                    data-testid="send-button"
                  >
                    <ArrowUpIcon size={ICON_SIZE.SM} weight="bold" />
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={disabled || !text.trim()}
                className="flex items-center justify-center shrink-0 rounded-lg p-2 bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Send message"
                data-testid="send-button"
              >
                <ArrowUpIcon size={ICON_SIZE.SM} weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
      </PopoverAnchor>
      {showAutoComplete && (
        <FileAutoComplete
          query={autoCompleteQuery}
          fileTree={fileTree}
          onSelect={handleAutoCompleteSelect}
          onDismiss={handleAutoCompleteDismiss}
          uploadPaths={(allUploads ?? uploads).filter((u) => u.status === "ready" && u.path).map((u) => u.path!)}
        />
      )}
      {showSkillMenu && (
        <SkillAutoComplete
          query={skillQuery}
          skills={skills}
          tokenPrefix={skillTokenPrefix}
          onSelect={handleSkillSelect}
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
    />
  );
}
