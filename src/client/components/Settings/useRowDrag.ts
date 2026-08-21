/**
 * docs/252 req 21 — **the fallback order is changed by dragging a row.**
 *
 * It replaces a pair of carets per row, which cost two controls each and could
 * only ever say "one place up". It also replaces *Make primary*, and that is
 * the point rather than a side effect: "primary" was never a property to set —
 * `isPrimary` is stamped on read from position (`orderCredentialRoutes`,
 * `index === 0`) and the endpoint behind the button was `reorder([this,
 * …rest])`. A button that reorders, sitting beside the controls that reorder,
 * described the same fact twice.
 *
 * Native HTML5 drag events, no library: the list is two to four rows of one
 * line each, in a settings panel, so what a drag library buys — virtualization,
 * nested lists, pointer-sensor tuning, animated reflow — is all cost here.
 *
 * **The reorder endpoint takes the complete set** and rejects a partial one
 * (`reorderCredentialRoutes`), so this hands back the whole order rather than a
 * "move this one" verb. A caller whose list predates a credential added in
 * another tab therefore fails visibly instead of silently demoting that
 * credential to the end.
 */

import { useState, type DragEvent, type HTMLAttributes } from "react";

export interface RowDragProps {
  /** Spread on the row's outer element — it is the drop target. */
  container: HTMLAttributes<HTMLElement>;
  /** Spread on the grip. Only the grip is `draggable`; see {@link useRowDrag}. */
  handle: HTMLAttributes<HTMLElement> & { draggable: true };
  isDragging: boolean;
  isOver: boolean;
}

/**
 * @param ids the group's current order
 * @param onReorder called with the complete new order, once, on a drop that moves something
 * @param disabled while a request from a previous drop is still in flight
 */
export function useRowDrag(
  ids: string[],
  onReorder: (next: string[]) => void,
  disabled = false,
): (id: string) => RowDragProps | undefined {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const drop = (targetId: string): void => {
    const from = ids.indexOf(draggingId ?? "");
    const to = ids.indexOf(targetId);
    setDraggingId(null);
    setOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };

  return (id: string): RowDragProps | undefined => {
    // Below two rows there is no order to change, so there is no grip: a
    // handle that can only ever drop a row back where it started is a control
    // that does nothing, on every single-credential card in the panel.
    if (ids.length < 2 || disabled) return undefined;
    return {
      container: {
        onDragOver: (event: DragEvent) => {
          if (draggingId === null) return;
          // Without this the browser refuses the drop and fires no `drop`
          // event at all — the row springs back and nothing happens.
          event.preventDefault();
          if (overId !== id) setOverId(id);
        },
        onDragLeave: () => { if (overId === id) setOverId(null); },
        onDrop: (event: DragEvent) => { event.preventDefault(); drop(id); },
      },
      handle: {
        draggable: true,
        onDragStart: (event: DragEvent) => {
          setDraggingId(id);
          // Firefox starts no drag at all unless the payload is set, and the
          // effect governs the cursor the user sees over a valid target.
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        },
        onDragEnd: () => { setDraggingId(null); setOverId(null); },
      },
      isDragging: draggingId === id,
      isOver: overId === id && draggingId !== null && draggingId !== id,
    };
  };
}
