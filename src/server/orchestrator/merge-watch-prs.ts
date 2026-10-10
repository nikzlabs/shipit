import type { SessionMergeWatch, SessionMergeWatchPr } from "../shared/types.js";

// Past this many, a new PR is not kept; the child's PR snapshot still shows the latest one.
export const MAX_UNREPORTED_PRS = 20;

interface PrOutcome {
  prNumber: number;
  outcome: "merged" | "closed";
}

export function samePrOutcome(a: PrOutcome | undefined, b: PrOutcome): boolean {
  return a?.prNumber === b.prNumber && a.outcome === b.outcome;
}

/** The PRs that a parent's watch still owes its parent, oldest first. */
export function unreportedPrs(watch: SessionMergeWatch): SessionMergeWatchPr[] {
  return (watch.unreportedPrs ?? []).filter((pr) => !samePrOutcome(watch.reportedPr, pr));
}

export function addUnreportedPr(
  prs: SessionMergeWatchPr[],
  pr: SessionMergeWatchPr,
  where: "first" | "last",
): SessionMergeWatchPr[] {
  const others = prs.filter((kept) => !samePrOutcome(kept, pr));
  if (where === "first") return [pr, ...others].slice(0, MAX_UNREPORTED_PRS);
  if (others.length < prs.length || prs.length >= MAX_UNREPORTED_PRS) return prs;
  return [...prs, pr];
}

export function withUnreportedPrs(watch: SessionMergeWatch, prs: SessionMergeWatchPr[]): SessionMergeWatch {
  const { unreportedPrs: _previous, ...rest } = watch;
  const owed = prs.filter((pr) => !samePrOutcome(rest.reportedPr, pr));
  return owed.length > 0 ? { ...rest, unreportedPrs: owed } : rest;
}
