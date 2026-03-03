/**
 * PrLifecycleCard — inline chat card showing the PR lifecycle.
 *
 * Renders differently based on phase: ready (diff stats + create button),
 * creating (spinner), open (PR info + CI status), merged, error.
 * Updates in place when the store state changes.
 */

import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";

// ---- Status indicator icons ----

function FileStatusBadge({ status }: { status: string }) {
  const label =
    status === "A" ? "A" :
    status === "D" ? "D" :
    status === "R" ? "R" :
    "M";

  const color =
    status === "A" ? "text-emerald-400" :
    status === "D" ? "text-red-400" :
    status === "R" ? "text-blue-400" :
    "text-amber-400";

  return <span className={`${color} font-mono text-[10px] w-4 text-center`}>{label}</span>;
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-blue-400" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ---- Phase renderers ----

function ReadyPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);
  const openModal = usePrStore((s) => s.openModal);

  const fileCount = card.files?.length ?? 0;
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-200">
          Claude changed {fileCount} file{fileCount !== 1 ? "s" : ""}
          <span className="ml-2 text-emerald-400">+{ins}</span>
          <span className="ml-1 text-red-400">-{del}</span>
        </span>
      </div>

      {/* File list */}
      {card.files && card.files.length > 0 && (
        <div className="space-y-0.5 text-xs font-mono">
          {card.files.slice(0, 10).map((f) => (
            <div key={f.path} className="flex items-center gap-2 text-gray-400">
              <FileStatusBadge status={f.status} />
              <span className="truncate flex-1">{f.path}</span>
              <span className="text-emerald-400/70 tabular-nums">+{f.insertions}</span>
              <span className="text-red-400/70 tabular-nums">-{f.deletions}</span>
            </div>
          ))}
          {card.files.length > 10 && (
            <div className="text-gray-600 text-[10px]">
              ...and {card.files.length - 10} more
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => quickCreate(sessionId)}
          className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
        >
          Create Pull Request
        </button>
        <button
          onClick={openModal}
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors"
        >
          Create with options...
        </button>
      </div>
    </div>
  );
}

function CreatingPhase() {
  return (
    <div className="flex items-center gap-2 py-1">
      <Spinner />
      <span className="text-sm text-gray-300">Creating pull request...</span>
    </div>
  );
}

function OpenPhase({ card }: { card: PrCardState }) {
  const pr = card.pr;
  const checks = card.checks;
  if (!pr) return null;

  const checksIcon =
    checks?.state === "success" ? { icon: "\u2713", color: "text-emerald-400", label: `CI passed  ${checks.total}/${checks.total} checks` } :
    checks?.state === "failure" ? { icon: "\u2717", color: "text-red-400", label: `CI failed  ${checks.passed}/${checks.total} passed \u00b7 ${checks.failed} failed` } :
    checks?.state === "pending" ? { icon: "\u25D0", color: "text-amber-400 animate-pulse", label: `CI running  ${checks.passed}/${checks.total} checks passed` } :
    null;

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm text-gray-200 font-medium">
          PR #{pr.number}: {pr.title}
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          {pr.baseBranch} \u2190 {pr.headBranch}
          <span className="ml-2 text-emerald-400/60">+{pr.insertions}</span>
          <span className="ml-1 text-red-400/60">-{pr.deletions}</span>
        </div>
      </div>

      {checksIcon && (
        <div className={`flex items-center gap-1.5 text-xs ${checksIcon.color}`}>
          <span className="text-sm">{checksIcon.icon}</span>
          <span>{checksIcon.label}</span>
        </div>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors"
        >
          View PR
        </a>
      </div>
    </div>
  );
}

function MergedPhase({ card }: { card: PrCardState }) {
  const pr = card.pr;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 text-sm">{"\u2713"}</span>
        <span className="text-sm text-gray-200">
          PR #{pr?.number} merged into {pr?.baseBranch}
        </span>
      </div>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors"
        >
          View PR
        </a>
      )}
    </div>
  );
}

function ErrorPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="text-red-400 text-sm">{"\u2717"}</span>
        <div>
          <div className="text-sm text-gray-200">Failed to create pull request</div>
          {card.errorMessage && (
            <div className="text-xs text-gray-500 mt-0.5">&quot;{card.errorMessage}&quot;</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => quickCreate(sessionId)}
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// ---- Main component ----

export function PrLifecycleCard({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  if (!card) return null;

  return (
    <div className="mx-4 my-2 rounded-lg border border-gray-800 bg-gray-900/60 p-4">
      {card.phase === "ready" && <ReadyPhase card={card} sessionId={sessionId} />}
      {card.phase === "creating" && <CreatingPhase />}
      {card.phase === "open" && <OpenPhase card={card} />}
      {card.phase === "merged" && <MergedPhase card={card} />}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} />}
    </div>
  );
}

// ---- Sidebar PR icon ----

export function PrStatusIcon({ sessionId }: { sessionId: string }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  // Determine what to show from either poller status or card state
  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "open" ? "open" : null);
  const checksState = status?.checks?.state ?? card?.checks?.state;

  if (!prState && !card) return null;
  // Only show icon when a PR exists (open or merged)
  if (prState !== "open" && prState !== "merged") return null;

  if (prState === "merged") {
    return <span className="text-purple-400 text-[10px]" title="PR merged">{"\u2442"}</span>;
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

  // PR open but no CI
  return <span className="text-gray-500 text-[10px]" title="PR open">{"\u2442"}</span>;
}
