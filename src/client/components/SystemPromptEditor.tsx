import { useState, useEffect, useRef } from "react";

const MAX_LENGTH = 50_000;

interface SystemPromptEditorProps {
  /** Current system prompt content loaded from the server. */
  initialContent: string;
  /** Called when the user clicks Save. */
  onSave: (content: string) => void;
  /** Called when the user closes the modal without saving. */
  onClose: () => void;
}

export function SystemPromptEditor({ initialContent, onSave, onClose }: SystemPromptEditorProps) {
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guard against blur-triggered close firing after save
  const savedRef = useRef(false);

  // Focus the textarea on open
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSave = () => {
    savedRef.current = true;
    onSave(content);
  };

  const handleBackdropClick = () => {
    if (!savedRef.current) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    // Cmd/Ctrl+Enter to save
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
      data-testid="system-prompt-backdrop"
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-lg w-full mx-4 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Project Instructions"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Project Instructions</h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex-1 min-h-0 flex flex-col gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            These instructions are sent to the agent with every message. Use them to define project
            conventions, preferred libraries, or style guidelines.
          </p>

          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
            className="flex-1 min-h-[160px] max-h-[40vh] w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 resize-y focus:outline-none focus:border-blue-500"
            data-testid="system-prompt-textarea"
          />

          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>
              Note: The agent also reads CLAUDE.md from your workspace root automatically.
            </span>
            <span className={isOverLimit ? "text-red-400" : ""}>
              {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-300 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isOverLimit}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="system-prompt-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
