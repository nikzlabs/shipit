import { Component, type ReactNode, type RefObject } from "react";

interface Props {
  children: ReactNode;
  visibility: string;
  containerRef: RefObject<HTMLDivElement | null>;
  canRestoreReadingAnchor: () => boolean;
}
interface Snapshot { node: HTMLElement; top: number }

/**
 * This boundary needs React's BEFORE-mutation snapshot: disclosures and row
 * visibility change together. A layout effect sees their already-changed layout.
 * React owns hidden; this boundary only preserves a reader's position. Bottom
 * following and gesture/selection protection stay with useMessageScroll.
 */
export class CompactLayout extends Component<Props, Record<string, never>, Snapshot | null> {
  private frame: number | undefined;

  componentWillUnmount() {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { visibility, containerRef, canRestoreReadingAnchor } = this.props;
    if (previous.visibility === visibility
      || (!previous.visibility.includes("1") && !visibility.includes("1"))
      || !canRestoreReadingAnchor()) return null;
    const root = containerRef.current;
    if (!root) return null;
    const top = root.getBoundingClientRect().top;
    const nodes = root.querySelectorAll<HTMLElement>("[data-compact-content]");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.hidden || visibility[i] === "1") continue;
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > top) return { node, top: rect.top };
    }
    return null;
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    if (previous.visibility === this.props.visibility) return;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    const root = this.props.containerRef.current;
    if (!root || !snapshot) return;
    let height = -1;
    let stableFrames = 0;
    let frames = 0;
    const restore = () => {
      if (!snapshot.node.isConnected || !this.props.canRestoreReadingAnchor()) return;
      root.scrollTop += snapshot.node.getBoundingClientRect().top - snapshot.top;
      const nextHeight = root.scrollHeight;
      stableFrames = nextHeight === height ? stableFrames + 1 : 0;
      height = nextHeight;
      // content-visibility groups can resolve after the first layout. Settle
      // briefly, with the same gesture/selection guards on every frame.
      if (++frames < 12 && stableFrames < 3) this.frame = window.requestAnimationFrame(restore);
    };
    restore();
  }

  render() { return this.props.children; }
}
