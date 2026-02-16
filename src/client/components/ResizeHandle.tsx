/**
 * Vertical drag handle rendered between the left (chat) and right (preview/docs) panels.
 *
 * Visual design:
 *   - 8px wide transparent hit area so it's easy to grab
 *   - 2px visible line centered inside, appearing on hover
 *   - col-resize cursor to indicate draggability
 *   - Highlight color while actively dragging
 */
export function ResizeHandle({
  isDragging,
  onMouseDown,
  onTouchStart,
}: {
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart?: (e: React.TouchEvent) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={`resize-handle group relative flex-shrink-0 ${
        isDragging ? "resize-handle--active" : ""
      }`}
    >
      {/* Visible indicator line */}
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 transition-colors ${
          isDragging
            ? "bg-blue-500"
            : "bg-gray-300 dark:bg-gray-700 group-hover:bg-gray-400 dark:group-hover:bg-gray-500"
        }`}
      />
    </div>
  );
}
