import type { GitHubAuthManager } from "../github-auth.js";

// Read both SHAs and the aggregate rollup; a bounded check list can omit failures.
export const MERGE_GATE_QUERY = `
query MergeGate($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      isDraft
      reviewDecision
      headRefOid
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
    }
  }
}`;

interface MergeGateResponse {
  data?: {
    repository?: {
      pullRequest?: {
        state?: string;
        isDraft?: boolean;
        reviewDecision?: string | null;
        headRefOid?: string;
        commits?: { nodes?: { commit?: { oid?: string; statusCheckRollup?: { state?: string } | null } }[] };
      } | null;
    } | null;
  };
  errors?: unknown[];
}

export type MergeObservation =
  | { kind: "unreadable"; reason: string }
  | {
    kind: "read";
    prState: string;
    isDraft: boolean;
    reviewDecision: string | null;
    headRefOid: string;
    rollupCommitOid: string;
    rollupState: string | null;
  };

// Reject partial GraphQL responses: their null rollup can otherwise appear to mean no CI.
export async function readMergeObservation(
  githubAuthManager: Pick<GitHubAuthManager, "graphqlQuery">,
  owner: string,
  repo: string,
  number: number,
): Promise<MergeObservation> {
  let body: MergeGateResponse | null;
  try {
    body = await githubAuthManager.graphqlQuery<MergeGateResponse>(MERGE_GATE_QUERY, {
      owner, repo, number,
    });
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!body) return { kind: "unreadable", reason: "GitHub did not answer the pull-request read" };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return { kind: "unreadable", reason: "GitHub answered the pull-request read with errors" };
  }

  const pr = body.data?.repository?.pullRequest;
  if (!pr) return { kind: "unreadable", reason: "GitHub returned no pull request for that number" };

  const headRefOid = pr.headRefOid;
  if (!headRefOid) return { kind: "unreadable", reason: "the pull request reported no head commit" };

  const lastCommit = pr.commits?.nodes?.[pr.commits.nodes.length - 1]?.commit;
  const rollupCommitOid = lastCommit?.oid;
  if (!rollupCommitOid) {
    return { kind: "unreadable", reason: "the pull request reported no commits" };
  }

  return {
    kind: "read",
    prState: pr.state ?? "",
    isDraft: pr.isDraft === true,
    reviewDecision: pr.reviewDecision ?? null,
    headRefOid,
    rollupCommitOid,
    rollupState: lastCommit?.statusCheckRollup?.state ?? null,
  };
}

export function mergeFlushRefusal(
  flush: { kind: "blocked-secret" | "blocked-unreadable" | "blocked-conflict" | "partial-unreadable" },
): string {
  switch (flush.kind) {
    case "blocked-secret":
      return "Not merged — a likely secret was found in this turn's changes, so they were not "
        + "committed and merging would ship the branch without them. Remove the secret (use an "
        + "env var or a ShipIt secret), then merge again.";
    case "blocked-unreadable":
      return "Not merged — ShipIt could not read part of the workspace, so `git add` staged nothing "
        + "and this turn's changes are not committed. Fix that path's permissions (or gitignore "
        + "it — a compose service running as its own `user:` is the usual cause), then merge again. "
        + "The chat transcript names the exact path.";
    case "blocked-conflict":
      return "Not merged — git reports unresolved conflicts or a rebase in progress, so this turn's "
        + "work could not be committed. Finish resolving, then merge again.";
    case "partial-unreadable":
      return "Not merged — part of the workspace could not be read, so the commit does not carry "
        + "everything in the tree and merging would ship an incomplete change. The chat transcript "
        + "names the path.";
  }
}

export type MergeRefusalReason =
  | "unreadable"
  | "already-merged"
  | "not-open"
  | "draft"
  | "head-moved-since-checks"
  | "local-head-differs"
  | "local-head-unreadable"
  | "checks-failing"
  | "checks-pending"
  | "awaiting-checks"
  | "review-required";

export type MergeDecision =
  | { action: "merge"; sha: string }
  | { action: "arm"; sha: string }
  | { action: "already-merged" }
  | { action: "refuse"; reason: MergeRefusalReason; message: string };

// Check SHAs before CI status so stale results are not reported as current failures.
export async function decideMerge(args: {
  observation: MergeObservation;
  prNumber: number;
  /** A failed HEAD read must not be treated as the sandbox exemption. */
  localHead:
    | { kind: "sandbox" }
    | { kind: "head"; sha: string }
    | { kind: "unreadable"; reason: string };
  graceSaysWait: () => Promise<boolean>;
  arming?: boolean;
}): Promise<MergeDecision> {
  const { observation, prNumber } = args;
  const proceed = (sha: string): MergeDecision =>
    args.arming ? { action: "arm", sha } : { action: "merge", sha };

  if (observation.kind === "unreadable") {
    return {
      action: "refuse",
      reason: "unreadable",
      message:
        `Not merged — ShipIt could not read PR #${prNumber} to check it is safe to merge: `
        + `${observation.reason}. Nothing was merged; try again.`,
    };
  }

  if (observation.prState === "MERGED") return { action: "already-merged" };

  // Arming binds to the new head and waits for its checks; immediate merging cannot.
  if (!args.arming && observation.rollupCommitOid !== observation.headRefOid) {
    return {
      action: "refuse",
      reason: "head-moved-since-checks",
      message:
        `Not merged — PR #${prNumber} has moved past the commit its checks ran on. `
        + "Wait for the checks on the new head to report, then merge again.",
    };
  }

  if (args.localHead.kind === "unreadable") {
    return {
      action: "refuse",
      reason: "local-head-unreadable",
      message:
        `Not merged — ShipIt could not read this workspace's current commit, so it cannot confirm `
        + `PR #${prNumber} would ship it: ${args.localHead.reason}`,
    };
  }
  if (args.localHead.kind === "head" && observation.headRefOid !== args.localHead.sha) {
    return {
      action: "refuse",
      reason: "local-head-differs",
      message:
        `Not merged — PR #${prNumber}'s head on GitHub is not this session's current commit, `
        + "so merging would ship a different state than the one in this workspace. "
        + "Push the branch and merge again once its checks report.",
    };
  }

  if (observation.prState !== "OPEN") {
    return {
      action: "refuse",
      reason: "not-open",
      message: `Not merged — PR #${prNumber} is ${observation.prState.toLowerCase()}.`,
    };
  }
  if (observation.isDraft) {
    return {
      action: "refuse",
      reason: "draft",
      message: `Not merged — PR #${prNumber} is a draft. Mark it ready first (gh pr ready ${prNumber}).`,
    };
  }

  // An older commit's rollup cannot approve or reject the new head.
  const rollup = args.arming && observation.rollupCommitOid !== observation.headRefOid
    ? "PENDING"
    : observation.rollupState;
  if (rollup === "FAILURE" || rollup === "ERROR") {
    return {
      action: "refuse",
      reason: "checks-failing",
      message:
        `Not merged — PR #${prNumber} has failing checks. Fix CI, push, and merge again once the `
        + "new checks report.",
    };
  }

  // Only approved or absent reviews permit merging; unknown states must stop it.
  if (observation.reviewDecision !== null && observation.reviewDecision !== "APPROVED") {
    const reason =
      observation.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
      : observation.reviewDecision === "REVIEW_REQUIRED" ? "a required review"
      : `a review state ShipIt does not recognise (${observation.reviewDecision})`;
    return {
      action: "refuse",
      reason: "review-required",
      message: `Not merged — PR #${prNumber} needs review: GitHub reports ${reason}.`,
    };
  }

  if (rollup === "PENDING" || rollup === "EXPECTED") {
    if (args.arming) return proceed(observation.headRefOid);
    return {
      action: "refuse",
      reason: "checks-pending",
      message:
        `Not merged — PR #${prNumber} still has checks running. Merge again once they report.`,
    };
  }

  if (rollup === null) {
    // No checks can mean no CI or workflows not yet registered; wait out the grace period.
    if (await args.graceSaysWait()) {
      if (args.arming) return proceed(observation.headRefOid);
      return {
        action: "refuse",
        reason: "awaiting-checks",
        message:
          `Not merged — PR #${prNumber} reports no checks yet. If this repository runs CI they `
          + "have not registered; merge again in a moment.",
      };
    }
    return proceed(observation.headRefOid);
  }

  if (rollup !== "SUCCESS") {
    return {
      action: "refuse",
      reason: "checks-failing",
      message: `Not merged — GitHub reports PR #${prNumber}'s checks as ${rollup}.`,
    };
  }

  return proceed(observation.headRefOid);
}
