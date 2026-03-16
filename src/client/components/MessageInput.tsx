// eslint-disable-next-line no-restricted-imports -- useEffect: consume prefill text from external store on mount
import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { PaperclipIcon, StopIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { ModeSelector } from "./ModeSelector.js";
import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileUploadChips } from "./FileUploadChips.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import { Button } from "./ui/button.js";
import type { PermissionMode, FileContextRef, FileTreeNode } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";

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
}) {
  const [text, setText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

  // Consume prefill text from store (e.g. "Start Session" from docs viewer)
  useEffect(() => {
    const prefill = useSessionStore.getState().prefillText;
    if (prefill) {
      setText(prefill);
      useSessionStore.getState().setPrefillText(undefined);
      // Focus and move cursor to end
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(prefill.length, prefill.length);
        }
      });
    }
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
      className="border-t border-(--color-border-primary) px-3 sm:px-6 py-3 sm:py-4 relative"
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
        <div className="mb-2 max-w-3xl mx-auto">
          <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
        </div>
      )}

      {/* Upload chips */}
      {uploads.length > 0 && onRemoveUpload && onRetryUpload && (
        <div className="mb-2 max-w-3xl mx-auto">
          <FileUploadChips uploads={uploads} onRemove={onRemoveUpload} onRetry={onRetryUpload} />
        </div>
      )}

      {onPermissionModeChange && (
        <div className="flex items-center mb-2 max-w-3xl mx-auto">
          <ModeSelector
            mode={permissionMode}
            onChange={onPermissionModeChange}
            disabled={disabled}
          />
        </div>
      )}

      <div className="flex items-end gap-2 sm:gap-3 max-w-3xl mx-auto relative">
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

        {/* Attach file button */}
        <Button
          variant="secondary"
          size="md"
          onClick={handleAttachClick}
          disabled={disabled}
          className="rounded-lg px-3 py-3"
          title="Attach file"
          aria-label="Attach file"
        >
          <PaperclipIcon size={ICON_SIZE.MD} />
        </Button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Describe what to build... (type @ to attach files)"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-2 focus:ring-(--color-accent) disabled:opacity-50 field-sizing-content"
        />
        {isLoading && onInterrupt ? (
          <Button
            variant="destructive"
            size="md"
            onClick={onInterrupt}
            className="rounded-lg px-4 py-3"
            title="Stop (Esc)"
            aria-label="Stop Claude"
            data-testid="stop-button"
          >
            <StopIcon size={ICON_SIZE.SM} weight="fill" />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={disabled || !text.trim()}
            className="rounded-lg px-4 py-3"
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
