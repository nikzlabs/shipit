/**
 * PresentGallery — the "view all" thumbnail grid for the Present tab (docs/093).
 *
 * Toggled from the carousel header (the grid icon beside the `◀ N/M ▶` controls)
 * when there's more than one artifact. With many presentations, stepping the
 * carousel one-at-a-time is tedious; this grid shows every artifact at once so
 * the user can jump straight to any of them. Clicking a tile selects it and
 * collapses back to the single view.
 *
 * Thumbnails are LAZY LIVE renders: each tile mounts a scaled, non-interactive
 * sandboxed iframe (the same `RenderedFrame` the single view uses) only once it
 * scrolls near the viewport, and fetches its bytes on reveal via the shared
 * `loadPresentContent`. Rendering at a fixed logical size and scaling down to
 * the tile width gives a faithful "shrunk page" preview rather than a
 * mobile-width reflow. Columns are container-query responsive (2 → 3 → 4) so the
 * grid adapts to the pane width, not the viewport.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: IntersectionObserver reveal + ResizeObserver scale (browser API subscriptions)
import { useEffect, useRef, useState } from "react";
import { PresentationChartIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { Presentation } from "../stores/present-store.js";
import { loadPresentContent } from "../utils/present-content-fetch.js";
import { kindFromMimeType } from "../utils/file-content-kind.js";
import { RenderedFrame } from "./FileContentView/RenderedFrame.js";

/** Fixed logical render size for a thumbnail (16:10) — scaled down to tile width. */
const THUMB_W = 1280;
const THUMB_H = 800;

interface PresentGalleryProps {
  presentations: Presentation[];
  /** Index of the currently-selected artifact — highlighted in the grid. */
  activeIndex: number;
  sessionId: string;
  /** Jump to an artifact (the pane closes the gallery on select). */
  onSelect: (index: number) => void;
}

export function PresentGallery({ presentations, activeIndex, sessionId, onSelect }: PresentGalleryProps) {
  return (
    <div className="@container absolute inset-0 overflow-y-auto p-4">
      <div className="grid grid-cols-2 @[30rem]:grid-cols-3 @[46rem]:grid-cols-4 gap-4">
        {presentations.map((p, i) => (
          <GalleryTile
            key={p.presentId}
            presentation={p}
            index={i}
            isActive={i === activeIndex}
            sessionId={sessionId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function GalleryTile({
  presentation,
  index,
  isActive,
  sessionId,
  onSelect,
}: {
  presentation: Presentation;
  index: number;
  isActive: boolean;
  sessionId: string;
  onSelect: (index: number) => void;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [scale, setScale] = useState(0);

  const { content, mimeType, filePath, title } = presentation;
  const kind = kindFromMimeType(mimeType, filePath);

  // Reveal when the tile scrolls near the viewport (300px margin pre-loads the
  // next row). No IntersectionObserver (jsdom/legacy) → reveal immediately.
  // eslint-disable-next-line no-restricted-syntax -- IntersectionObserver subscription with cleanup
  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Fetch the bytes once revealed (shared de-dupe with the single view).
  // eslint-disable-next-line no-restricted-syntax -- lazy content fetch keyed on reveal
  useEffect(() => {
    if (inView && sessionId && content === undefined) {
      void loadPresentContent(sessionId, presentation.presentId);
    }
  }, [inView, sessionId, presentation.presentId, content]);

  // Scale the fixed-size render down to the actual tile width.
  // eslint-disable-next-line no-restricted-syntax -- ResizeObserver subscription with cleanup
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / THUMB_W);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasBytes = inView && content !== undefined;
  const showFrame = hasBytes && (kind === "html" || kind === "svg");

  return (
    <button
      ref={tileRef}
      type="button"
      onClick={() => onSelect(index)}
      aria-label={`View ${title ?? basename(filePath)}`}
      aria-current={isActive}
      className={`group flex flex-col overflow-hidden rounded-lg border bg-(--color-bg-secondary) text-left transition-shadow hover:shadow-lg ${
        isActive
          ? "border-(--color-accent) ring-1 ring-(--color-accent)"
          : "border-(--color-border-primary) hover:border-(--color-border-secondary)"
      }`}
    >
      <div ref={previewRef} className="relative aspect-[16/10] overflow-hidden bg-white">
        {showFrame ? (
          <div
            className="pointer-events-none origin-top-left"
            style={{ width: THUMB_W, height: THUMB_H, transform: `scale(${scale})` }}
          >
            <RenderedFrame kind={kind} content={content} />
          </div>
        ) : hasBytes && kind === "image" ? (
          <img src={content} alt={filePath} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-(--color-text-tertiary)">
            <PresentationChartIcon size={ICON_SIZE.LG} />
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
          {index + 1}
        </span>
      </div>
      <div className="min-w-0 px-2.5 py-2">
        <div className="truncate text-xs font-medium text-(--color-text-primary)">
          {title ?? basename(filePath)}
        </div>
        <div className="truncate font-mono text-[11px] text-(--color-text-tertiary)" title={filePath}>
          {filePath}
        </div>
      </div>
    </button>
  );
}

/** Last path segment, mirroring PresentPane's header label. */
function basename(filePath: string): string {
  const segment = filePath.replace(/\/+$/, "").split("/").pop();
  return segment && segment.length > 0 ? segment : filePath;
}
