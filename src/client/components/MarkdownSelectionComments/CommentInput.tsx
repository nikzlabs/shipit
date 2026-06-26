// eslint-disable-next-line no-restricted-imports -- useEffect: focus the textarea on mount and subscribe to Escape keydown
import { useState, useCallback, useEffect, useRef } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { Button } from "../ui/button.js";

export function CommentInput({
  onSubmit,
  onCancel,
  initialText,
  quotedText,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
  quotedText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on mount without the browser scrolling it into view.
  // The new-comment input renders at the bottom of the document, so the native
  // `autoFocus` attribute would jump the scroll position to the bottom and lose
  // the user's place. `focus({ preventScroll: true })` focuses in place.
  // eslint-disable-next-line no-restricted-syntax -- focus the input without auto-scroll
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  useEventListener(window, "keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }
    },
    [text, onSubmit],
  );

  return (
    <div className="mt-2 mb-3 ml-4 border border-(--color-border-secondary) rounded-lg bg-(--color-bg-secondary) p-3">
      {quotedText && (
        <blockquote className="mb-2 border-l-2 border-(--color-border-secondary) pl-2 text-xs text-(--color-text-secondary) italic line-clamp-3">
          {quotedText}
        </blockquote>
      )}
      <textarea
        ref={textareaRef}
        className="w-full bg-transparent text-sm text-(--color-text-primary) outline-none resize-none min-h-[60px] placeholder:text-(--color-text-tertiary)"
        placeholder="Add a comment... (Cmd+Enter to submit, Escape to cancel)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => { if (text.trim()) onSubmit(text.trim()); }}
          disabled={!text.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
