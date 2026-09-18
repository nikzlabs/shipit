

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
