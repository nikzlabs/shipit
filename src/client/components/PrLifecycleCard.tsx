/**
 * PrLifecycleCard — compact inline chat bar showing the PR lifecycle.
 *
 * Single-line design for each phase: ready, creating, open, merged, error.
 * Updates in place when the store state changes.
 *
 * Phase 2 additions: per-check failure list, auto-fix toggle, Fix CI button.
 * Phase 3 additions: merge split button, auto-merge toggle, error messages.
 */

import { useState, useCallback } from "react";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { MarkdownContent } from "./message-markdown.js";
import {
  GitBranchIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  CaretDownIcon,
  WarningIcon,
  InfoIcon,
  GlobeIcon,
  DotsThreeVerticalIcon,
} from "@phosphor-icons/react";
import type { GitHubDeploymentStatus } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";

// ---- Shared ----

const linkClass = "h-6 inline-flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) transition-colors border border-(--color-border-secondary) rounded px-1.5";
const MAX_VISIBLE_FAILURES = 5;

const DEFAULT_BRANCHES = new Set(["main", "master"]);
function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}

function Spinner() {
  return (
    <CircleNotchIcon size={14} className="animate-spin text-(--color-info) shrink-0" />
  );
}

function DiffStats({ ins, del, onClick }: { ins: number; del: number; onClick?: () => void }) {
  const content = (
    <>
      <span className="text-(--color-success)">+{ins}</span>
      <span className="text-(--color-error)">-{del}</span>
    </>
  );
  if (!onClick) {
    return <span className={`${linkClass} shrink-0`}>{content}</span>;
  }
  return (
    <button onClick={onClick} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">
      {content}
    </button>
  );
}

/** Fetch diff of HEAD vs a base branch and open it in the diff dialog. */
function useOpenPrDiff(baseBranch?: string) {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useCallback(async () => {
    if (!sessionId) return;
    const base = baseBranch || "main";
    try {
      await useGitStore.getState().fetchDiffVsBranch(sessionId, base);
      useGitStore.getState().openDiffDialog(`Changes vs ${base}`);
    } catch {
      // Silently fail
    }
  }, [sessionId, baseBranch]);
}

/**
 * Displays branch info, or — when a PR exists — the PR title with the PR body
 * surfaced in a rich tooltip. Clicking always copies the head branch name.
 *
 * Rendering rules:
 *   - `prTitle` set       → render `prTitle`; tooltip shows full `prBody`
 *                            rendered as markdown (or a fallback hint when
 *                            the PR has no description). The tooltip caps its
 *                            height and scrolls — content is never truncated.
 *   - `prTitle` unset, non-default base → "base ← head".
 *   - otherwise            → just `headBranch`.
 */
function BranchLabel({
  baseBranch,
  headBranch,
  prTitle,
  prBody,
}: {
  baseBranch?: string;
  headBranch?: string;
  prTitle?: string;
  prBody?: string;
}) {
  const setToast = useUiStore((s) => s.setToast);
  if (!headBranch) return null;

  const handleCopy = () => {
    void navigator.clipboard.writeText(headBranch);
    setToast({ message: "Branch name copied" });
  };

  const buttonClass =
    "h-6 text-xs flex items-center gap-1 min-w-0 overflow-hidden text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors cursor-pointer";

  // Branch-only rendering (ready phase, or open phase without a title yet).
  if (!prTitle) {
    const content = baseBranch && !isDefaultBranch(baseBranch) ? (
      <>{baseBranch} <span className="text-(--color-text-tertiary)">←</span> {headBranch}</>
    ) : headBranch;
    return (
      <button onClick={handleCopy} title="Copy branch name" className={buttonClass}>
        <span className="truncate">{content}</span>
      </button>
    );
  }

  // PR-title rendering — tooltip shows the full description as markdown.
  // No truncation; the tooltip caps its own height and scrolls instead.
  const trimmedBody = (prBody ?? "").trim();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            aria-label={`Copy branch name ${headBranch}`}
            className={buttonClass}
          >
            <span className="truncate">{prTitle}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-lg max-h-96 flex flex-col overflow-hidden text-left p-0"
        >
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {trimmedBody.length > 0 ? (
              <MarkdownContent text={trimmedBody} />
            ) : (
              <div className="text-(--color-text-primary)">No description</div>
            )}
          </div>
          <div className="shrink-0 border-t border-(--color-border-secondary) text-(--color-text-tertiary) text-xs px-3 py-2">
            Click to copy <span className="font-mono">{headBranch}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Three-dot overflow menu for secondary actions (auto-merge, auto-fix, etc.). */
function OverflowMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative shrink-0 -mr-2">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="h-6 w-6 flex items-center justify-center rounded text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
        aria-label="More options"
      >
        <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 bottom-full mb-1 z-50 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-xl py-1 min-w-48"
            onClick={(e) => e.stopPropagation()}>
            {children}
          </div>
        </>
      )}
    </span>
  );
}

/** Reusable toggle switch for auto-fix / auto-merge. */
function ToggleSwitch({ label, enabled, onToggle, title }: { label: string; enabled: boolean; onToggle: () => void; title: string }) {
  return (
    <Button variant="ghost" size="sm" onClick={onToggle} title={title}>
      <span className={`inline-block w-6 h-3.5 rounded-full transition-colors ${enabled ? "bg-(--color-success)" : "bg-(--color-text-tertiary)"}`}>
        <span className={`block w-2.5 h-2.5 mt-0.5 rounded-full bg-(--color-text-inverse) transition-transform ${enabled ? "translate-x-3" : "translate-x-0.5"}`} />
      </span>
      {label}
    </Button>
  );
}

function CiIndicator({ checks }: { checks: PrCardState["checks"] }) {
  if (!checks || checks.state === "none") return null;

  if (checks.state === "success") {
    return (
      <span className="h-6 text-(--color-success) text-xs flex items-center gap-1 shrink-0" title={`CI passed  ${checks.total}/${checks.total} checks`}>
        <CheckCircleIcon size={ICON_SIZE.SM} /> CI {checks.total}/{checks.total}
      </span>
    );
  }
  if (checks.state === "failure") {
    return (
      <span className="h-6 text-(--color-error) text-xs flex items-center gap-1 shrink-0" title={`CI failed  ${checks.failed} of ${checks.total}`}>
        <XCircleIcon size={ICON_SIZE.SM} /> CI {checks.passed}/{checks.total}
      </span>
    );
  }
  // pending
  const pendingLabel = checks.total === 0 ? "CI" : `CI ${checks.passed}/${checks.total}`;
  const pendingTitle = checks.total === 0 ? "Waiting for CI checks to start" : `CI running  ${checks.passed}/${checks.total}`;
  return (
    <span className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0 animate-pulse" title={pendingTitle}>
      <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" /> {pendingLabel}
    </span>
  );
}

/**
 * MergeConflictIndicator — surfaces GitHub's `CONFLICTING` mergeable state.
 *
 * Renders a warning-tone label next to the CI indicator when the PR cannot
 * be merged because the base branch has diverged. Only shown when the
 * GitHub poller has explicitly observed `"conflicting"` — `"unknown"` is
 * treated as neutral to avoid flicker after a push (see OpenPhase comment).
 */
function MergeConflictIndicator() {
  return (
    <span
      className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0"
      title="Branch has merge conflicts with the base branch. Use Resolve conflicts to rebase and let the agent fix them."
    >
      <WarningIcon size={ICON_SIZE.SM} /> Merge conflicts
    </span>
  );
}

/**
 * ResolveConflictsButton — one-click trigger for the rebase driver.
 *
 * Per docs/113-pr-mergeable-state, this is a deliberate exception to the
 * "chat is the input surface" principle: clicking immediately fires the
 * rebase flow (which spawns its own agent turn for conflict resolution)
 * with no chat prefill or confirmation step. The button is disabled while
 * the agent is in another turn — we don't queue actions whose
 * preconditions might change before they run.
 */
function ResolveConflictsButton({ sessionId, baseBranch }: { sessionId: string; baseBranch: string }) {
  const startRebase = useGitStore((s) => s.startRebase);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const [starting, setStarting] = useState(false);

  const handleClick = async () => {
    if (isAgentRunning || starting) return;
    setStarting(true);
    try {
      await startRebase(sessionId, baseBranch);
    } finally {
      // Clear the local "starting" flag once the request returns. Subsequent
      // UI state (in-progress, conflicts, resolving) is driven by WS events
      // and rendered by RebaseBanner — see Phase 5 visibility coordination.
      setStarting(false);
    }
  };

  const title = isAgentRunning
    ? "Wait for the agent to finish before resolving conflicts"
    : "Rebase onto the base branch and let the agent resolve conflicts";

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={isAgentRunning || starting}
      title={title}
      onClick={handleClick}
      className="shrink-0 h-6"
    >
      {starting ? "Starting..." : "Resolve conflicts"}
    </Button>
  );
}

function FailedChecksList({ checks }: { checks: PrCardState["checks"] }) {
  const failedChecks = checks?.failedChecks;
  if (!failedChecks || failedChecks.length === 0) return null;

  const visible = failedChecks.slice(0, MAX_VISIBLE_FAILURES);
  const remaining = failedChecks.length - visible.length;

  return (
    <div className="mt-1 space-y-0.5">
      {visible.map((check) => (
        <div key={check.name} className="text-xs text-(--color-text-secondary) pl-5">
          <XCircleIcon size={12} className="inline text-(--color-error)" /> {check.name} — <span className="text-(--color-text-tertiary)">{check.summary}</span>
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-xs text-(--color-text-tertiary) pl-5">
          and {remaining} more...
        </div>
      )}
    </div>
  );
}

function AutoFixToggle({ sessionId, autoFix }: { sessionId: string; autoFix?: PrCardState["autoFix"] }) {
  const toggleAutoFix = usePrStore((s) => s.toggleAutoFix);
  const enabled = autoFix?.enabled ?? false;

  return (
    <ToggleSwitch
      label="Auto-fix"
      enabled={enabled}
      onToggle={() => toggleAutoFix(sessionId, !enabled)}
      title={enabled ? "Disable auto-fix" : "Enable auto-fix"}
    />
  );
}

/** Hover tooltip explaining ShipIt-managed auto-merge with a link to GitHub settings. */
function ManagedMergeInfo({ settingsUrl }: { settingsUrl?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <InfoIcon size={ICON_SIZE.XS} className="text-(--color-text-secondary) cursor-help" />
      {visible && (
        <div className="absolute left-0 bottom-full z-50 pb-1">
          <div className="w-64 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) shadow-xl p-2.5 text-xs text-(--color-text-secondary)">
            GitHub auto-merge requires branch protection rules. ShipIt will merge this PR when CI passes.
            {settingsUrl && (
              <a href={settingsUrl} target="_blank" rel="noopener noreferrer"
                className="block mt-1 underline hover:opacity-80 text-(--color-text-link)">
                Configure in GitHub settings
              </a>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function AutoMergeToggle({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const toggleAutoMerge = usePrStore((s) => s.toggleAutoMerge);
  const enabled = autoMerge?.enabled ?? false;

  return (
    <span className="flex items-center gap-1">
      <ToggleSwitch
        label="Auto-merge"
        enabled={enabled}
        onToggle={() => toggleAutoMerge(sessionId, !enabled)}
        title={enabled ? "Disable auto-merge" : "Enable auto-merge"}
      />
      {autoMerge?.managed && <ManagedMergeInfo settingsUrl={autoMerge.settingsUrl} />}
    </span>
  );
}

const MERGE_METHOD_LABELS: Record<string, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

function MergeButton({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const merge = usePrStore((s) => s.merge);
  const setMergeMethod = usePrStore((s) => s.setMergeMethod);
  const setToast = useUiStore((s) => s.setToast);
  // Block merge while the agent is mid-turn — auto-commit fires after the
  // turn ends, so a click now could ship a PR whose later commits land on
  // a closed branch. The server enforces the same guard (POST /pr/merge
  // returns 409) but disabling client-side is what the user actually sees.
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [merging, setMerging] = useState(false);

  const method = autoMerge?.mergeMethod ?? "squash";
  const label = MERGE_METHOD_LABELS[method] ?? "Squash and merge";
  const disabled = merging || isAgentRunning;
  const title = isAgentRunning
    ? "Agent is still working — merge will be available when the turn finishes"
    : undefined;

  const handleMerge = async () => {
    if (disabled) return;
    setMerging(true);
    const error = await merge(sessionId, method);
    if (error) {
      setToast({ message: `Merge failed: ${error}` });
      setMerging(false);
    }
    // On success, keep merging=true — the card will transition to "merged" phase
    // via the optimistic store update, so this component unmounts.
  };

  return (
    <div className="relative inline-flex">
      <button
        onClick={handleMerge}
        disabled={disabled}
        title={title}
        className="h-6 px-2 text-xs font-medium whitespace-nowrap bg-(--color-success) hover:opacity-90 text-(--color-text-inverse) rounded-l transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {merging ? "Merging..." : label}
      </button>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        disabled={disabled}
        title={title}
        className="h-6 px-1 text-xs font-medium bg-(--color-success) hover:opacity-90 text-(--color-text-inverse) rounded-r border-l border-black/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Select merge method"
      >
        <CaretDownIcon size={12} />
      </button>
      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
          <div className="absolute bottom-full right-0 mb-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-md shadow-lg z-50 min-w-45">
            {(["squash", "merge", "rebase"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { void setMergeMethod(sessionId, m); setDropdownOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors text-left"
              >
                <span className="w-3 text-(--color-success)">{m === method ? <CheckCircleIcon size={12} /> : ""}</span>
                {MERGE_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Deployment status ----

function DeploymentStatusRow({ deployments }: { deployments: GitHubDeploymentStatus[] }) {
  if (deployments.length === 0) return null;

  return (
    <div className="mt-1.5 pl-5 flex flex-col gap-1">
      {deployments.map((d, i) => {
        const isActive = d.state === "success";
        const isPending = d.state === "pending" || d.state === "in_progress" || d.state === "queued";
        const isFailed = d.state === "failure" || d.state === "error";
        return (
          <div key={`${d.environment}-${i}`} className="flex items-center gap-1.5 text-xs">
            {isPending && <CircleNotchIcon size={12} className="text-(--color-warning) animate-spin shrink-0" />}
            {isActive && <GlobeIcon size={12} className="text-(--color-success) shrink-0" />}
            {isFailed && <XCircleIcon size={12} className="text-(--color-error) shrink-0" />}
            {!isPending && !isActive && !isFailed && <GlobeIcon size={12} className="text-(--color-text-tertiary) shrink-0" />}
            <span className="text-(--color-text-secondary)">{d.environment}</span>
            {d.environmentUrl && (
              <a href={d.environmentUrl} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:text-(--color-accent) truncate max-w-xs">
                {(() => { try { return new URL(d.environmentUrl).hostname; } catch { return d.environmentUrl; } })()}
              </a>
            )}
            {d.creator && <span className="text-(--color-text-tertiary)">via {d.creator}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---- Phase renderers ----

// Note: the global "Auto-create PR after every meaningful turn" toggle was
// previously rendered here in an overflow menu. It moved to Settings → GitHub
// because the ready-phase card only appears for sessions without a PR (and is
// transient when auto-create is on), which made the toggle effectively
// undiscoverable. See docs/099-auto-pr-on-meaningful-turn/plan.md.

function ReadyPhase({
  card,
  sessionId,
  creating: externalCreating,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  creating?: boolean;
  onCreatePr?: () => void;
}) {
  const prCreationTurnRunning = useSessionStore((s) => s.isLoading && s.activity?.label === "Creating PR...");
  const creating = Boolean(externalCreating) || prCreationTurnRunning;
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;
  const hasDiffStats = ins > 0 || del > 0;
  const openDiff = useOpenPrDiff();

  return (
    <div className="flex items-center gap-3 flex-nowrap">
      <PrStateBadge sessionId={sessionId} />
      <BranchLabel headBranch={card.headBranch} />
      {hasDiffStats && (
        <span className="ml-auto shrink-0 flex items-center gap-3">
          <DiffStats ins={ins} del={del} onClick={openDiff} />
          <Button
            size="sm"
            onClick={onCreatePr}
            disabled={creating || !onCreatePr}
            className="shrink-0 h-6 bg-(--color-success) hover:bg-(--color-success) hover:opacity-90 text-(--color-text-inverse)"
          >
            {creating && <CircleNotchIcon size={14} className="animate-spin" />}
            {creating ? "Creating PR..." : "Create PR"}
          </Button>
        </span>
      )}
    </div>
  );
}

function OpenPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const pr = card.pr;
  const fixCI = usePrStore((s) => s.fixCI);
  const setToast = useUiStore((s) => s.setToast);
  const deployments = usePrStore((s) => s.statusBySession[sessionId]?.deployments);
  const mergeable = usePrStore((s) => s.statusBySession[sessionId]?.mergeable);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const [fixingCI, setFixingCI] = useState(false);
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  if (!pr) return null;

  const autoFix = card.autoFix;
  const autoMerge = card.autoMerge;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = card.checks?.state === "failure";
  const isCiPassed = card.checks?.state === "success";
  // "none" must come from the poller explicitly — undefined means we haven't
  // heard from the poller yet, so we don't know whether CI exists. Treating
  // undefined as "none" would let the merge button appear in the gap between
  // PR creation and the first poll, before pending workflows have registered.
  // The poller also force-overrides "none" → "pending" for a grace window
  // when the repo runs CI but GitHub hasn't registered any checks for the
  // current head SHA. Once that grace expires (e.g., docs-only PRs whose
  // changed paths don't match any workflow's `paths:` filter), the state
  // legitimately becomes "none" and the merge button appears.
  const isCiNone = card.checks?.state === "none";
  const isConflicting = mergeable === "conflicting";
  // Merge button visibility: gate on CI state AND on GitHub-reported
  // mergeability. Don't gate on `mergeable === "unknown"` — that's the brief
  // window after each push while GitHub computes mergeability, and gating
  // would flicker the button off-on every push. The cost of a stale click
  // during that window is bounded (the merge attempt fails with a toast).
  const canMerge = (isCiPassed || isCiNone) && !isConflicting;
  const showFixButton = isCiFailed && !isAutoFixRunning && (!autoFix?.enabled || isAutoFixExhausted);
  const showMergeButton = canMerge && !autoMerge?.enabled;
  const showAutoMergeToggle = !isCiFailed || isCiPassed;
  // The inline conflict UI yields to the RebaseBanner once a rebase is
  // active — RebaseBanner is the surface for the in-flight flow. The
  // indicator and Resolve button reappear if the rebase aborts back to
  // the conflict state.
  const showConflictUi = isConflicting && rebaseStatus === "idle";

  const handleFixCI = async () => {
    setFixingCI(true);
    const error = await fixCI(sessionId);
    if (error) {
      setToast({ message: `Fix CI failed: ${error}` });
    }
    setFixingCI(false);
  };

  return (
    <div>
      <div className="flex items-center gap-3 flex-nowrap">
        <PrStateBadge sessionId={sessionId} url={pr.url} prNumber={pr.number} />
        <BranchLabel
          baseBranch={pr.baseBranch}
          headBranch={pr.headBranch}
          prTitle={pr.title}
          prBody={pr.body}
        />
        <span className="ml-auto shrink-0 flex items-center gap-3">
          <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
          <CiIndicator checks={card.checks} />
          {showConflictUi && <MergeConflictIndicator />}
          {showConflictUi && (
            <ResolveConflictsButton sessionId={sessionId} baseBranch={pr.baseBranch} />
          )}
          {showMergeButton && (
            <MergeButton sessionId={sessionId} autoMerge={autoMerge} />
          )}
          {showFixButton && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleFixCI}
              disabled={fixingCI}
              className="shrink-0 h-6"
            >
              {fixingCI ? "Fixing..." : "Fix CI"}
            </Button>
          )}
          <OverflowMenu>
          {showAutoMergeToggle && (
            <div className="px-2 py-1">
              <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
            </div>
          )}
          {isCiFailed && (
            <div className="px-2 py-1">
              <AutoFixToggle sessionId={sessionId} autoFix={autoFix} />
            </div>
          )}
        </OverflowMenu>
        </span>
      </div>
      {autoMerge?.enabled && !isCiPassed && !isCiNone && (
        <div className="mt-1 text-xs text-(--color-text-secondary) pl-5">
          Will merge when CI passes
        </div>
      )}
      {autoMerge?.error && autoMerge.managed && (
        <div className="mt-1 text-xs text-(--color-warning) pl-5 flex items-center gap-1">
          <WarningIcon size={12} /> {autoMerge.error.message}
        </div>
      )}
      {autoMerge?.error && !autoMerge.managed && (
        <div className="mt-1 text-xs text-(--color-warning) pl-5 flex items-center gap-1">
          <WarningIcon size={12} /> {autoMerge.error.message}{" "}
          <a
            href={autoMerge.error.settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:opacity-80"
          >
            {autoMerge.error.code === "auto_merge_not_enabled" ? "Enable in repository settings" : "Configure branch protection"}
          </a>
        </div>
      )}
      {isAutoFixRunning && (
        <div className="mt-1 flex items-center gap-2 pl-5">
          <Spinner />
          <span className="text-xs text-(--color-warning)">
            Auto-fixing (attempt {autoFix.attemptCount}/{autoFix.maxAttempts})...
          </span>
        </div>
      )}
      {isAutoFixExhausted && (
        <div className="mt-1 text-xs text-(--color-text-tertiary) pl-5">
          Auto-fix exhausted ({autoFix.maxAttempts}/{autoFix.maxAttempts} attempts)
        </div>
      )}
      {isCiFailed && !isAutoFixRunning && <FailedChecksList checks={card.checks} />}
      {deployments && deployments.length > 0 && <DeploymentStatusRow deployments={deployments} />}
    </div>
  );
}

function TerminalPhase({ card, sessionId, text }: { card: PrCardState; sessionId: string; text: string }) {
  const pr = card.pr;
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  const hasDiffStats = pr && (pr.insertions > 0 || pr.deletions > 0);
  return (
    <div className="flex items-center gap-3 flex-nowrap">
      <PrStateBadge sessionId={sessionId} url={pr?.url} prNumber={pr?.number} />
      <span className="h-6 flex items-center text-xs text-(--color-text-secondary) truncate min-w-0">{text}</span>
      {pr && (
        <span className="ml-auto shrink-0">
          {hasDiffStats
            ? <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
            : <button onClick={openDiff} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">Diff</button>
          }
        </span>
      )}
    </div>
  );
}

/** Render error text with inline links (https://...) and backtick-highlighted terms (`word`). */
function RichErrorText({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/\S+|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("https://")) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:opacity-80 underline">{part}</a>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="text-xs bg-(--color-bg-tertiary) px-1 py-0.5 rounded text-(--color-text-primary)">{part.slice(1, -1)}</code>;
    }
    return part;
  });
  return <>{parts}</>;
}

function ErrorPhase({
  card,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  onCreatePr?: () => void;
}) {
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const agentRunning = useSessionStore((s) => s.isLoading);
  const lines = card.errorMessage?.split("\n") ?? [];
  const isAuthError = card.errorKind === "auth";

  const handleSignIn = () => {
    setSettingsTab("github");
    setSettingsOpen(true);
  };

  return (
    <div className="flex items-start gap-3">
      <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0 mt-0.5" />
      <span className="text-xs text-(--color-text-secondary) wrap-break-word min-w-0">
        Failed to create PR{lines.length > 0 && ": "}
        {lines.map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            <RichErrorText text={line} />
          </span>
        ))}
        {isAuthError && (
          <>
            <br />
            Your GitHub token is missing or expired — reconnect to keep pushing.
          </>
        )}
      </span>
      {isAuthError && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignIn}
          className="shrink-0"
        >
          Sign in to GitHub
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onCreatePr}
        disabled={agentRunning || !onCreatePr}
        className="shrink-0"
      >
        {agentRunning ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}

// ---- Main component ----

export function PrLifecycleCard({
  sessionId,
  onOpenDetails,
  onCreatePr,
}: {
  sessionId: string;
  onOpenDetails?: () => void;
  /** Ask the agent to create a PR. The agent has context the orchestrator doesn't, so it can pick a good title and write a proper Summary/Changes/Test plan body. */
  onCreatePr?: () => void;
}) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  if (!card) return null;

  // The whole card body opens the PR detail tab, but only once a PR exists
  // (open/merged/closed) — the ready/creating/error phases have no PR to
  // drill into. Clicks that originate on an interactive control (button, link,
  // input) are ignored via the closest() guard, so toggling auto-fix, merging,
  // or copying the branch never also switches the tab — no per-control
  // stopPropagation needed. See docs/133.
  const hasPr = !!card.pr && (card.phase === "open" || card.phase === "merged" || card.phase === "closed");
  const clickable = hasPr && !!onOpenDetails;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    onOpenDetails?.();
  };

  // Key the inner subtree on sessionId so transient per-session UI state
  // (e.g. MergeButton's "Merging..." flag, CreatePR's "Creating..." flag,
  // OpenPhase's "Fixing..." flag) resets when the user switches sessions.
  // Without this, switching sessions while a merge is in flight leaves the
  // button stuck on "Merging..." against the new session.
  return (
    <div
      key={sessionId}
      onClick={handleClick}
      title={clickable ? "Open PR details" : undefined}
      className={`mx-4 rounded-t-xl border border-b-0 border-(--color-border-primary) bg-(--color-bg-secondary)/20 px-4 py-2 ${clickable ? "cursor-pointer hover:bg-(--color-bg-hover)/40 transition-colors" : ""}`}
    >
      {(card.phase === "ready" || card.phase === "creating") && <ReadyPhase card={card} sessionId={sessionId} creating={card.phase === "creating"} onCreatePr={onCreatePr} />}
      {card.phase === "open" && <OpenPhase card={card} sessionId={sessionId} />}
      {card.phase === "merged" && (
        <TerminalPhase card={card} sessionId={sessionId}
          text={`Merged: ${card.pr?.title ?? `PR #${card.pr?.number}`}${card.pr?.baseBranch && !isDefaultBranch(card.pr.baseBranch) ? ` into ${card.pr.baseBranch}` : ""}`}
        />
      )}
      {card.phase === "closed" && (
        <TerminalPhase card={card} sessionId={sessionId} text={`PR #${card.pr?.number} closed`} />
      )}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} onCreatePr={onCreatePr} />}
    </div>
  );
}

// ---- PR state badge (reused in sidebar + card phases) ----

export function PrStateBadge({ sessionId, url, prNumber }: { sessionId: string; url?: string; prNumber?: number }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "closed" ? "closed" : card?.phase === "open" ? "open" : null);

  const base = "w-5 h-5 rounded-md flex items-center justify-center shrink-0 border";

  let className: string;
  let title: string;
  let icon: React.ReactNode;

  if (prState === "merged") {
    className = `${base} bg-(--color-pr-subtle) text-(--color-pr) border-(--color-pr-border)`;
    title = prNumber ? `PR #${prNumber} merged` : "PR merged";
    icon = <GitMergeIcon size={ICON_SIZE.SM} />;
  } else if (prState === "open") {
    className = `${base} bg-(--color-success-subtle) text-(--color-success) border-(--color-success-border)`;
    title = prNumber ? `PR #${prNumber}` : "PR open";
    icon = <GitPullRequestIcon size={ICON_SIZE.SM} />;
  } else {
    className = `${base} bg-(--color-bg-tertiary) text-(--color-text-tertiary) border-(--color-border-secondary)`;
    title = prState === "closed" ? (prNumber ? `PR #${prNumber} closed` : "PR closed") : "Branch";
    icon = <GitBranchIcon size={ICON_SIZE.SM} />;
  }

  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`${className} hover:opacity-80 transition-opacity`} title={title}>
        {icon}
      </a>
    );
  }
  return <span className={className} title={title}>{icon}</span>;
}
