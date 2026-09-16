import { Component, type ReactNode, type RefObject } from "react";

interface Props {
  children: ReactNode;
  visibility: string;
  /**
   * docs/303-session-status-card req 30 — the row the status card is rendered
   * after while a turn runs, `null` when it sits at the end. Returning it to
   * the end takes it out from above a reader who has scrolled up, which shifts
   * their content by the card's height unless the reading anchor is restored.
   */
  cardAnchor: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
  canRestoreReadingAnchor: () => boolean;
  /**
   * Whether the card's move must keep the reader's row still. Separate from
   * `canRestoreReadingAnchor` because that one reads the hook's auto-follow
   * flag, which the appended-user-message path sets true without the view
   * being at the bottom — and the card's move changes no height, so nothing
   * re-pins it either. Measured live against the container instead.
   */
  canPreserveAcrossCardMove: () => boolean;
}
interface Snapshot { node: HTMLElement; top: number; allowed: () => boolean }

/**
 * The row the snapshot measured, or the one that replaced it.
 *
 * docs/303 req 30 — the card's boundary splits a row group, so the rows just
 * below the card change DOM parent and React remounts them. The anchor row is
 * one of those, so holding the node alone gives a disconnected element and the
 * restore silently does nothing. Rows keep their id across the re-parent.
 */
function anchorNode(snapshot: Snapshot, root: HTMLElement): HTMLElement | null {
  if (snapshot.node.isConnected) return snapshot.node;
  const id = snapshot.node.id;
  return id ? root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
}

const ROW_ID_PREFIX = "compact-row-";

/**
 * Which row of the visibility string this node is.
 *
 * Not its position in the DOM: docs/303 req 32 renders the card the user has to
 * answer at the END of the conversation whatever its place in the transcript, so
 * document order and row order part company from that row on. The id carries the
 * row, and a node without one falls back to its position.
 */
function rowIndexOf(node: HTMLElement, domIndex: number): number {
  if (!node.id.startsWith(ROW_ID_PREFIX)) return domIndex;
  const parsed = Number(node.id.slice(ROW_ID_PREFIX.length));
  return Number.isInteger(parsed) ? parsed : domIndex;
}

/** A row that is about to change height: hidden ("1"), or tools collapsed ("t"). */
const hasCollapsedRow = (visibility: string) => visibility.includes("1") || visibility.includes("t");

export class CompactLayout extends Component<Props, Record<string, never>, Snapshot | null> {
  private frame: number | undefined;

  componentWillUnmount() {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
  }

  /** The guard for whatever made this update reflow the rows, or null. */
  private guardFor(previous: Props): (() => boolean) | null {
    if (previous.cardAnchor !== this.props.cardAnchor) return this.props.canPreserveAcrossCardMove;
    if (previous.visibility !== this.props.visibility
      && (hasCollapsedRow(previous.visibility) || hasCollapsedRow(this.props.visibility))) {
      return this.props.canRestoreReadingAnchor;
    }
    return null;
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { visibility, containerRef } = this.props;
    const allowed = this.guardFor(previous);
    if (!allowed?.()) return null;
    const root = containerRef.current;
    if (!root) return null;
    const top = root.getBoundingClientRect().top;
    const nodes = root.querySelectorAll<HTMLElement>("[data-compact-content]");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.hidden || visibility[rowIndexOf(node, i)] === "1") continue;
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > top) return { node, top: rect.top, allowed };
    }
    return null;
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    if (previous.visibility === this.props.visibility
      && previous.cardAnchor === this.props.cardAnchor) return;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    const root = this.props.containerRef.current;
    if (!root || !snapshot) return;
    let height = -1;
    let stableFrames = 0;
    let frames = 0;
    const restore = () => {
      const node = anchorNode(snapshot, root);
      if (!node || !snapshot.allowed()) return;
      root.scrollTop += node.getBoundingClientRect().top - snapshot.top;
      const nextHeight = root.scrollHeight;
      stableFrames = nextHeight === height ? stableFrames + 1 : 0;
      height = nextHeight;

      if (++frames < 12 && stableFrames < 3) this.frame = window.requestAnimationFrame(restore);
    };
    restore();
  }

  render() { return this.props.children; }
}
