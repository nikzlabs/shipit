/**
 * DiffMediaView — side-by-side "before / after" renderers for the diff panel's
 * non-text files:
 *
 *   - `ImageDiffView`   raster images (png/jpg/gif/…). The server embeds each
 *                       side's bytes as a base64 `data:` URI on the FileDiff, so
 *                       we render the two `<img>`s directly. A checkerboard
 *                       backdrop reveals transparency.
 *   - `SvgDiffView`     SVGs (which are text, so the panel still offers a Monaco
 *                       text diff) rendered through the same sandboxed
 *                       `RenderedFrame` used by the file viewer (docs/219).
 *
 * Both lay out old-on-the-left / new-on-the-right with red/green tinted labels
 * matching the diff gutter, and degrade to an "(added)" / "(deleted)" placeholder
 * for the side that doesn't exist.
 */

import { RenderedFrame } from "./FileContentView/RenderedFrame.js";
import type { FileDiff } from "../../server/shared/types.js";

/** True for a `.svg` path — the only text file we offer a rendered diff for. */
export function isSvgPath(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "svg";
}

/** Checkerboard so transparent PNGs/SVGs are visible against the dark panel. */
const CHECKERBOARD =
  "repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%) 50% / 16px 16px";

function PaneLabel({ side }: { side: "old" | "new" }) {
  return (
    <div
      className={`px-3 py-1 text-xs font-medium border-b border-(--color-border-primary) ${
        side === "old" ? "text-(--color-error)" : "text-(--color-success)"
      }`}
    >
      {side === "old" ? "Before" : "After"}
    </div>
  );
}

function EmptyPane({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center min-h-[160px] text-(--color-text-tertiary) text-xs italic">
      {label}
    </div>
  );
}

/** Two-column scaffold shared by the image and SVG views. */
function MediaSplit({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="flex divide-x divide-(--color-border-primary) bg-(--color-bg-primary)">
      <div className="flex-1 min-w-0 flex flex-col">
        <PaneLabel side="old" />
        {left}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <PaneLabel side="new" />
        {right}
      </div>
    </div>
  );
}

export function ImageDiffView({ file }: { file: FileDiff }) {
  const imgPane = (src: string, alt: string, missing: string) =>
    src ? (
      <div
        className="flex-1 flex items-center justify-center p-4 min-h-[160px]"
        style={{ background: CHECKERBOARD }}
      >
        <img src={src} alt={alt} className="max-w-full max-h-[420px] object-contain" />
      </div>
    ) : (
      <EmptyPane label={missing} />
    );

  return (
    <MediaSplit
      left={imgPane(file.oldContent, `${file.path} (before)`, "(added — no previous version)")}
      right={imgPane(file.newContent, `${file.path} (after)`, "(deleted)")}
    />
  );
}

export function SvgDiffView({ file }: { file: FileDiff }) {
  const svgPane = (content: string, missing: string) =>
    content ? (
      <div className="flex-1 min-h-[240px] h-[320px] bg-white">
        <RenderedFrame kind="svg" content={content} />
      </div>
    ) : (
      <EmptyPane label={missing} />
    );

  return (
    <MediaSplit
      left={svgPane(file.oldContent, "(added — no previous version)")}
      right={svgPane(file.newContent, "(deleted)")}
    />
  );
}
