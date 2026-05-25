/**
 * UserReviewCard — user-side counterpart to SubagentCall. Renders the
 * optimistic chat bubble for a "send comments on a doc/diff" submission so
 * the user gets an immediate, visible acknowledgement that their comments
 * were sent. Previously this flow created no chat entry at all — the agent
 * silently started working and the input box still looked idle.
 *
 * Visual treatment mirrors SubagentCall: a left-border accent, an icon +
 * header line, a collapsed-by-default disclosure showing the full prompt the
 * agent received. Status is intentionally NOT rendered here (the chat-level
 * spinner / activity label already drives that) — this card is just the
 * "you sent this" receipt.
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
      className="border-l-2 border-(--color-info)/40 pl-3 space-y-1.5"
    >
      <div className="flex items-center gap-2 text-sm">
        <ChatTextIcon size={ICON_SIZE.SM} className="text-(--color-info)" />
        <span className="font-semibold text-(--color-info)">Sent comments</span>
        {fileLabel && (
          <span className="text-(--color-text-secondary)">
            on <span className="font-mono text-xs">{fileLabel}</span>
          </span>
        )}
        <span className="text-(--color-text-tertiary) text-xs">· {commentLabel}</span>
      </div>

      {prompt && (
        <div>
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
              className="mt-1 text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap rounded bg-(--color-bg-secondary)/60 p-2 max-h-64 overflow-y-auto leading-5"
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
