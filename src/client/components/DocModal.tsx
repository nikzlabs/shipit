// eslint-disable-next-line no-restricted-imports -- useEffect: Escape keydown listener (browser API subscription with cleanup)
import { useMemo, useEffect } from "react";
import { marked } from "marked";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Modal } from "./ui/modal.js";
import { Button } from "./ui/button.js";

export interface DocModalProps {
  filePath: string;
  content: string | null;
  isTracked?: boolean;
  onStartSession?: () => void;
  onClose: () => void;
}

export function DocModal({ filePath, content, isTracked, onStartSession, onClose }: DocModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const renderedHtml = useMemo(() => {
    if (!content) return "";
    return marked.parse(content, { async: false });
  }, [content]);

  return (
    <Modal onClose={onClose} className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-(--color-border-secondary) shrink-0">
        <h2 className="text-sm font-medium text-(--color-text-primary) truncate">{filePath}</h2>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          {isTracked && onStartSession && (
            <Button variant="primary" size="sm" onClick={onStartSession}>
              Start Session
            </Button>
          )}
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
        ) : (
          <div
            className="prose dark:prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
    </Modal>
  );
}
