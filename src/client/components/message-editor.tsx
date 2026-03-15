import { useState, useRef, useCallback } from "react";
import { Button } from "./ui/button.js";
import { MessageFileAttachments, MessageImages } from "./message-media.js";
import type { ChatMessageImage, ChatMessageFile } from "./MessageList.js";

/** Inline editor for a user message being edited. */
export function MessageEditor({
  initialText,
  images,
  files,
  onSave,
  onCancel,
}: {
  initialText: string;
  images?: ChatMessageImage[];
  files?: ChatMessageFile[];
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus and size textarea on mount via callback ref
  const initRef = useRef(false);
  const setTextareaRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (el && !initRef.current) {
      initRef.current = true;
      el.focus();
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, []);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSave(trimmed);
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <textarea
        ref={setTextareaRef}
        value={text}
        onChange={(e) => { setText(e.target.value); resizeTextarea(); }}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full resize-none rounded-lg bg-(--color-accent) border border-(--color-border-focus) px-4 py-3 text-sm text-(--color-accent-text) placeholder-blue-300 focus:outline-none focus:ring-2 focus:ring-(--color-border-focus)"
      />
      {images && images.length > 0 && (
        <MessageImages images={images} isUserMessage />
      )}
      {files && files.length > 0 && (
        <MessageFileAttachments files={files} />
      )}
      <div className="flex justify-end gap-2 mt-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSave(trimmed);
          }}
          disabled={!text.trim()}
        >
          Save & Send
        </Button>
      </div>
    </div>
  );
}
