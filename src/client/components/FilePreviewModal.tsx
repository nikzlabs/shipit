// eslint-disable-next-line no-restricted-imports -- useEffect: Escape keydown listener (browser API subscription with cleanup)
import { useMemo, useEffect } from "react";
import { marked } from "marked";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Modal } from "./ui/modal.js";
import { Button } from "./ui/button.js";
import { highlightCode } from "../utils/syntax-highlight.js";
import type { FilePreviewType } from "../utils/file-preview-type.js";

export interface FilePreviewAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface FilePreviewModalProps {
  filePath: string;
  content: string | null;
  fileType: FilePreviewType;
  actions?: FilePreviewAction[];
  onClose: () => void;
}

export function FilePreviewModal({ filePath, content, fileType, actions, onClose }: FilePreviewModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const renderedHtml = useMemo(() => {
    if (content === null) return "";
    if (fileType === "markdown") {
      return marked.parse(content, { async: false });
    }
    return "";
  }, [content, fileType]);

  const highlightedCode = useMemo(() => {
    if (content === null || fileType !== "code") return "";
    return highlightCode(content, filePath);
  }, [content, fileType, filePath]);

  return (
    <Modal onClose={onClose} className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-(--color-border-secondary) shrink-0">
        <h2 className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>{filePath}</h2>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          {actions?.map((action) => (
            <Button
              key={action.label}
              variant={action.variant === "primary" ? "primary" : "secondary"}
              size="sm"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {content === null ? (
          <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
            Loading...
          </div>
        ) : fileType === "markdown" ? (
          <div
            className="prose dark:prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : fileType === "image" ? (
          <div className="flex items-center justify-center h-full">
            <img
              src={content}
              alt={filePath}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        ) : fileType === "binary" ? (
          <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
            Binary file — cannot display.
          </div>
        ) : (
          <pre className="text-sm leading-relaxed">
            <code
              className="hljs"
              dangerouslySetInnerHTML={{ __html: highlightedCode }}
            />
          </pre>
        )}
      </div>
    </Modal>
  );
}
