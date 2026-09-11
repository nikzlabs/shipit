import { MarkdownReviewView } from "./MarkdownReviewView.js";
import { CodeEditor } from "./CodeEditor.js";
import { RenderedFrame, svgToMarkup } from "./RenderedFrame.js";
import type { ContentKind } from "../../utils/file-content-kind.js";
import type { ViewMode } from "./SourceToggle.js";
import type { SelectionCommentData } from "../MarkdownSelectionComments.js";
import type { Ref } from "react";

export interface FileContentViewProps {
  filePath: string;
  content: string;
  kind: ContentKind;
  sessionId: string;
  viewMode: ViewMode;
  reviewable: boolean;
  revealLine?: number;
  markdownComments: SelectionCommentData[];
  codeComments: { id: string; kind: "line"; line: number; text: string }[];
  agentInterfaceFrameRef?: Ref<HTMLIFrameElement>;
  scrollTo?: string;
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
  agentInterfaceFrameRef,
  scrollTo,
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
      <RenderedFrame
        kind="html"
        content={content}
        enableAgentInterface={!!agentInterfaceFrameRef}
        frameRef={agentInterfaceFrameRef}
        scrollTo={scrollTo}
      />
    );
  }

  if (kind === "svg") {
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
