/**
 * PrLifecycleCard — compact inline chat bar showing the PR lifecycle.
 *
 * Single-line design for each phase: ready, creating, open, merged, error.
 * Updates in place when the store state changes.
 */

import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";

// ---- Shared ----

const linkClass = "text-xs text-gray-400 hover:text-gray-200 transition-colors";

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
    return <span className="text-emerald-400 text-xs" title={`CI passed  ${checks.total}/${checks.total} checks`}>{"\u2713"} CI</span>;
  }
  if (checks.state === "failure") {
    return <span className="text-red-400 text-xs" title={`CI failed  ${checks.failed} of ${checks.total}`}>{"\u2717"} CI</span>;
  }
  // pending
  return <span className="text-amber-400 text-xs animate-pulse" title={`CI running  ${checks.passed}/${checks.total}`}>{"\u25D0"} CI</span>;
}

// ---- Phase renderers (all single-line) ----

function ReadyPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;

  return (
    <div className="flex items-center gap-3">
      <DiffStats ins={ins} del={del} />
      <button
        onClick={() => quickCreate(sessionId)}
        className="px-3 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
      >
        Create Pull Request
      </button>
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

function OpenPhase({ card }: { card: PrCardState }) {
  const pr = card.pr;
  if (!pr) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-purple-400 text-sm shrink-0">{"\u2442"}</span>
      <span className="text-xs text-gray-300 truncate">
        {pr.baseBranch} {"\u2190"} {pr.headBranch}
      </span>
      <DiffStats ins={pr.insertions} del={pr.deletions} />
      <CiIndicator checks={card.checks} />
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        View PR
      </a>
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

function ErrorPhase({ card, sessionId }: { card: PrCardState; sessionId: string }) {
  const quickCreate = usePrStore((s) => s.quickCreate);

  return (
    <div className="flex items-center gap-3">
      <span className="text-red-400 text-xs shrink-0">{"\u2717"}</span>
      <span className="text-xs text-gray-300 truncate">
        Failed to create PR{card.errorMessage ? `: ${card.errorMessage}` : ""}
      </span>
      <button
        onClick={() => quickCreate(sessionId)}
        className="text-xs text-gray-400 hover:text-gray-200 transition-colors shrink-0"
      >
        Retry
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

  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "open" ? "open" : null);
  const checksState = status?.checks?.state ?? card?.checks?.state;

  if (!prState && !card) return null;
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

  return <span className="text-gray-500 text-[10px]" title="PR open">{"\u2442"}</span>;
}
