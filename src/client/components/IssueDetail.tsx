// eslint-disable-next-line no-restricted-imports -- useEffect: scroll-to + highlight an anchored comment once the async thread lands (browser API sync + fade timer)
import { useEffect, useRef, useState } from "react";
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
import { Avatar } from "./ui/avatar.js";
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
import { isGitHubTracker } from "../../server/shared/tracker-id.js";
import type {
  IssueLabel,
  IssuePriorityLevel,
  RepoInfo,
  TrackerComment,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";
import { Spinner } from "./Spinner.js";

export interface IssueDetailProps {
  selection: IssueSelection;
  detail: TrackerIssue | null;
  loading: boolean;
  error: string | null;
  info?: TrackerInfo;
  canStart: boolean;
  repos: RepoInfo[];
  targetRepoUrl?: string;
  comments: TrackerComment[] | null;
  commentsLoading: boolean;
  commentsError: string | null;
  anchorCommentId?: string;
  onAnchorConsumed?: () => void;
  availableStatuses: IssueStatusRef[];
  canEditPriority: boolean;
  availableLabels: IssueLabel[];
  canEditLabels: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStartSession: (issue: TrackerIssue, repoUrl?: string) => void;
  onPostComment: (body: string) => Promise<string | null>;
  onSetStatus: (status: string) => Promise<string | null>;
  onSetPriority: (level: IssuePriorityLevel) => Promise<string | null>;
  onFetchLabels: () => void;
  onSetLabels: (names: string[]) => Promise<string | null>;
}

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
  repos,
  targetRepoUrl,
  comments,
  commentsLoading,
  commentsError,
  anchorCommentId,
  onAnchorConsumed,
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
  const title = detail?.title ?? selection.title ?? selection.identifier;
  const url = detail?.url ?? selection.url;
  const trackerLabel = info?.label ?? (isGitHubTracker(selection.tracker) ? "GitHub" : "Linear");
  const surfaceLum = useSurfaceLuminance("--color-bg-primary");
  const showSkeleton = loading && !detail;

  return (
    <div className="flex flex-col h-full animate-in fade-in-0 duration-200">
      <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        <Button
          variant="ghost"
          size="md"
          onClick={onBack}
          className="shrink-0 -ml-1 leading-none"
          title="Back to issues"
        >
          <CaretLeftIcon size={ICON_SIZE.SM} />
          Issues
        </Button>

        <span className="font-mono text-xs leading-none text-(--color-text-tertiary) truncate">
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
          {loading
            ? <Spinner size={ICON_SIZE.SM} />
            : <ArrowClockwiseIcon size={ICON_SIZE.SM} />}
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

            <h1 className="text-xl font-semibold leading-snug text-(--color-text-primary) mb-4">
              {title}
            </h1>

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
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${label.name}`}
                              onClick={() =>
                                void onSetLabels(
                                  (detail.labels ?? [])
                                    .map((l) => l.name)
                                    .filter((n) => n !== label.name),
                                )
                              }
                              className="ml-0.5 p-0 size-3.5 rounded-full hover:bg-(--color-bg-active) cursor-pointer"
                            >
                              <XIcon size={10} weight="bold" />
                            </Button>
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

            {detail?.description?.trim() ? (
              <MarkdownContent text={detail.description} />
            ) : (
              <p className="text-sm text-(--color-text-tertiary) italic">No description.</p>
            )}

            <IssueComments
              comments={comments}
              loading={commentsLoading}
              error={commentsError}
              onPost={onPostComment}
              anchorCommentId={anchorCommentId}
              onAnchorConsumed={onAnchorConsumed}
            />
          </article>
        )}
      </div>

      {detail && (
        <div className="shrink-0 flex justify-end border-t border-(--color-border-secondary) bg-(--color-bg-secondary) px-4 py-2.5">
          <StartSessionButton
            label="Start session from this issue"
            variant="primary"
            disabled={!canStart}
            onClick={() => onStartSession(detail)}
            repos={repos}
            {...(targetRepoUrl ? { targetRepoUrl } : {})}
            onStartInRepo={(repoUrl) => onStartSession(detail, repoUrl)}
            title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
          />
        </div>
      )}
    </div>
  );
}

function CommentAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return <Avatar name={name} avatarUrl={avatarUrl} alt="" />;
}

function IssueCommentItem({
  comment,
  highlighted,
  registerRef,
}: {
  comment: TrackerComment;
  highlighted?: boolean;
  registerRef?: (el: HTMLLIElement | null) => void;
}) {
  const name = comment.author?.name ?? "Unknown";
  return (
    <li
      ref={registerRef}
      data-comment-id={comment.id}
      className={`flex gap-2 scroll-mt-4 -mx-2 rounded-md px-2 py-1 transition-colors duration-700 ${
        highlighted ? "bg-(--color-bg-hover)" : "bg-transparent"
      }`}
    >
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

function IssueComments({
  comments,
  loading,
  error,
  onPost,
  anchorCommentId,
  onAnchorConsumed,
}: {
  comments: TrackerComment[] | null;
  loading: boolean;
  error: string | null;
  onPost: (body: string) => Promise<string | null>;
  anchorCommentId?: string;
  onAnchorConsumed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Consume stale anchors too, or each thread update retries them forever.
  // eslint-disable-next-line no-restricted-syntax -- browser API sync: scrollIntoView, keyed on the async-arriving thread
  useEffect(() => {
    if (!anchorCommentId || comments === null) return;
    onAnchorConsumed?.();
    const el = itemRefs.current.get(anchorCommentId);
    if (!el) return;
    el.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setHighlightedId(anchorCommentId);
  }, [anchorCommentId, comments, onAnchorConsumed]);

  // Keep this separate so consuming the anchor does not cancel the fade timer.
  // eslint-disable-next-line no-restricted-syntax -- browser API: highlight-fade timer with cleanup
  useEffect(() => {
    if (!highlightedId) return;
    const t = setTimeout(() => setHighlightedId(null), 2200);
    return () => clearTimeout(t);
  }, [highlightedId]);

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
            <IssueCommentItem
              key={c.id}
              comment={c}
              highlighted={c.id === highlightedId}
              registerRef={(el) => {
                if (el) itemRefs.current.set(c.id, el);
                else itemRefs.current.delete(c.id);
              }}
            />
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
