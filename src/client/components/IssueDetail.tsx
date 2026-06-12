/**
 * IssueDetail — the inline single-issue view (docs/189).
 *
 * The detail half of the Issues tab's master-detail layout. It renders a
 * fully-hydrated tracker issue — title, status, priority, labels, assignee, and
 * the markdown body — entirely inside ShipIt, so reading an issue never bounces
 * the user to Linear/GitHub. Reached three ways, all routed through
 * `issues-store.openIssue`: a list row, the agent's read card (`IssueRefCard`),
 * and the agent's write card (`IssueWriteCard`).
 *
 * Per the ShipIt product principles (CLAUDE.md §2), the deep link to the tracker
 * is an *escape hatch* that lives ONLY here, in the header — it's no longer the
 * primary affordance on the list rows or the chat cards.
 *
 * Presentational: the connected `IssuesPanel` selects the store state and wires
 * the callbacks. While the fresh fetch is in flight the view paints from the
 * seed fields the opener already had (`selection`), so a click feels instant.
 */

import { useState } from "react";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretLeftIcon,
  ChatCircleIcon,
  TagIcon,
  UserIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Banner } from "./ui/banner.js";
import { Button } from "./ui/button.js";
import { StartSessionButton } from "./StartSessionButton.js";
import { MarkdownContent } from "./message-markdown.js";
import { labelDotColor } from "./issue-label-color.js";
import { IssueLabelsEditor } from "./IssueLabelsEditor.js";
import {
  IssuePriorityEditor,
  IssueStatusEditor,
  PriorityBadge,
  PriorityTrigger,
  statusDotColor,
  type IssueStatusRef,
} from "./IssueFieldControls.js";
import { ICON_SIZE } from "../design-tokens.js";
import { useSurfaceLuminance } from "../hooks/useSurfaceLuminance.js";
import { adaptColorForSurface } from "../utils/status-color.js";
import { formatRelativeDate } from "../utils/dates.js";
import type { IssueSelection } from "../stores/issues-store.js";
import type {
  IssueLabel,
  IssuePriorityLevel,
  TrackerComment,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";

export interface IssueDetailProps {
  selection: IssueSelection;
  /** Fully-hydrated issue from `GET /api/issue`; null until the fetch lands. */
  detail: TrackerIssue | null;
  loading: boolean;
  error: string | null;
  /** Active tracker info, for the "Open in {label}" deep link. */
  info?: TrackerInfo;
  /** Whether a repo is available to seed a session on. */
  canStart: boolean;
  /** The open issue's comment thread; null until the fetch lands. */
  comments: TrackerComment[] | null;
  commentsLoading: boolean;
  commentsError: string | null;
  /**
   * The tracker's assignable statuses, as a fallback for the inline status
   * editor when the hydrated issue hasn't supplied its own `availableStatuses`
   * yet (docs/191).
   */
  availableStatuses: IssueStatusRef[];
  /** Whether priority is editable for this tracker (Linear yes, GitHub no). */
  canEditPriority: boolean;
  /** The tracker's full pickable label set, for the on-page label editor. */
  availableLabels: IssueLabel[];
  /** Whether labels are editable for this tracker (both Linear and GitHub). */
  canEditLabels: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStartSession: (issue: TrackerIssue) => void;
  /** Post a user comment; resolves to an error message, or null on success. */
  onPostComment: (body: string) => Promise<string | null>;
  /** Set the open issue's status; resolves to an error message, or null. */
  onSetStatus: (status: string) => Promise<string | null>;
  /** Set the open issue's priority; resolves to an error message, or null. */
  onSetPriority: (level: IssuePriorityLevel) => Promise<string | null>;
  /** Lazily fetch the tracker's pickable label set (on editor open). */
  onFetchLabels: () => void;
  /** Replace the open issue's full label set; resolves to an error, or null. */
  onSetLabels: (names: string[]) => Promise<string | null>;
}

/** Status-NAME text color by workflow-state type (the dot uses the tracker color). */
function statusTextClass(type?: string): string {
  switch (type) {
    case "completed":
      return "text-(--color-success)";
    case "started":
      return "text-(--color-text-primary)";
    case "canceled":
      return "text-(--color-text-tertiary)";
    default:
      return "text-(--color-text-secondary)";
  }
}

function StatusPill({ status, surfaceLum }: { status: NonNullable<TrackerIssue["status"]>; surfaceLum: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-[18px] text-[11px] font-medium leading-none">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: adaptColorForSurface(statusDotColor(status), surfaceLum) }}
        aria-hidden="true"
      />
      <span className={statusTextClass(status.type)}>{status.name}</span>
    </span>
  );
}

export function IssueDetail({
  selection,
  detail,
  loading,
  error,
  info,
  canStart,
  comments,
  commentsLoading,
  commentsError,
  availableStatuses,
  canEditPriority,
  availableLabels,
  canEditLabels,
  onBack,
  onRefresh,
  onStartSession,
  onPostComment,
  onSetStatus,
  onSetPriority,
  onFetchLabels,
  onSetLabels,
}: IssueDetailProps) {
  // Prefer the hydrated issue; fall back to the seed fields the opener supplied
  // so the header/title paint before the fetch resolves.
  const title = detail?.title ?? selection.title ?? selection.identifier;
  const url = detail?.url ?? selection.url;
  const trackerLabel = info?.label ?? (selection.tracker === "github" ? "GitHub" : "Linear");
  // Detail body sits on the primary surface; adapt status/priority colors to it.
  const surfaceLum = useSurfaceLuminance("--color-bg-primary");
  // A card-opened issue with no seed and no detail yet has nothing to show but
  // the identifier — render the skeleton until the first fetch lands.
  const showSkeleton = loading && !detail;

  return (
    <div className="flex flex-col h-full animate-in fade-in-0 duration-200">
      {/* Header: back · identifier · external escape hatch. */}
      <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        <Button
          variant="ghost"
          size="md"
          onClick={onBack}
          className="shrink-0 -ml-1"
          title="Back to issues"
        >
          <CaretLeftIcon size={ICON_SIZE.SM} />
          Issues
        </Button>

        <span className="font-mono text-xs text-(--color-text-tertiary) truncate">
          {selection.identifier}
        </span>

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh issue"
          className="shrink-0 h-7 w-7 p-0"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.SM} className={loading ? "animate-spin" : ""} />
        </Button>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${selection.identifier} in ${trackerLabel}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
          >
            <ArrowSquareOutIcon size={ICON_SIZE.XS} />
            <span className="hidden sm:inline">Open in {trackerLabel}</span>
          </a>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && !detail ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <WarningCircleIcon size={ICON_SIZE.XL} className="text-(--color-text-tertiary)" />
            <p className="text-sm text-(--color-text-secondary)">{error}</p>
            <Button variant="secondary" size="md" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : showSkeleton ? (
          <IssueDetailSkeleton />
        ) : (
          <article className="px-5 py-5">
            {/* Status · priority strip — both inline-editable (docs/191). */}
            <div className="flex items-center flex-wrap gap-3 mb-3">
              {detail?.status && (
                <IssueStatusEditor
                  current={detail.status}
                  options={detail.availableStatuses ?? availableStatuses}
                  onSelect={onSetStatus}
                  ariaLabel={`Change status (currently ${detail.status.name})`}
                  trigger={<StatusPill status={detail.status} surfaceLum={surfaceLum} />}
                />
              )}
              {detail &&
                (canEditPriority ? (
                  <IssuePriorityEditor
                    current={detail.priority.level}
                    onSelect={onSetPriority}
                    ariaLabel={`Change priority (currently ${detail.priority.label})`}
                    trigger={<PriorityTrigger priority={detail.priority} surfaceLum={surfaceLum} />}
                  />
                ) : (
                  <PriorityBadge priority={detail.priority} surfaceLum={surfaceLum} />
                ))}
            </div>

            {/* Title. */}
            <h1 className="text-xl font-semibold leading-snug text-(--color-text-primary) mb-4">
              {title}
            </h1>

            {/* Assignee + labels meta. The labels row is editable (pick from the
                tracker's existing set): chips carry a remove ✕, and an inline
                editor adds/removes against the pickable set. The row shows even
                with no labels when editing is allowed, so the user can add one. */}
            {detail && (Boolean(detail.assignee) || canEditLabels || (detail.labels?.length ?? 0) > 0) && (
              <div className="flex flex-col gap-2.5 pb-4 mb-4 border-b border-(--color-border-secondary)">
                {detail.assignee && (
                  <div className="flex items-center gap-2 text-xs text-(--color-text-secondary)">
                    <UserIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />
                    {detail.assignee.avatarUrl ? (
                      <img
                        src={detail.assignee.avatarUrl}
                        alt=""
                        className="w-5 h-5 rounded-full object-cover"
                      />
                    ) : null}
                    <span className="text-(--color-text-primary)">{detail.assignee.name}</span>
                  </div>
                )}
                {(canEditLabels || (detail.labels?.length ?? 0) > 0) && (
                  <div className="flex items-start gap-2">
                    <TagIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary) mt-0.5 shrink-0" />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(detail.labels ?? []).map((label) => (
                        <span
                          key={label.name}
                          className="inline-flex items-center gap-1.5 rounded-full bg-(--color-bg-tertiary) text-(--color-text-secondary) text-[11px] py-0.5 pl-2 pr-1"
                        >
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: label.color ?? labelDotColor(label.name) }}
                            aria-hidden="true"
                          />
                          {label.name}
                          {canEditLabels && (
                            <button
                              type="button"
                              aria-label={`Remove ${label.name}`}
                              onClick={() =>
                                void onSetLabels(
                                  (detail.labels ?? [])
                                    .map((l) => l.name)
                                    .filter((n) => n !== label.name),
                                )
                              }
                              className="ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full text-(--color-text-tertiary) hover:bg-(--color-bg-active) hover:text-(--color-text-primary) cursor-pointer"
                            >
                              <XIcon size={10} weight="bold" />
                            </button>
                          )}
                        </span>
                      ))}
                      {canEditLabels && (
                        <IssueLabelsEditor
                          current={detail.labels ?? []}
                          available={availableLabels}
                          onOpen={onFetchLabels}
                          onCommit={onSetLabels}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Body. */}
            {detail?.description?.trim() ? (
              <MarkdownContent text={detail.description} />
            ) : (
              <p className="text-sm text-(--color-text-tertiary) italic">No description.</p>
            )}

            {/* Comment thread + composer (docs/189 follow-up). */}
            <IssueComments
              comments={comments}
              loading={commentsLoading}
              error={commentsError}
              onPost={onPostComment}
            />
          </article>
        )}
      </div>

      {/* Footer action — seed a session from this issue (mirrors the list row). */}
      {detail && (
        <div className="shrink-0 flex justify-end border-t border-(--color-border-secondary) bg-(--color-bg-secondary) px-4 py-2.5">
          <StartSessionButton
            label="Start session from this issue"
            disabled={!canStart}
            onClick={() => onStartSession(detail)}
            title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
          />
        </div>
      )}
    </div>
  );
}

/** Round avatar with a single-letter fallback when the tracker omits an image. */
function CommentAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="size-5 shrink-0 rounded-full object-cover" loading="lazy" />;
  }
  return (
    <div className="size-5 shrink-0 rounded-full bg-(--color-bg-tertiary) text-(--color-text-tertiary) flex items-center justify-center text-[10px] font-semibold uppercase">
      {name.charAt(0) || "?"}
    </div>
  );
}

function IssueCommentItem({ comment }: { comment: TrackerComment }) {
  const name = comment.author?.name ?? "Unknown";
  return (
    <li className="flex gap-2">
      <CommentAvatar name={name} avatarUrl={comment.author?.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-(--color-text-primary)">{name}</span>
          {comment.createdAt && (
            <span className="text-(--color-text-tertiary)">{formatRelativeDate(comment.createdAt)}</span>
          )}
        </div>
        <div className="text-sm text-(--color-text-secondary)">
          <MarkdownContent text={comment.body} />
        </div>
      </div>
    </li>
  );
}

/**
 * The issue's comment thread + a composer to post one inline (docs/189
 * follow-up). Mirrors the PR detail tab's Conversation section: the user reads
 * and replies without leaving ShipIt. A posted comment is the user's own action,
 * so it lands in the thread directly (no chat provenance card).
 */
function IssueComments({
  comments,
  loading,
  error,
  onPost,
}: {
  comments: TrackerComment[] | null;
  loading: boolean;
  error: string | null;
  onPost: (body: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setPostError(null);
    const err = await onPost(body);
    setSubmitting(false);
    if (err) {
      setPostError(err);
      return;
    }
    setDraft("");
  };

  // null = not fetched yet (show a hint); [] = genuinely empty.
  const loadingThread = comments === null && loading;
  const list = comments ?? [];

  return (
    <section className="mt-5 pt-4 border-t border-(--color-border-secondary)">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
        <ChatCircleIcon size={ICON_SIZE.SM} />
        Comments
        {list.length > 0 && <span className="text-(--color-text-tertiary)">· {list.length}</span>}
      </h3>

      {error ? (
        <Banner variant="error" className="rounded-md text-left text-xs">
          {error}
        </Banner>
      ) : loadingThread ? (
        <p className="text-sm text-(--color-text-tertiary) italic">Loading comments…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-(--color-text-tertiary) italic">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((c) => (
            <IssueCommentItem key={c.id} comment={c} />
          ))}
        </ul>
      )}

      {postError && (
        <Banner variant="error" className="mt-3 rounded-md text-left text-xs">
          {postError}
        </Banner>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={3}
          disabled={submitting}
          data-testid="issue-comment-input"
          className="w-full resize-y rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none disabled:opacity-50"
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="md"
            onClick={() => void handleSubmit()}
            disabled={submitting || draft.trim().length === 0}
          >
            {submitting ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Loading placeholder for a card-opened issue we have no seed for yet. */
function IssueDetailSkeleton() {
  return (
    <div className="px-5 py-5 animate-pulse" data-testid="issue-detail-skeleton">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-3 w-20 rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-12 rounded bg-(--color-bg-tertiary)" />
      </div>
      <div className="h-6 w-3/4 rounded bg-(--color-bg-tertiary) mb-5" />
      <div className="space-y-2.5">
        <div className="h-3 w-full rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-11/12 rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-4/5 rounded bg-(--color-bg-tertiary)" />
      </div>
    </div>
  );
}
