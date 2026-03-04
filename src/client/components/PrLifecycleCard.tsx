/**
 * PrLifecycleCard — compact inline chat bar showing the PR lifecycle.
 *
 * Single-line design for each phase: ready, creating, open, merged, error.
 * Updates in place when the store state changes.
 *
 * Phase 2 additions: per-check failure list, auto-fix toggle, Fix CI button.
 * Phase 3 additions: merge split button, auto-merge toggle, error messages.
 */

import { useState } from "react";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";

// ---- Shared ----

const linkClass = "text-xs text-gray-400 hover:text-gray-200 transition-colors";
const MAX_VISIBLE_FAILURES = 5;

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function DiffStats({ ins, del }: { ins: number; del: number }) {
  return (
    <span className="text-xs tabular-nums whitespace-nowrap">
      <span className="text-emerald-400">+{ins}</span>
      {" "}
      <span className="text-red-400">-{del}</span>
    </span>
  );
}

function CiIndicator({ checks }: { checks: PrCardState["checks"] }) {
  if (!checks || checks.state === "none") return null;

  if (checks.state === "success") {
    return <span className="text-emerald-400 text-xs" title={`CI passed  ${checks.total}/${checks.total} checks`}>{"\u2713"} CI {checks.total}/{checks.total}</span>;
  }
  if (checks.state === "failure") {
    return (
      <span className="text-red-400 text-xs" title={`CI failed  ${checks.failed} of ${checks.total}`}>
        {"\u2717"} CI {checks.passed}/{checks.total}
      </span>
    );
  }
  // pending
  return <span className="text-amber-400 text-xs animate-pulse" title={`CI running  ${checks.passed}/${checks.total}`}>{"\u25D0"} CI {checks.passed}/{checks.total}</span>;
}

function FailedChecksList({ checks }: { checks: PrCardState["checks"] }) {
  const failedChecks = checks?.failedChecks;
  if (!failedChecks || failedChecks.length === 0) return null;

  const visible = failedChecks.slice(0, MAX_VISIBLE_FAILURES);
  const remaining = failedChecks.length - visible.length;

  return (
    <div className="mt-1 space-y-0.5">
      {visible.map((check) => (
        <div key={check.name} className="text-xs text-gray-400 pl-5">
          <span className="text-red-400">{"\u2717"}</span> {check.name} — <span className="text-gray-500">{check.summary}</span>
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-xs text-gray-500 pl-5">
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
    <button
      onClick={() => toggleAutoFix(sessionId, !enabled)}
      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
      title={enabled ? "Disable auto-fix" : "Enable auto-fix"}
    >
      Auto-fix
      <span className={`inline-block w-6 h-3.5 rounded-full transition-colors ${enabled ? "bg-emerald-600" : "bg-gray-600"}`}>
        <span className={`block w-2.5 h-2.5 mt-0.5 rounded-full bg-white transition-transform ${enabled ? "translate-x-3" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

function AutoMergeToggle({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const toggleAutoMerge = usePrStore((s) => s.toggleAutoMerge);
  const enabled = autoMerge?.enabled ?? false;

  return (
    <button
      onClick={() => toggleAutoMerge(sessionId, !enabled)}
      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
      title={enabled ? "Disable auto-merge" : "Enable auto-merge"}
    >
      Auto-merge
      <span className={`inline-block w-6 h-3.5 rounded-full transition-colors ${enabled ? "bg-emerald-600" : "bg-gray-600"}`}>
        <span className={`block w-2.5 h-2.5 mt-0.5 rounded-full bg-white transition-transform ${enabled ? "translate-x-3" : "translate-x-0.5"}`} />
      </span>
    </button>
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
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [merging, setMerging] = useState(false);

  const method = autoMerge?.mergeMethod ?? "squash";
  const label = MERGE_METHOD_LABELS[method] ?? "Squash and merge";

  const handleMerge = async () => {
    setMerging(true);
    const error = await merge(sessionId, method);
    if (error) {
      setToast({ message: `Merge failed: ${error}` });
    }
    setMerging(false);
  };

  return (
    <div className="relative inline-flex">
      <button
        onClick={handleMerge}
        disabled={merging}
        className="px-2 py-0.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-l transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {merging ? "Merging..." : label}
      </button>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        disabled={merging}
        className="px-1 py-0.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-r border-l border-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Select merge method"
      >
        {"\u25BE"}
      </button>
      {dropdownOpen && (
        <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-lg z-10 min-w-45">
          {(["squash", "merge", "rebase"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMergeMethod(sessionId, m); setDropdownOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors text-left"
            >
              <span className="w-3 text-emerald-400">{m === method ? "\u2713" : ""}</span>
              {MERGE_METHOD_LABELS[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Phase renderers ----

function ReadyPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);
  const [creating, setCreating] = useState(false);
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;
  const hasDiffStats = ins > 0 || del > 0;

  const handleCreate = async () => {
    setCreating(true);
    await quickCreate(sessionId);
    setCreating(false);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-purple-400 text-sm shrink-0">{"\u2442"}</span>
      {card.headBranch && (
        <span className="text-xs text-gray-300 truncate">
          main {"\u2190"} {card.headBranch}
        </span>
      )}
      {hasDiffStats && <DiffStats ins={ins} del={del} />}
      {(card.headBranch || hasDiffStats) && (
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-3 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? "Creating..." : "Create Pull Request"}
        </button>
      )}
    </div>
  );
}

function CreatingPhase() {
  return (
    <div className="flex items-center gap-2">
      <Spinner />
      <span className="text-xs text-gray-300">Creating pull request...</span>
    </div>
  );
}

function OpenPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const pr = card.pr;
  const fixCI = usePrStore((s) => s.fixCI);
  const setToast = useUiStore((s) => s.setToast);
  const [fixingCI, setFixingCI] = useState(false);
  if (!pr) return null;

  const autoFix = card.autoFix;
  const autoMerge = card.autoMerge;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = card.checks?.state === "failure";
  const isCiPassed = card.checks?.state === "success";
  const isCiNone = !card.checks || card.checks.state === "none";
  const canMerge = isCiPassed || isCiNone;
  const showFixButton = isCiFailed && !isAutoFixRunning && (!autoFix?.enabled || isAutoFixExhausted);
  const showMergeButton = canMerge && !autoMerge?.enabled;
  const showAutoMergeToggle = !isCiFailed || isCiPassed;

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
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-purple-400 text-sm shrink-0">{"\u2442"}</span>
        <span className="text-xs text-gray-300 truncate">
          {pr.baseBranch} {"\u2190"} {pr.headBranch}
        </span>
        <DiffStats ins={pr.insertions} del={pr.deletions} />
        <CiIndicator checks={card.checks} />
        {isCiFailed && (
          <AutoFixToggle sessionId={sessionId} autoFix={autoFix} />
        )}
        {showAutoMergeToggle && (
          <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
        )}
        {showMergeButton && (
          <MergeButton sessionId={sessionId} autoMerge={autoMerge} />
        )}
        {showFixButton && (
          <button
            onClick={handleFixCI}
            disabled={fixingCI}
            className="px-2 py-0.5 text-xs font-medium bg-red-600/80 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fixingCI ? "Fixing..." : "Fix CI Issues"}
          </button>
        )}
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          View PR
        </a>
      </div>
      {autoMerge?.enabled && !isCiPassed && !isCiNone && (
        <div className="mt-1 text-xs text-gray-400 pl-5">
          Will merge when CI passes
        </div>
      )}
      {autoMerge?.error && (
        <div className="mt-1 text-xs text-amber-400 pl-5">
          {"\u26A0"} {autoMerge.error.message}{" "}
          <a
            href={autoMerge.error.settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-amber-300"
          >
            {autoMerge.error.code === "auto_merge_not_enabled" ? "Enable in repository settings" : "Configure branch protection"}
          </a>
        </div>
      )}
      {isAutoFixRunning && (
        <div className="mt-1 flex items-center gap-2 pl-5">
          <Spinner />
          <span className="text-xs text-amber-400">
            Auto-fixing (attempt {autoFix.attemptCount}/{autoFix.maxAttempts})...
          </span>
        </div>
      )}
      {isAutoFixExhausted && (
        <div className="mt-1 text-xs text-gray-500 pl-5">
          Auto-fix exhausted ({autoFix.maxAttempts}/{autoFix.maxAttempts} attempts)
        </div>
      )}
      {isCiFailed && !isAutoFixRunning && <FailedChecksList checks={card.checks} />}
    </div>
  );
}

function MergedPhase({ card }: { card: PrCardState }) {
  const pr = card.pr;

  return (
    <div className="flex items-center gap-3">
      <span className="text-purple-400 text-sm shrink-0">{"\u2713"}</span>
      <span className="text-xs text-gray-300">
        PR #{pr?.number} merged into {pr?.baseBranch}
      </span>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          View PR
        </a>
      )}
    </div>
  );
}

function ClosedPhase({ card }: { card: PrCardState }) {
  const pr = card.pr;

  return (
    <div className="flex items-center gap-3">
      <span className="text-gray-400 text-sm shrink-0">{"\u2442"}</span>
      <span className="text-xs text-gray-400">
        PR #{pr?.number} closed
      </span>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          View PR
        </a>
      )}
    </div>
  );
}

/** Render error text with inline links (https://...) and backtick-highlighted terms (`word`). */
function RichErrorText({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/\S+|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("https://")) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{part}</a>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="text-xs bg-gray-800 px-1 py-0.5 rounded text-gray-200">{part.slice(1, -1)}</code>;
    }
    return part;
  });
  return <>{parts}</>;
}

function ErrorPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);
  const [retrying, setRetrying] = useState(false);
  const lines = card.errorMessage?.split("\n") ?? [];

  const handleRetry = async () => {
    setRetrying(true);
    await quickCreate(sessionId);
    setRetrying(false);
  };

  return (
    <div className="flex items-start gap-3">
      <span className="text-red-400 text-xs shrink-0 mt-0.5">{"\u2717"}</span>
      <span className="text-xs text-gray-300 wrap-break-word min-w-0">
        Failed to create PR{lines.length > 0 && ": "}
        {lines.map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            <RichErrorText text={line} />
          </span>
        ))}
      </span>
      <button
        onClick={handleRetry}
        disabled={retrying}
        className="text-xs text-gray-400 hover:text-gray-200 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {retrying ? "Retrying..." : "Retry"}
      </button>
    </div>
  );
}

// ---- Main component ----

export function PrLifecycleCard({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  if (!card) return null;

  return (
    <div className="mx-4 my-2 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-2">
      {card.phase === "ready" && <ReadyPhase card={card} sessionId={sessionId} />}
      {card.phase === "creating" && <CreatingPhase />}
      {card.phase === "open" && <OpenPhase card={card} sessionId={sessionId} />}
      {card.phase === "merged" && <MergedPhase card={card} />}
      {card.phase === "closed" && <ClosedPhase card={card} />}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} />}
    </div>
  );
}

// ---- Sidebar PR icon ----

export function PrStatusIcon({ sessionId }: { sessionId: string }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "closed" ? "closed" : card?.phase === "open" ? "open" : null);
  const checksState = status?.checks?.state ?? card?.checks?.state;

  if (!prState && !card) return null;
  if (prState !== "open" && prState !== "merged" && prState !== "closed") return null;

  if (prState === "merged") {
    return <span className="text-purple-400 text-[10px]" title="PR merged">{"\u2442"}</span>;
  }
  if (prState === "closed") {
    return <span className="text-gray-500 text-[10px]" title="PR closed">{"\u2442"}</span>;
  }

  if (checksState === "success") {
    return (
      <span className="text-emerald-400 text-[10px]" title="CI passed">
        {"\u2442"} {"\u2713"}
      </span>
    );
  }
  if (checksState === "failure") {
    return (
      <span className="text-red-400 text-[10px]" title="CI failed">
        {"\u2442"} {"\u2717"}
      </span>
    );
  }
  if (checksState === "pending") {
    return (
      <span className="text-amber-400 text-[10px] animate-pulse" title="CI running">
        {"\u2442"}
      </span>
    );
  }

  return <span className="text-gray-500 text-[10px]" title="PR open">{"\u2442"}</span>;
}
