import { useState } from "react";
import { TypingDots, type StreamingActivity } from "./StreamingIndicator.js";

export function MessageInput({
  onSend,
  disabled,
  activity,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  /** When set, Claude is actively working — show status above input. */
  activity?: StreamingActivity;
}) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-800 px-3 sm:px-6 py-3 sm:py-4">
      {/* Activity status bar — shown while Claude is working */}
      {activity && (
        <div className="flex items-center gap-2 mb-2 text-xs text-gray-500 dark:text-gray-400 max-w-3xl mx-auto">
          <TypingDots />
          <span>{activity.label}</span>
        </div>
      )}

      <div className="flex items-end gap-2 sm:gap-3 max-w-3xl mx-auto">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Tell Claude what to build..."
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 field-sizing-content"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
