// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { PlusIcon, StopIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { PlanModeToggle } from "./PlanModeToggle.js";
import { ModelAgentSelector } from "./ModelAgentSelector.js";
import { ContextDial } from "./ContextDial.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import { Popover, PopoverAnchor } from "./ui/popover.js";
import { WithTooltip } from "./ui/tooltip.js";
import type { PermissionMode, FileTreeNode, AgentId } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";
import type { AgentOption } from "./AgentPicker.js";
import type { ModelInfo } from "./StatusBar.js";

export function MessageInput({
  onSend,
  disabled,
  isLoading = false,
  onInterrupt,
  permissionMode = "auto",
  onPermissionModeChange,
  onAddFile,
  fileTree = [],
  allUploads,
  onUploadFiles,
  agents = [],
  activeAgentId = "claude",
  onAgentChange,
  onModelChange,
  modelInfo,
  contextTokens = 0,
  hasActiveSession = false,
  sessionCostUsd = null,
  onCostBadgeClick,
  focusKey,
  hasPrCard = false,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  isLoading?: boolean;
  onInterrupt?: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onAddFile?: (filePath: string) => void;
  fileTree?: FileTreeNode[];
  /** All session uploads — for @-autocomplete (persists across sends). */
  allUploads?: UploadItem[];
  onUploadFiles?: (files: File[]) => void;
  agents?: AgentOption[];
  activeAgentId?: AgentId;
  onAgentChange?: (agentId: AgentId) => void;
  onModelChange?: (model: string) => void;
  modelInfo?: ModelInfo | null;
  contextTokens?: number;
  hasActiveSession?: boolean;
  /**
   * Total session cost in USD. Rendered as a clickable badge in the toolbar
   * when > 0 and the user hasn't disabled the badge in settings. `null` while
   * the first usage_update for the session is pending.
   */
  sessionCostUsd?: number | null;
  /** Click handler for the cost badge — typically opens the usage modal. */
  onCostBadgeClick?: () => void;
  /** Changed value triggers textarea focus (e.g. session ID or route change). */
  focusKey?: string;
  /** When true, only round bottom corners (PR card provides the top). */
  hasPrCard?: boolean;
}) {
  const showSessionCost = useSettingsStore((s) => s.showSessionCost);
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

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
  const prevFocusKeyRef = useRef<string | undefined>(undefined);
  if (focusKey && focusKey !== prevFocusKeyRef.current) {
    prevFocusKeyRef.current = focusKey;
    // Schedule focus after paint — safe to call during render since it's a microtask
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  // Guard against iframe focus theft: when the textarea is focused and an iframe
  // (e.g. preview loading) steals focus, the textarea fires a blur event with no
  // relatedTarget (cross-origin iframes don't expose it). Reclaim focus in that case
  // ONLY — never reclaim when activeElement is <body>, because that's the normal
  // result of the user mousedown-ing on a non-focusable element (e.g. chat text)
  // to start a text selection. Reclaiming on body-blur would refocus the textarea
  // mid-drag and cancel the in-progress selection — see issue: text in conversation
  // wasn't selectable while the textarea was focused.
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
      if (active?.tagName === "IFRAME") {
        textareaRef.current?.focus();
      }
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
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't handle Enter/Escape if autocomplete is open — let it handle them
    if (showAutoComplete) return;
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

    // Detect @ trigger for file autocomplete
    if (onAddFile && fileTree.length > 0) {
      const cursorPos = e.target.selectionStart ?? newText.length;
      const textBeforeCursor = newText.slice(0, cursorPos);

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

      <Popover open={showAutoComplete} modal={false}>
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
          {/* Textarea — full width on top */}
          <textarea
            ref={textareaRef}
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

            {/* Plan mode toggle */}
            {onPermissionModeChange && (
              <PlanModeToggle
                mode={permissionMode}
                onChange={onPermissionModeChange}
              />
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Session cost badge — only when enabled in settings and we have a non-zero cost */}
            {showSessionCost && sessionCostUsd !== null && sessionCostUsd > 0 && (
              <WithTooltip label="View usage details">
              <button
                onClick={onCostBadgeClick}
                className="inline-flex items-center text-xs px-2 py-0.5 mr-1 rounded-full bg-(--color-accent-subtle) text-(--color-accent) hover:bg-(--color-accent) hover:text-(--color-accent-text) transition-colors cursor-pointer"
                aria-label="Session cost"
                data-testid="session-cost-badge"
              >
                {sessionCostUsd < 0.01 ? `$${sessionCostUsd.toFixed(3)}` : `$${sessionCostUsd.toFixed(2)}`}
              </button>
              </WithTooltip>
            )}

            {/* Context dial — per-turn breakdown popover (105) */}
            {(modelInfo ?? contextTokens > 0) && (
              <ContextDialMount
                modelInfo={modelInfo ?? null}
                contextTokensFallback={contextTokens}
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
              <WithTooltip label="Stop (Esc)">
              <button
                onClick={onInterrupt}
                className="flex items-center justify-center shrink-0 rounded-lg p-2 bg-(--color-error) text-white hover:brightness-110 transition-colors"
                aria-label="Stop Claude"
                data-testid="stop-button"
              >
                <StopIcon size={ICON_SIZE.SM} weight="fill" />
              </button>
              </WithTooltip>
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
          uploadPaths={(allUploads ?? []).filter((u) => u.status === "ready" && u.path).map((u) => u.path!)}
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
}: {
  modelInfo: ModelInfo | null;
  contextTokensFallback: number;
}) {
  // Two separate selector subscriptions, each returning a stable reference,
  // so React's `useSyncExternalStore` snapshot stays cached across renders.
  // (Combining into one object would create a fresh object every render.)
  const sessionId = useSessionStore((s) => s.sessionId);
  const turnUsage = useSessionStore((s) =>
    sessionId ? s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE : EMPTY_TURN_USAGE,
  );
  return (
    <ContextDial
      modelInfo={modelInfo}
      turnUsage={turnUsage}
      contextTokensOverride={turnUsage.length > 0 ? undefined : contextTokensFallback}
    />
  );
}
