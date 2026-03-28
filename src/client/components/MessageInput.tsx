// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { PlusIcon, StopIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { PlanModeToggle } from "./PlanModeToggle.js";
import { ModelAgentSelector } from "./ModelAgentSelector.js";
import { ContextMeterIcon } from "./ContextMeterIcon.js";
import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileUploadChips } from "./FileUploadChips.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import type { PermissionMode, FileContextRef, FileTreeNode, AgentId } from "../../server/shared/types.js";
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
  pendingFiles = [],
  onRemoveFile,
  onAddFile,
  fileTree = [],
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
  focusKey,
  hasPrCard = false,
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
  /** Changed value triggers textarea focus (e.g. session ID or route change). */
  focusKey?: string;
  /** When true, only round bottom corners (PR card provides the top). */
  hasPrCard?: boolean;
}) {
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

  // Auto-focus textarea on session change (e.g. "New Session" click, session switch)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (focusKey) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [focusKey]);

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

      {/* File attachment chips */}
      {pendingFiles.length > 0 && onRemoveFile && (
        <div className="mb-2">
          <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
        </div>
      )}

      {/* Upload chips */}
      {uploads.length > 0 && onRemoveUpload && onRetryUpload && (
        <div className="mb-2">
          <FileUploadChips uploads={uploads} onRemove={onRemoveUpload} onRetry={onRetryUpload} />
        </div>
      )}

      <div className="relative">
        {/* @ autocomplete popup */}
        {showAutoComplete && (
          <FileAutoComplete
            query={autoCompleteQuery}
            fileTree={fileTree}
            onSelect={handleAutoCompleteSelect}
            onDismiss={handleAutoCompleteDismiss}
            uploadPaths={(allUploads ?? uploads).filter((u) => u.status === "ready" && u.path).map((u) => u.path!)}
          />
        )}

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
            onPaste={handlePaste}
            placeholder="Describe what to build... (type @ to attach files)"
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none field-sizing-content"
          />

          {/* Toolbar row — below textarea */}
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Add files button */}
            <button
              onClick={handleAttachClick}
              disabled={disabled}
              className="flex items-center justify-center shrink-0 rounded-lg p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Add files"
              aria-label="Add files"
            >
              <PlusIcon size={ICON_SIZE.SM} />
            </button>

            {/* Plan mode toggle */}
            {onPermissionModeChange && (
              <PlanModeToggle
                mode={permissionMode}
                onChange={onPermissionModeChange}
                disabled={disabled}
              />
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Context meter */}
            {modelInfo && contextTokens > 0 && (
              <ContextMeterIcon modelInfo={modelInfo} contextTokens={contextTokens} />
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
              <button
                onClick={onInterrupt}
                className="flex items-center justify-center shrink-0 rounded-lg p-2 bg-(--color-error) text-white hover:brightness-110 transition-colors"
                title="Stop (Esc)"
                aria-label="Stop Claude"
                data-testid="stop-button"
              >
                <StopIcon size={ICON_SIZE.SM} weight="fill" />
              </button>
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
    </div>
  );
}
