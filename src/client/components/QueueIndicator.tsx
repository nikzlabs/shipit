interface QueueItem {
  text: string;
  position: number;
}

interface QueueIndicatorProps {
  queue: QueueItem[];
  onCancel: (position: number | "all") => void;
}

/**
 * Shows the current prompt queue below the chat and above the input.
 * Displays a count badge with each queued item's truncated text,
 * and lets the user cancel individual items or clear the whole queue.
 */
export function QueueIndicator({ queue, onCancel }: QueueIndicatorProps) {
  if (queue.length === 0) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-2 bg-gray-50 dark:bg-gray-900/50">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
          <svg className="w-3 h-3 animate-pulse text-blue-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
          </svg>
          {queue.length === 1 ? "1 message queued" : `${queue.length} messages queued`}
        </span>
        <button
          onClick={() => onCancel("all")}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          aria-label="Clear all queued messages"
        >
          Clear all
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {queue.map((item) => (
          <div
            key={item.position}
            className="flex items-center gap-2 group"
          >
            <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
              {item.position}
            </span>
            <span className="flex-1 text-xs text-gray-600 dark:text-gray-400 truncate">
              {item.text.length > 80 ? item.text.slice(0, 80) + "…" : item.text}
            </span>
            <button
              onClick={() => onCancel(item.position - 1)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-all"
              aria-label={`Cancel queued message ${item.position}`}
              title="Cancel this queued message"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
