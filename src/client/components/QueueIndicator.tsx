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
    <div className="border-t border-(--color-border-primary) px-4 py-2 bg-(--color-bg-secondary)">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-(--color-text-secondary) flex items-center gap-1.5">
          <svg className="w-3 h-3 animate-pulse text-(--color-accent)" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
          </svg>
          {queue.length === 1 ? "1 message queued" : `${queue.length} messages queued`}
        </span>
        <button
          onClick={() => onCancel("all")}
          className="text-xs text-(--color-text-secondary) hover:text-(--color-error) transition-colors"
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
            <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-(--color-accent-subtle) text-(--color-text-link)">
              {item.position}
            </span>
            <span className="flex-1 text-xs text-(--color-text-secondary) truncate">
              {item.text.length > 80 ? item.text.slice(0, 80) + "\u2026" : item.text}
            </span>
            <button
              onClick={() => onCancel(item.position - 1)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-(--color-text-tertiary) hover:text-(--color-error) transition-all"
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
