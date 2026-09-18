import { RenderedFrame } from "./FileContentView/RenderedFrame.js";
import type { FileDiff } from "../../server/shared/types.js";

export function isSvgPath(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "svg";
}

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

export function missingPaneLabel(file: FileDiff, side: "old" | "new"): string {
  if (side === "old" && file.status === "added") return "(added — no previous version)";
  if (side === "new" && file.status === "deleted") return "(deleted)";
  return file.lfs ? "(Git LFS content unavailable)" : "(preview unavailable)";
}

export function ImageDiffView({ file }: { file: FileDiff }) {
  const imgPane = (src: string, alt: string, side: "old" | "new") =>
    src ? (
      <div
        className="flex-1 flex items-center justify-center p-4 min-h-[160px]"
        style={{ background: CHECKERBOARD }}
      >
        <img src={src} alt={alt} className="max-w-full max-h-[420px] object-contain" />
      </div>
    ) : (
      <EmptyPane label={missingPaneLabel(file, side)} />
    );

  return (
    <MediaSplit
      left={imgPane(file.oldContent, `${file.path} (before)`, "old")}
      right={imgPane(file.newContent, `${file.path} (after)`, "new")}
    />
  );
}

export function SvgDiffView({ file }: { file: FileDiff }) {
  const svgPane = (content: string, side: "old" | "new") =>
    content ? (
      <div className="flex-1 min-h-[240px] h-[320px] bg-white">
        <RenderedFrame kind="svg" content={content} />
      </div>
    ) : (
      <EmptyPane label={missingPaneLabel(file, side)} />
    );

  return (
    <MediaSplit
      left={svgPane(file.oldContent, "old")}
      right={svgPane(file.newContent, "new")}
    />
  );
}
