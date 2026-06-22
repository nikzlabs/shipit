/**
 * FileContentView — the single content renderer shared by the file-viewer dialog
 * (`FilePreviewModal`) and the Present tab (`PresentPane`), per docs/219.
 *
 * Pure renderer: it dispatches on `ContentKind` + `viewMode` and owns per-kind
 * scroll/padding, but holds NO review/store state of its own — the surface's
 * `useFileReviewControls` hook owns the `file-review-store` and feeds the comment
 * arrays in as props. Each surface keeps its own chrome (header/toggle/footer)
 * and renders `<FileContentView key={filePath|presentId} />` so Monaco/iframe
 * remount cleanly on navigation.
 */

import { MarkdownReviewView } from "./MarkdownReviewView.js";
import { CodeEditor } from "./CodeEditor.js";
import { RenderedFrame, svgToMarkup } from "./RenderedFrame.js";
import type { ContentKind } from "../../utils/file-content-kind.js";
import type { ViewMode } from "./SourceToggle.js";
import type { SelectionCommentData } from "../MarkdownSelectionComments.js";

export interface FileContentViewProps {
  filePath: string;
  content: string;
  kind: ContentKind;
  sessionId: string;
  /** "rendered" | "source" — only consulted for html/svg; other kinds ignore it. */
  viewMode: ViewMode;
  /** When false the content renders read-only (no comment mutation). */
  reviewable: boolean;
  /** 1-based line to reveal in the code view (e.g. from a `path:line` link). */
  revealLine?: number;
  /** Selection comments for markdown review (from `useFileReviewControls`). */
  markdownComments: SelectionCommentData[];
  /** Line comments for the code/source view (from `useFileReviewControls`). */
  codeComments: { id: string; kind: "line"; line: number; text: string }[];
}

export function FileContentView({
  filePath,
  content,
  kind,
  sessionId,
  viewMode,
  reviewable,
  revealLine,
  markdownComments,
  codeComments,
}: FileContentViewProps) {
  const readOnly = !reviewable;

  if (kind === "markdown") {
    return (
      <div className="h-full w-full overflow-y-auto p-6">
        <MarkdownReviewView
          filePath={filePath}
          content={content}
          sessionId={sessionId}
          comments={markdownComments}
          readOnly={readOnly}
        />
      </div>
    );
  }

  if (kind === "html") {
    return viewMode === "source" ? (
      <CodeEditor
        filePath={filePath}
        content={content}
        sessionId={sessionId}
        comments={codeComments}
        readOnly={readOnly}
        language="html"
      />
    ) : (
      <RenderedFrame kind="html" content={content} />
    );
  }

  if (kind === "svg") {
    // Normalize a `data:` URI to raw markup so source mode shows XML (not the
    // data-URI string) and the rendered frame hosts the actual SVG.
    const markup = svgToMarkup(content);
    return viewMode === "source" ? (
      <CodeEditor
        filePath={filePath}
        content={markup}
        sessionId={sessionId}
        comments={codeComments}
        readOnly={readOnly}
        language="xml"
      />
    ) : (
      <RenderedFrame kind="svg" content={content} />
    );
  }

  if (kind === "image") {
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <img
          src={content}
          alt={filePath}
          className="max-w-full max-h-full object-contain rounded-lg"
        />
      </div>
    );
  }

  if (kind === "binary") {
    return (
      <div className="h-full w-full flex items-center justify-center text-(--color-text-secondary) text-sm">
        Binary file — cannot display.
      </div>
    );
  }

  // kind === "code"
  return (
    <CodeEditor
      filePath={filePath}
      content={content}
      sessionId={sessionId}
      comments={codeComments}
      readOnly={readOnly}
      revealLine={revealLine}
    />
  );
}
