import { useState, useRef, useCallback } from "react";
import { ModeSelector } from "./ModeSelector.js";
import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileAutoComplete } from "./FileAutoComplete.js";
import type { PermissionMode, FileContextRef, FileTreeNode } from "../../server/shared/types.js";

export interface ImagePreview {
  data: string;       // base64-encoded
  mediaType: string;  // "image/png", etc.
  filename: string;
  previewUrl: string; // object URL for thumbnail display
}

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGES = 5;

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
}: {
  onSend: (text: string, images?: Array<{ data: string; mediaType: string; filename: string }>) => void;
  disabled: boolean;
  isLoading?: boolean;
  onInterrupt?: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  pendingFiles?: FileContextRef[];
  onRemoveFile?: (index: number) => void;
  onAddFile?: (filePath: string) => void;
  fileTree?: FileTreeNode[];
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImagePreview[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [showAutoComplete, setShowAutoComplete] = useState(false);
  const [autoCompleteQuery, setAutoCompleteQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCountRef = useRef(0);

  const clearImageError = useCallback(() => {
    setImageError(null);
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      clearImageError();
      const fileArray = Array.from(files);

      for (const file of fileArray) {
        if (!ALLOWED_TYPES.has(file.type)) {
          setImageError(`"${file.name}" is not a supported image type. Use PNG, JPEG, GIF, or WebP.`);
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          setImageError(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`);
          continue;
        }

        setImages((prev) => {
          if (prev.length >= MAX_IMAGES) {
            setImageError(`Maximum ${MAX_IMAGES} images per message.`);
            return prev;
          }

          const reader = new FileReader();
          reader.onload = () => {
            const base64Full = reader.result as string;
            // Strip the data:image/...;base64, prefix
            const base64 = base64Full.split(",")[1] ?? "";
            const previewUrl = URL.createObjectURL(file);
            setImages((current) => {
              if (current.length >= MAX_IMAGES) return current;
              return [
                ...current,
                {
                  data: base64,
                  mediaType: file.type,
                  filename: file.name,
                  previewUrl,
                },
              ];
            });
          };
          reader.readAsDataURL(file);
          return prev;
        });
      }
    },
    [clearImageError],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    const imagePayload = images.length > 0
      ? images.map((img) => ({ data: img.data, mediaType: img.mediaType, filename: img.filename }))
      : undefined;
    onSend(trimmed, imagePayload);
    // Revoke all object URLs
    for (const img of images) {
      URL.revokeObjectURL(img.previewUrl);
    }
    setText("");
    setImages([]);
    setImageError(null);
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
      const atMatch = textBeforeCursor.match(/(?:^|[^a-zA-Z0-9])@([^\s]*)$/);
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
      const atMatch = textBeforeCursor.match(/(?:^|[^a-zA-Z0-9])@([^\s]*)$/);
      if (atMatch) {
        const startIdx = textBeforeCursor.lastIndexOf("@" + atMatch[1]);
        const newText = text.slice(0, startIdx) + "@" + filePath + " " + text.slice(cursorPos);
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
          const { path } = JSON.parse(fileData);
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
      className="border-t border-gray-200 dark:border-gray-800 px-3 sm:px-6 py-3 sm:py-4 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg pointer-events-none">
          <span className="text-blue-400 text-sm font-medium">Drop file or image here</span>
        </div>
      )}

      {/* Image error toast */}
      {imageError && (
        <div className="flex items-center gap-2 mb-2 text-xs text-red-400 max-w-3xl mx-auto">
          <span>{imageError}</span>
          <button onClick={clearImageError} className="text-red-400 hover:text-red-300 ml-auto">&times;</button>
        </div>
      )}

      {/* File attachment chips */}
      {pendingFiles.length > 0 && onRemoveFile && (
        <div className="mb-2 max-w-3xl mx-auto">
          <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
        </div>
      )}

      {/* Image thumbnails */}
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 max-w-3xl mx-auto flex-wrap" data-testid="image-thumbnails">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={img.previewUrl}
                alt={img.filename}
                className="w-16 h-16 object-cover rounded-md border border-gray-300 dark:border-gray-700"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={`Remove ${img.filename}`}
                title={`Remove ${img.filename}`}
              >
                &times;
              </button>
            </div>
          ))}
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
          />
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
          data-testid="file-input"
        />

        {/* Attach image button */}
        <button
          onClick={handleAttachClick}
          disabled={disabled || images.length >= MAX_IMAGES}
          className="rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Attach image"
          aria-label="Attach image"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Describe what to build... (type @ to attach files)"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 field-sizing-content"
        />
        {isLoading && onInterrupt ? (
          <button
            onClick={onInterrupt}
            className="rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-500 transition-colors"
            title="Stop (Esc)"
            aria-label="Stop Claude"
            data-testid="stop-button"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={disabled || (!text.trim() && images.length === 0)}
            className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
