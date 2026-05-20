/**
 * PrConversationSection — the "Conversation" block of the PR detail tab
 * (docs/133 Phase 4).
 *
 * Renders PR-level (issue) comments and review threads inline so the user
 * doesn't leave ShipIt to read or reply to PR discussion. Issue comments are
 * read + post; review threads are read-only in this phase (reply/resolve
 * write-back is deferred to docs/102). Data arrives on the pr-store card via
 * the poller, which only fetches it while this tab is the active right-panel
 * tab (the `pr_tab_active` gate).
 */

import { useState } from "react";
import { ChatCircleIcon, CheckCircleIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { PrIssueComment, PrReviewThread } from "../../../server/shared/types/github-types.js";
import { usePrStore } from "../../stores/pr-store.js";
import { formatRelativeDate } from "../../utils/dates.js";
import { MarkdownContent } from "../message-markdown.js";
import { Button } from "../ui/button.js";
import { Banner } from "../ui/banner.js";

function Avatar({ login, avatarUrl }: { login: string; avatarUrl: string }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={login}
        className="size-5 shrink-0 rounded-full"
        loading="lazy"
      />
    );
  }
  return (
    <div className="size-5 shrink-0 rounded-full bg-(--color-bg-tertiary) text-(--color-text-tertiary) flex items-center justify-center text-[10px] font-semibold uppercase">
      {login.charAt(0)}
    </div>
  );
}

function CommentHeader({ login, createdAt }: { login: string; createdAt: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="font-medium text-(--color-text-primary)">{login}</span>
      <span className="text-(--color-text-tertiary)">{formatRelativeDate(createdAt)}</span>
    </div>
  );
}

function IssueComment({ comment }: { comment: PrIssueComment }) {
  return (
    <li className="flex gap-2">
      <Avatar login={comment.author.login} avatarUrl={comment.author.avatarUrl} />
      <div className="min-w-0 flex-1">
        <CommentHeader login={comment.author.login} createdAt={comment.createdAt} />
        <div className="text-sm text-(--color-text-secondary)">
          <MarkdownContent text={comment.body} />
        </div>
      </div>
    </li>
  );
}

function ReviewThreadItem({ thread }: { thread: PrReviewThread }) {
  const location = thread.path
    ? `${thread.path}${thread.line !== null ? `:${thread.line}` : ""}`
    : "review thread";
  return (
    <li className="rounded-md border border-(--color-border-secondary) p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs">
        <span className="truncate font-mono text-(--color-text-tertiary)">{location}</span>
        {thread.isResolved && (
          <span className="inline-flex items-center gap-1 text-(--color-success)">
            <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
            resolved
          </span>
        )}
        {thread.isOutdated && (
          <span className="inline-flex items-center gap-1 text-(--color-text-tertiary)">
            <ClockCounterClockwiseIcon size={ICON_SIZE.XS} />
            outdated
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="flex gap-2">
            <Avatar login={c.author.login} avatarUrl={c.author.avatarUrl} />
            <div className="min-w-0 flex-1">
              <CommentHeader login={c.author.login} createdAt={c.createdAt} />
              <div className="text-sm text-(--color-text-secondary)">
                <MarkdownContent text={c.body} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function PrConversationSection({
  sessionId,
  issueComments,
  reviewThreads,
}: {
  sessionId: string;
  issueComments?: PrIssueComment[];
  reviewThreads?: PrReviewThread[];
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const comments = issueComments ?? [];
  const threads = reviewThreads ?? [];
  // `undefined` means the conversation hasn't been fetched yet (the poller only
  // fetches it once this tab is active); show a loading hint rather than "none".
  const loading = issueComments === undefined && reviewThreads === undefined;
  const isEmpty = comments.length === 0 && threads.length === 0;

  const handleSubmit = async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setError(null);
    const err = await usePrStore.getState().postComment(sessionId, body);
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    setDraft("");
  };

  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary)">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
        <ChatCircleIcon size={ICON_SIZE.SM} />
        Conversation
      </h3>

      {loading ? (
        <p className="text-sm text-(--color-text-tertiary) italic">Loading conversation…</p>
      ) : isEmpty ? (
        <p className="text-sm text-(--color-text-tertiary) italic">No comments yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {comments.length > 0 && (
            <ul className="flex flex-col gap-3">
              {comments.map((c) => (
                <IssueComment key={c.id} comment={c} />
              ))}
            </ul>
          )}
          {threads.length > 0 && (
            <ul className="flex flex-col gap-2">
              {threads.map((t) => (
                <ReviewThreadItem key={t.id} thread={t} />
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <Banner variant="error" className="mt-3 rounded-md text-left">
          {error}
        </Banner>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={3}
          disabled={submitting}
          className="w-full resize-y rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none disabled:opacity-50"
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={submitting || draft.trim().length === 0}
          >
            {submitting ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
    </section>
  );
}
