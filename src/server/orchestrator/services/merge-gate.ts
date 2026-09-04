/**
 * docs/287-agent-merge-per-repo §3 — the one live read an agent merge is decided
 * from, and the table that decides it.
 *
 * ## Why this does not reuse anything
 *
 * **Not the poller's summary.** `forceRefreshSession()` returns `void` and
 * returns silently for an untracked session, and `pollRepo()` preserves the
 * previous state when it is unauthenticated, rate-limited, or handed no
 * repository data — so a "forced" refresh that failed leaves `getStatus()`
 * answering a stale green summary. The poll also indexes open pull requests by
 * `headRefName`, so two pull requests from one branch overwrite each other, and
 * the summary carries no head SHA at all.
 *
 * **Not the poller's query.** `buildPrStatusQuery()` emits the bulk
 * `pullRequests` connection with the number only as an alias, `PR_LIGHT_FIELDS`
 * has no `isDraft`, and `parsePrNode()` fixes `prState` to `"open"`.
 *
 * **Not `getCheckStatus()`.** It maps "no checks configured" AND a swallowed API
 * failure to the same `"none"`, and the merge path treats `"none"` as permission
 * to merge. That is a live fail-open defect on the sandbox path today, which is
 * why this read replaces it for BOTH session kinds rather than only the new one.
 *
 * ## One round trip, both SHAs
 *
 * `headRefOid` is the branch tip; the rollup's `commit.oid` is the commit the
 * checks actually describe. They differ exactly when something advanced the
 * branch after CI started, which is the case a check gate must refuse rather
 * than merge. The selection is deliberately minimal: `mergeable` is never
 * consulted, and the rollup's `contexts` list is not enumerated — counting a
 * bounded list is how a fail-open gate gets built.
 */

import type { GitHubAuthManager } from "../github-auth.js";

/** The merge decision's query. Written for this decision and used nowhere else. */
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

/**
 * What the read saw. A structured observation rather than a boolean, so each
 * refusal can say the right thing — and so `docs/288-agent-merge-arming` can
 * attach a second behaviour to the same facts without a second read.
 */
export type MergeObservation =
  | { kind: "unreadable"; reason: string }
  | {
    kind: "read";
    /** `OPEN` | `CLOSED` | `MERGED`, as GitHub spells it. */
    prState: string;
    isDraft: boolean;
    /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`, or null when no review is configured. */
    reviewDecision: string | null;
    /** The branch tip right now. */
    headRefOid: string;
    /** The commit the rollup describes — not necessarily `headRefOid`. */
    rollupCommitOid: string;
    /** `SUCCESS` | `PENDING` | `EXPECTED` | `FAILURE` | `ERROR`, or null for zero checks. */
    rollupState: string | null;
  };

/**
 * Read the pull request for a merge decision.
 *
 * **Any GraphQL `errors` makes this unreadable, before anything else is
 * examined.** `graphqlQuery()` logs non-rate-limit errors and still returns the
 * body, so a partial response can carry `errors` AND a null rollup — which would
 * otherwise read as "this repository has no CI" and merge.
 */
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
  // `null` is what `graphqlQuery` returns for unauthenticated, non-2xx, rate
  // limited, and unparseable-body. All of them mean the same thing here.
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
    // Absent and explicitly null mean the same thing: GitHub is reporting no
    // checks for this commit.
    rollupState: lastCommit?.statusCheckRollup?.state ?? null,
  };
}

/**
 * docs/287 req 15 — why a merge stopped at the flush, in the agent's words.
 *
 * Each of these means "this turn's work is not on the branch", and each has a
 * different remedy, so they are not collapsed into one message. `committed` and
 * `nothing-to-commit` never reach here — they are the two outcomes that proceed.
 */
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

/** Why a merge was refused. The caller branches on it only for `checks-pending`,
 * which is the one state a sandbox `--auto` turns into an arming. */
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
  | { action: "already-merged" }
  | { action: "refuse"; reason: MergeRefusalReason; message: string };

/**
 * The observation table (docs/287 plan §3), in order. The order is the design:
 * an unreadable answer refuses before any field is examined, and the two SHA
 * comparisons come before the state checks because a stale answer about the
 * wrong commit should not be reported as a CI failure.
 *
 * `graceSaysWait` is called ONLY for the zero-check case, so a merge with green
 * checks never starts a grace timer as a side effect.
 */
export async function decideMerge(args: {
  observation: MergeObservation;
  prNumber: number;
  /**
   * What this workspace's current commit is — as one of three DISTINCT answers,
   * because two of them used to share `null`.
   *
   * A sandbox owns its own git and has no ShipIt-managed branch to compare, so
   * it genuinely skips req 14's check. A repo-bound workspace whose HEAD could
   * not be read has NOT passed that check — and collapsing the two meant a
   * broken or evicted workspace merged with no local comparison at all
   * (cross-agent review finding). They are separate cases now so that a caller
   * cannot express the failure as the exemption.
   */
  localHead:
    | { kind: "sandbox" }
    | { kind: "head"; sha: string }
    | { kind: "unreadable"; reason: string };
  graceSaysWait: () => Promise<boolean>;
}): Promise<MergeDecision> {
  const { observation, prNumber } = args;

  if (observation.kind === "unreadable") {
    return {
      action: "refuse",
      reason: "unreadable",
      message:
        `Not merged — ShipIt could not read PR #${prNumber} to check it is safe to merge: `
        + `${observation.reason}. Nothing was merged; try again.`,
    };
  }

  // Terminal, and terminal beats everything below: no comparison of SHAs or
  // checks can change the answer for a pull request that has already merged,
  // and running them first would report a moved head to somebody whose merge
  // has already happened. Nothing is merged on this path.
  if (observation.prState === "MERGED") return { action: "already-merged" };

  // req 16 — the checks describe a commit that is no longer the head. Merging on
  // the strength of them would merge code CI never saw.
  if (observation.rollupCommitOid !== observation.headRefOid) {
    return {
      action: "refuse",
      reason: "head-moved-since-checks",
      message:
        `Not merged — PR #${prNumber} has moved past the commit its checks ran on. `
        + "Wait for the checks on the new head to report, then merge again.",
    };
  }

  // req 14 — the pull request's head must be what this session just committed
  // and pushed. `guardMergeSync` cannot cover this: it compares against the
  // remote-TRACKING ref and proceeds whenever it cannot tell, while this
  // compares the live head and fails closed.
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

  const rollup = observation.rollupState;
  // req 7 — EVERY check GitHub reports for the commit must pass, required or
  // not. The rollup aggregates all of them, which is why this reads the rollup
  // state rather than enumerating and filtering contexts.
  if (rollup === "FAILURE" || rollup === "ERROR") {
    return {
      action: "refuse",
      reason: "checks-failing",
      message:
        `Not merged — PR #${prNumber} has failing checks. Fix CI, push, and merge again once the `
        + "new checks report.",
    };
  }

  // req 8 — a review gate GitHub is enforcing. Checked after CI so the more
  // actionable message wins when both apply.
  //
  // A WHITELIST, not a list of the two refusals GitHub documents today. Naming
  // the refusals means a value GitHub adds later falls through to the merge —
  // the one direction this gate must never fail in — while naming the two that
  // permit a merge makes an unrecognised value refuse on its own (cross-agent
  // review finding). `null` is "no review is configured for this repository".
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
    // req 17 — the command never waits by itself.
    return {
      action: "refuse",
      reason: "checks-pending",
      message:
        `Not merged — PR #${prNumber} still has checks running. Merge again once they report.`,
    };
  }

  if (rollup === null) {
    // Zero checks. That is either a repository with no CI, or a push whose
    // workflows GitHub has not registered yet — and those are indistinguishable
    // in this instant, which is what the grace window exists for.
    if (await args.graceSaysWait()) {
      return {
        action: "refuse",
        reason: "awaiting-checks",
        message:
          `Not merged — PR #${prNumber} reports no checks yet. If this repository runs CI they `
          + "have not registered; merge again in a moment.",
      };
    }
    return { action: "merge", sha: observation.headRefOid };
  }

  if (rollup !== "SUCCESS") {
    // An unrecognised rollup state is not permission to merge.
    return {
      action: "refuse",
      reason: "checks-failing",
      message: `Not merged — GitHub reports PR #${prNumber}'s checks as ${rollup}.`,
    };
  }

  return { action: "merge", sha: observation.headRefOid };
}
