/**
 * UserReviewCard — user-side counterpart to SubagentCall. Renders the
 * optimistic chat bubble for a "send comments on a doc/diff" submission so
 * the user gets an immediate, visible acknowledgement that their comments
 * were sent. Previously this flow created no chat entry at all — the agent
 * silently started working and the input box still looked idle.
 *
 * Visual treatment is deliberately NOT SubagentCall's. It used to be — a 2px
 * left-border accent over full-width, left-aligned content — which is the
 * agent-side grammar shared by subagent calls and every other agent card. The
 * card was right-aligned in the DOM but nothing about it *looked* right
 * aligned, so it read as agent output and blended into the surrounding turns.
 *
 * So it's now shaped like a user message: a right-aligned bubble that hugs its
 * content, tinted with `--color-accent-subtle` behind an accent border. Layout
 * is eyebrow-over-body, which is what a user message actually is — a label plus
 * content: "Sent N comments" demotes to a 10px uppercase accent eyebrow (loud
 * colour is fine at that size), and the file path becomes the body in primary
 * text so it's the most legible thing in the card when scanning back through
 * the transcript. The tint stops short of the solid `--color-accent` fill of a
 * real user bubble so the card still reads as a structured submission rather
 * than something the user typed.
 *
 * A collapsed-by-default disclosure shows the full prompt the agent received.
 * Status is intentionally NOT rendered here (the chat-level spinner / activity
 * label already drives that) — this card is just the "you sent this" receipt.
 */

import { useState } from "react";
import { CaretRightIcon, ChatTextIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export interface UserReviewCardProps {
  /** Files the comments are anchored to. Empty for multi-file diff submissions. */
  filePaths: string[];
  /** Number of comments included in the submission. */
  commentCount: number;
  /** Full prompt that was shipped to the agent — shown in a collapsed disclosure. */
  prompt: string;
}

export function UserReviewCard({ filePaths, commentCount, prompt }: UserReviewCardProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const fileLabel = formatFileLabel(filePaths);
  const commentLabel = `${commentCount} comment${commentCount === 1 ? "" : "s"}`;

  return (
    <div
      data-testid="user-review-card"
      className="max-w-full min-w-0 rounded-lg border border-(--color-accent)/45 bg-(--color-accent-subtle) px-3.5 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--color-accent)">
        <ChatTextIcon size={ICON_SIZE.XS} />
        <span>Sent {commentLabel}</span>
      </div>

      <div
        className={`mt-1 text-[13px] break-all ${
          fileLabel ? "font-mono text-(--color-text-primary)" : "text-(--color-text-secondary)"
        }`}
      >
        {fileLabel || "on the diff"}
      </div>

      {prompt && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setPromptExpanded((v) => !v)}
            data-testid="user-review-prompt-toggle"
            className="flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
          >
            <CaretRightIcon
              size={ICON_SIZE.XS}
              className={`transition-transform ${promptExpanded ? "rotate-90" : ""}`}
            />
            <span>Prompt ({prompt.length} chars)</span>
          </button>
          {promptExpanded && (
            <div
              data-testid="user-review-prompt"
              // Semi-transparent page background rather than a fixed white or
              // `--color-bg-secondary`: the card sits on an accent tint, so
              // knocking the panel back toward the chat surface reads as inset
              // on light and dark themes alike, where either fixed colour only
              // works on one of them.
              className="mt-1.5 text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap rounded bg-(--color-bg-primary)/60 p-2 max-h-64 overflow-y-auto leading-5"
            >
              {prompt}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatFileLabel(filePaths: string[]): string {
  const [first, ...rest] = filePaths;
  if (!first) return "";
  if (rest.length === 0) return first;
  return `${first} +${rest.length} more`;
}
