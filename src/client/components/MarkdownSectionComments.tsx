// eslint-disable-next-line no-restricted-imports -- useEffect: keyboard handler subscription
import { useState, useMemo, useCallback, useEffect } from "react";
import { marked } from "marked";
import { PlusIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge, type BadgeProps } from "./ui/badge.js";
import { parseFrontmatter, type ParsedFrontmatter } from "../utils/markdown-frontmatter.js";
import type { DocPriority, DocStatus } from "../../server/shared/types.js";

interface MarkdownSection {
  heading: string;
  rawContent: string;
  index: number;
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = content.split("\n");
  let current: MarkdownSection = { heading: "", rawContent: "", index: 0 };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.heading || current.rawContent.trim()) {
        sections.push(current);
      }
      current = { heading: line, rawContent: `${line}\n`, index: sections.length };
    } else {
      current.rawContent += `${line}\n`;
    }
  }
  if (current.heading || current.rawContent.trim()) {
    sections.push(current);
  }

  return sections;
}

/**
 * Visual styling for status/priority badges in the frontmatter header. Kept in
 * sync with `DocsViewer` so a doc's status looks the same whether it's seen as
 * a list row or opened in the preview modal.
 */
const STATUS_BADGE: Record<DocStatus, { label: string; variant: BadgeProps["variant"] }> = {
  "in-progress": { label: "In Progress", variant: "warning" },
  "planned": { label: "Planned", variant: "info" },
  "paused": { label: "Paused", variant: "default" },
  "done": { label: "Done", variant: "success" },
  "rejected": { label: "Rejected", variant: "error" },
};

const PRIORITY_BADGE: Record<DocPriority, { label: string; variant: BadgeProps["variant"] }> = {
  high: { label: "High priority", variant: "error" },
  medium: { label: "Med priority", variant: "warning" },
  low: { label: "Low priority", variant: "default" },
};

function FrontmatterHeader({ fm }: { fm: ParsedFrontmatter }) {
  const status = fm.status ? STATUS_BADGE[fm.status] : null;
  const priority = fm.priority ? PRIORITY_BADGE[fm.priority] : null;
  const hasBadges = !!status || !!priority || !!fm.customStatus;
  const hasContent = hasBadges || !!fm.description || fm.extras.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary) space-y-2">
      {hasBadges && (
        <div className="flex flex-wrap items-center gap-2">
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          {!status && fm.customStatus && <Badge variant="default">{fm.customStatus}</Badge>}
          {priority && <Badge variant={priority.variant}>{priority.label}</Badge>}
        </div>
      )}
      {fm.description && (
        <p className="text-sm text-(--color-text-secondary) italic">{fm.description}</p>
      )}
      {fm.extras.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {fm.extras.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-(--color-text-tertiary) font-medium">{entry.key}</dt>
              <dd className="text-(--color-text-secondary) font-mono break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export interface SectionCommentData {
  id: string;
  sectionHeading: string;
  sectionIndex: number;
  text: string;
  source?: "human" | "ai";
}

export interface MarkdownSectionCommentsProps {
  content: string;
  comments: SectionCommentData[];
  onAddComment: (sectionHeading: string, sectionIndex: number, text: string) => void;
  onEditComment: (commentId: string, text: string) => void;
  onDeleteComment: (commentId: string) => void;
}

function CommentInput({
  onSubmit,
  onCancel,
  initialText,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }
    },
    [text, onSubmit],
  );

  return (
    <div className="mt-2 mb-3 ml-4 border border-(--color-border-secondary) rounded-lg bg-(--color-bg-secondary) p-3">
      <textarea
        className="w-full bg-transparent text-sm text-(--color-text-primary) outline-none resize-none min-h-[60px] placeholder:text-(--color-text-tertiary)"
        placeholder="Add a comment... (Cmd+Enter to submit, Escape to cancel)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { if (text.trim()) onSubmit(text.trim()); }}
          disabled={!text.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  onEdit,
  onDelete,
}: {
  comment: SectionCommentData;
  onEdit: (commentId: string, text: string) => void;
  onDelete: (commentId: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  const isAi = comment.source === "ai";
  const borderColor = isAi ? "border-l-purple-400" : "border-l-blue-400";
  const bgColor = isAi ? "bg-purple-950/30" : "bg-blue-950/30";

  if (editing) {
    return (
      <CommentInput
        initialText={comment.text}
        onSubmit={(text) => {
          onEdit(comment.id, text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`mt-2 mb-3 ml-4 border-l-2 ${borderColor} ${bgColor} rounded-r-lg p-3 group/comment`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {isAi && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400 mb-1 block">
              AI
            </span>
          )}
          <p className="text-sm text-(--color-text-primary) whitespace-pre-wrap">{comment.text}</p>
        </div>
        <div className="flex gap-1 shrink-0 opacity-0 group-hover/comment:opacity-100 transition-opacity">
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-text-primary)"
            title="Edit"
          >
            <PencilSimpleIcon size={ICON_SIZE.SM} />
          </button>
          <button
            onClick={() => onDelete(comment.id)}
            className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-error)"
            title="Delete"
          >
            <TrashIcon size={ICON_SIZE.SM} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function MarkdownSectionComments({
  content,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: MarkdownSectionCommentsProps) {
  const [addingToSection, setAddingToSection] = useState<number | null>(null);

  // Strip YAML frontmatter from the content before sectioning so the raw
  // `status: planned\npriority: high\n...` block doesn't render as a paragraph
  // at the top of the preamble. The parsed fields are surfaced as a styled
  // header instead — same visual language as the docs list.
  const fm = useMemo(() => parseFrontmatter(content), [content]);
  const sections = useMemo(() => parseMarkdownSections(fm.body), [fm.body]);

  const renderedSections = useMemo(() => {
    return sections.map((section) => ({
      ...section,
      html: marked.parse(section.rawContent, { async: false }),
    }));
  }, [sections]);

  const commentsBySection = useMemo(() => {
    const map = new Map<number, SectionCommentData[]>();
    for (const comment of comments) {
      // Match by heading text first, then fall back to index
      let sectionIdx = sections.findIndex((s) => s.heading === comment.sectionHeading);
      if (sectionIdx < 0) sectionIdx = comment.sectionIndex;
      if (sectionIdx < 0 || sectionIdx >= sections.length) sectionIdx = 0;
      if (!map.has(sectionIdx)) map.set(sectionIdx, []);
      map.get(sectionIdx)!.push(comment);
    }
    return map;
  }, [comments, sections]);

  return (
    <div className="space-y-0">
      {fm.hasFrontmatter && <FrontmatterHeader fm={fm} />}
      {renderedSections.map((section) => {
        const sectionComments = commentsBySection.get(section.index) ?? [];

        return (
          <div key={section.index} className="group/section">
            {/* Section content with add button */}
            <div className="relative">
              <div
                className="prose dark:prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: section.html }}
              />
              <button
                onClick={() => setAddingToSection(section.index)}
                className="absolute top-0 right-0 p-1 rounded opacity-0 group-hover/section:opacity-100 hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-opacity"
                title="Add comment to this section"
              >
                <PlusIcon size={ICON_SIZE.SM} />
              </button>
            </div>

            {/* Existing comments */}
            {sectionComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                onEdit={onEditComment}
                onDelete={onDeleteComment}
              />
            ))}

            {/* New comment input */}
            {addingToSection === section.index && (
              <CommentInput
                onSubmit={(text) => {
                  onAddComment(section.heading, section.index, text);
                  setAddingToSection(null);
                }}
                onCancel={() => setAddingToSection(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
