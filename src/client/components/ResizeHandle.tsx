/**
 * Vertical drag handle — invisible 8px hit area overlaid on the panel border.
 * Uses -ml-2 to sit fully over the adjacent border-r.
 * col-resize cursor on hover to indicate draggability.
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
      className={`resize-handle shrink-0 -ml-2 ${isDragging ? "resize-handle--active" : ""}`}
    />
  );
}
