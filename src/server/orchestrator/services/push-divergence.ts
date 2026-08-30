/**
 * What SHAPE is the divergence that just got a push rejected — and which single
 * recovery fits it.
 *
 * ## Why this is measured rather than described
 *
 * `services/auto-push-scheduler.ts` has always emitted a transcript notice when
 * a post-turn push is rejected as non-fast-forward. Until this module, that
 * notice was a fixed three-case menu: the remote is ahead, OR this branch was
 * rewritten, OR the pull request already merged — pick the one that applies.
 * It described the space of divergences instead of the one in front of the user,
 * and its own emphasis fell on the merged case.
 *
 * The 2026-08-30 incident is what that costs. A session's pull request merged,
 * the docs/218 pre-turn auto-reset moved the branch to the fresh base and the
 * heal force-push re-created the remote — all correct. A later turn committed
 * and pushed one commit that belonged to no pull request. Then, inside the
 * container, the agent rebased (which ShipIt's own prompt told it to do) and the
 * branch LOST that already-published commit. Every later auto-push was rejected.
 *
 * So the true shape was: nothing unpushed here, one commit only on the REMOTE.
 * The notice told the user the opposite — that their commit was safe locally and
 * that further commits would stay local — and steered them at
 * `shipit branch reset-to-base --force`, which resets to the base and heals the
 * remote by force, i.e. deletes the one commit that existed anywhere. The notice
 * never mentioned it.
 *
 * At the moment of a rejection the answer is cheap, local, and exact:
 * `git rev-list --left-right --count HEAD...origin/<branch>` plus a `merge-base`.
 * Two counts and a shared-base bit distinguish every shape, and the count of
 * commits that exist ONLY on the remote is precisely the data-at-risk number
 * that decides whether `--force-with-lease` is safe advice or destructive
 * advice. That number is now measured, stated, and — when it is non-zero — the
 * commits behind it are named.
 *
 * ## Fetch first, and name no recovery when the fetch failed
 *
 * The counts are only as good as the remote-tracking ref. This clone's own
 * pushes keep it current, which covers the shape above; a push from anywhere
 * else does not, and reading a stale ref would report "nothing only on the
 * remote" for a remote that is in fact ahead — turning a warning about a
 * destructive command into a recommendation of one. So the measurement fetches
 * the single branch first and RECORDS whether that succeeded
 * ({@link MeasuredDivergence.refreshed}).
 *
 * A failed fetch does NOT merely add a caveat to shape-specific advice. Stale
 * counts understate `behind` in exactly the case where that number is the whole
 * decision, so an unrefreshed measurement reports its counts and then stops:
 * the notice states they are last-known and hands over the command that
 * re-reads them. A caveat the reader skims is not a substitute for not making
 * the recommendation.
 *
 * ## Absence is not a verdict
 *
 * Every read here is best-effort and every failure lands on
 * {@link UnmeasuredDivergence}, whose notice states plainly that ShipIt could
 * not tell and hands over the command that answers it. The one thing this
 * module must never do is guess a shape, because each recovery destroys the
 * side the other one keeps. `services/branch-sync.ts` reaches the same
 * conclusion from the merge side and refuses to repair a divergence at all.
 */

import { getErrorMessage } from "../validation.js";

/** One commit, as the notice names it. */
export interface CommitRef {
  sha: string;
  subject: string;
}

/** The git reads this module needs. Structural so tests need no repository. */
export interface PushDivergenceGit {
  currentBranchOrNull(): Promise<string | null>;
  fetchBranch(remote: string, branch: string): Promise<void>;
  aheadBehind(ref: string): Promise<{ ahead: number; behind: number } | null>;
  mergeBase(ref1: string, ref2: string): Promise<string | null>;
  commitSubjects(range: string, maxCount?: number): Promise<CommitRef[]>;
}

/** ShipIt could not work out the shape. The notice says so and asks for nothing. */
export interface UnmeasuredDivergence {
  measured: false;
  /** Named when it is known — the notice degrades to `<branch>` when it is not. */
  branch: string | null;
  remote: string;
  /** Why the measurement failed, in one clause, for the notice to quote. */
  reason: string;
}

/** The shape, measured. `ahead`/`behind` are commit counts, never bytes or files. */
export interface MeasuredDivergence {
  measured: true;
  branch: string;
  remote: string;
  /** Commits only in this session's history. */
  ahead: number;
  /** Commits only on the remote branch — the data a force-push would destroy. */
  behind: number;
  /** Do the two histories share any commit at all? */
  sharedBase: boolean;
  /** The remote-only commits, newest first, capped at {@link MAX_NAMED_COMMITS}. */
  remoteOnly: CommitRef[];
  /** True when `behind` exceeds what {@link MeasuredDivergence.remoteOnly} names. */
  remoteOnlyTruncated: boolean;
  /** Did the pre-measurement fetch land? False ⇒ the counts are last-known. */
  refreshed: boolean;
}

export type PushDivergence = UnmeasuredDivergence | MeasuredDivergence;

/**
 * How many remote-only commits the notice names. Enough to recognise the work
 * ("that's my commit") without turning a warning into a log dump; past it the
 * notice says how many more there are.
 */
export const MAX_NAMED_COMMITS = 5;

/**
 * How long the pre-measurement fetch may take before it is abandoned.
 *
 * It is the only network call on this path, and the caller has already marked
 * the divergence episode as notified — so a fetch that never returns would take
 * the persisted notice with it AND suppress every later attempt for the life of
 * the episode. `simple-git` has no timeout of its own, so this is the one that
 * exists. Generous relative to a single-branch fetch, small relative to the
 * post-turn hold's own deadline, so the notice always lands inside it.
 *
 * Abandoning the wait does not kill the underlying git process; it just stops
 * this path waiting on it. The measurement then reports `refreshed: false`,
 * which names no recovery.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Await `work`, but give up after `ms`. Resolves true when the work finished,
 * false when the wait was abandoned — never rejects, because the caller reads
 * the answer as "is this measurement current?" and a thrown timeout would be a
 * second failure mode for the same question.
 */
async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejection maps to false rather than propagating, and the handler is
  // attached HERE rather than after the race — which is also what keeps a
  // failure arriving after the timeout from becoming an unhandled rejection.
  const settled = (async () => {
    try {
      await work;
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([
      settled,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Measure the divergence behind a just-rejected push.
 *
 * Never throws and never rejects: it runs on a failure path whose whole purpose
 * is to explain itself, so a second failure must degrade the explanation rather
 * than replace it with silence.
 */
export async function measurePushDivergence(
  git: PushDivergenceGit,
  remote = "origin",
): Promise<PushDivergence> {
  let branch: string | null;
  try {
    branch = await git.currentBranchOrNull();
  } catch (err) {
    return { measured: false, branch: null, remote, reason: `the current branch could not be read (${getErrorMessage(err)})` };
  }
  if (!branch) {
    return { measured: false, branch: null, remote, reason: "the workspace has no current branch (detached HEAD)" };
  }

  // Fetch before counting. A tracking ref this clone last wrote itself is right
  // for the shape this module was written for and wrong for a remote that moved
  // elsewhere — and being wrong in that direction is what would recommend a
  // destructive force-push. Best-effort AND bounded: a failure (or a fetch that
  // never returns) is reported as `refreshed: false`, which makes the notice
  // name no recovery at all.
  let refreshed: boolean;
  try {
    refreshed = await withTimeout(git.fetchBranch(remote, branch), FETCH_TIMEOUT_MS);
  } catch {
    // `withTimeout` swallows the promise's rejection; this catches a
    // `fetchBranch` that throws SYNCHRONOUSLY before returning one.
    refreshed = false;
  }

  const ref = `refs/remotes/${remote}/${branch}`;
  let counts: { ahead: number; behind: number } | null;
  try {
    counts = await git.aheadBehind(ref);
  } catch (err) {
    return { measured: false, branch, remote, reason: `the two histories could not be compared (${getErrorMessage(err)})` };
  }
  if (!counts) {
    return {
      measured: false,
      branch,
      remote,
      reason: `this clone has no ${remote}/${branch} to compare against`,
    };
  }

  // Treated as "they do share one" when the read fails — the shared-base bit
  // only ever ADDS a warning, so failing this way cannot invent an
  // unrelated-histories claim.
  let sharedBase: boolean;
  try {
    sharedBase = (await git.mergeBase(ref, "HEAD")) !== null;
  } catch {
    sharedBase = true;
  }

  let remoteOnly: CommitRef[] = [];
  if (counts.behind > 0) {
    try {
      remoteOnly = await git.commitSubjects(`HEAD..${ref}`, MAX_NAMED_COMMITS);
    } catch {
      remoteOnly = [];
    }
  }

  return {
    measured: true,
    branch,
    remote,
    ahead: counts.ahead,
    behind: counts.behind,
    sharedBase,
    remoteOnly,
    remoteOnlyTruncated: counts.behind > remoteOnly.length,
    refreshed,
  };
}

/** Options the notice cannot measure from git alone. */
export interface DivergedNoticeContext {
  /**
   * Is a hand-rolled force-push blocked for this session right now?
   * `docker/agent-hooks/block-branch-ops.mjs` blocks one while
   * `SHIPIT_GUARD_DESTRUCTIVE_GIT=1`, which the orchestrator sets from
   * `Boolean(session.mergedHeadSha)`. Naming a command the agent is refused
   * when it runs it is the same dead end in a friendlier voice, so where the
   * fitting recovery IS a force-push, the notice says who can still run it and
   * what the brokered alternative actually does.
   */
  forcePushBlocked?: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Assemble the notice from its parts. A plain `.join("")` rather than `+`
 * because several parts are computed (the measurement block, the shape-specific
 * paragraph, the shared tail) and concatenating variables trips `prefer-template`.
 */
function join(...parts: string[]): string {
  return parts.join("");
}

/** `abc1234 subject` lines, one per commit, plus a count of what was elided. */
function nameCommits(d: MeasuredDivergence): string {
  if (d.remoteOnly.length === 0) return "";
  const lines = d.remoteOnly.map((c) => `  ${c.sha} ${c.subject}`.trimEnd()).join("\n");
  const more = d.remoteOnlyTruncated
    ? `\n  …and ${d.behind - d.remoteOnly.length} more`
    : "";
  return `\nOnly on the remote:\n${lines}${more}\n`;
}

/**
 * Is "rebase onto the base branch, then force-push" — what the client's rebase
 * banner does when its `git_push_rejected` arrives — safe against THIS
 * divergence?
 *
 * The banner's action publishes the session branch over its remote, so it is
 * the right remedy for a branch whose history was rewritten and never
 * republished (the 2026-08-14/15 incident), and it is DESTRUCTION when the
 * remote carries commits this branch does not and this branch has nothing to
 * republish — the 2026-08-30 shape, where the one at-risk commit exists nowhere
 * else. One click is a very short distance to that, so the banner is withheld
 * unless the measurement rules it out.
 *
 * Fails CLOSED: an unmeasured shape returns false. The persisted notice still
 * carries the recovery, so withholding a button costs a click, while arming it
 * on a shape nobody measured costs the commit.
 */
export function baseRebaseIsSafe(d: PushDivergence): boolean {
  if (!d.measured) return false;
  // Unrelated histories: a force-push replaces the remote wholesale.
  if (!d.sharedBase) return false;
  // Nothing exists only on the remote ⇒ a force-push can discard nothing.
  if (d.behind === 0) return true;
  // The remote has commits this branch lacks. Safe only if this branch has its
  // own work to republish over them — the rewritten-branch case — and even then
  // the notice states what is discarded.
  return d.ahead > 0;
}

/**
 * The persisted transcript notice for a push rejected as non-fast-forward.
 *
 * Plain prose, no markdown emphasis — `MessageList` renders a `notice` as
 * pre-wrapped text (`useMarkdown` is false for notices), so `**bold**` would
 * show up literally. Backticks match the neighbouring merged-push / conflict
 * notices.
 *
 * ## One recovery, chosen from the measurement
 *
 * The shapes are told apart by the two counts plus the shared-base bit, and
 * `behind` — commits reachable only from the remote — is the number that
 * decides everything, because it is what a force-push destroys:
 *
 *  - **Only the remote is ahead** (`ahead === 0`, `behind > 0`) — the shape of
 *    the 2026-08-30 incident: an already-published commit was dropped locally by
 *    a rebase or a reset. The fix is `git pull --rebase`, and a force-push is the
 *    one command that would make the loss permanent, so it is named as a warning
 *    rather than a remedy.
 *  - **Both** — the branch's history was rewritten after publishing. The two
 *    remedies keep opposite sides, so the non-destructive one leads and the
 *    destructive one carries its condition and the commits it discards.
 *  - **Unrelated histories** — no default is safe; the notice says to look
 *    before moving either side.
 *  - **`behind === 0`** — deliberately NOT treated as "the branch was rewritten,
 *    force-push it". `aheadBehind` counts the symmetric difference, so
 *    `behind === 0` means every commit on the remote ref is reachable from HEAD,
 *    i.e. the remote IS an ancestor and a PLAIN push fast-forwards. Those counts
 *    therefore cannot explain the rejection that got us here — the ref moved, or
 *    the fetch that should have refreshed it failed — and prescribing a
 *    force-push on them is how a stale tracking ref would talk someone into
 *    overwriting a remote that is actually ahead.
 *  - **Counts that could not be refreshed, or could not be taken at all** — no
 *    recovery is named. The notice hands over the command that answers the
 *    question instead.
 */
export function formatDivergedPushNotice(
  d: PushDivergence,
  ctx: DivergedNoticeContext = {},
): string {
  const branch = d.branch;
  const named = branch ? ` ${branch}` : "";
  const remoteRef = branch ? `${d.remote}/${branch}` : `${d.remote}/<branch>`;
  const pushTarget = branch ? `${d.remote} ${branch}` : `${d.remote} <branch>`;
  const head =
    `Not pushed — this session's branch${named} and its remote have diverged: `
    + `${d.remote} rejected the push as non-fast-forward.\n\n`;
  // True in every shape. Scoped to the AUTO-push on purpose: ShipIt does force
  // the remote elsewhere — the docs/218 pre-turn reset heals the branch that
  // way, and `gh pr create` force-pushes when it re-arms past a merged pull
  // request — so the flat claim "ShipIt never force-pushes" would be false.
  const tail =
    `\n\nThe post-turn auto-push never forces a divergence open, so ${remoteRef} stays exactly `
    + "where it is and every later auto-push is rejected the same way until this is resolved.";

  // The command that answers the question, for every shape where naming a
  // recovery would be a guess.
  const measureItYourself =
    "No recovery is named, because the two that exist destroy opposite sides when chosen "
    + "wrongly. Measure it first:\n\n"
    + `  git fetch ${pushTarget} && git rev-list --left-right --count HEAD...${remoteRef}\n\n`
    + "The left number is commits only in this session, the right number is commits only on the "
    + "remote. Anything above zero on the right is work a force-push would destroy.";

  if (!d.measured) {
    return join(
      head,
      `ShipIt could not measure how the two histories differ: ${d.reason}.\n\n`,
      measureItYourself,
      tail,
    );
  }

  const measurement = join(
    `Measured against ${remoteRef} at the moment of the rejection: `
    + `${plural(d.ahead, "commit")} only in this session, `
    + `${plural(d.behind, "commit")} only on the remote.\n`,
    nameCommits(d),
  );

  // A fetch that failed means the counts describe this clone's LAST-KNOWN view
  // of the remote, and the direction that matters is that `behind` can be
  // understated — which is exactly the reading that would recommend a
  // force-push over commits the remote actually has. So a stale measurement is
  // reported and then stops: the counts are shown, no recovery is chosen.
  if (!d.refreshed) {
    return join(
      head, measurement,
      `\nShipIt could not refresh its view of ${remoteRef} before measuring, so those counts are `
      + "this clone's last-known remote state rather than the remote's. The remote may carry "
      + "commits they do not show, and that is precisely the case in which a force-push destroys "
      + `work — so re-read it first with \`git fetch ${pushTarget}\`.\n\n`,
      measureItYourself,
      tail,
    );
  }

  // The branch on GitHub is what a merge ships. Stated as a fact about the
  // remote rather than as a prediction about a pull request: `gh pr create`
  // pushes before it opens or reprints one, and ShipIt's own merge button holds
  // on a diverged branch (`services/branch-sync.ts`), so "the PR would merge
  // without them" over-claims. A merge performed on GitHub still would.
  const unpushedWarning = d.ahead > 0
    ? `\nThe branch on ${d.remote} does not contain ${plural(d.ahead, "commit")} from this `
      + "session, so anything merged from it there ships without them.\n"
    : "";

  const forcePush = `\`git push --force-with-lease ${pushTarget}\``;
  // Appended to the shape whose recovery IS a force-push, when the
  // merged-branch hook would refuse one from the agent. Deliberately a note
  // beside the command rather than a substitution: `shipit branch reset-to-base`
  // moves the branch to the BASE and discards this history, so naming it as
  // "the way to publish this history" would be false. The user's own terminal
  // is not hooked, so the force-push stays available to them.
  const blockedNote = ctx.forcePushBlocked
    ? "\n\nShipIt blocks a hand-rolled force-push while this session sits on a merged branch, so "
      + "the agent cannot run that command — the user can run it from the terminal. If this "
      + "branch's own history should be abandoned in favour of the fresh base instead, "
      + `\`shipit branch reset-to-base --force --reason "<why>"\` does that in one brokered step `
      + "(it discards this branch's commits rather than publishing them)."
    : "";

  if (!d.sharedBase) {
    return join(
      head, measurement, unpushedWarning,
      "\nShipIt found no commit common to the two histories — they are unrelated, or the "
      + "comparison itself failed. Either way no remedy is safe by default: `git pull --rebase` "
      + "has nothing to replay onto, and a force-push would replace the remote's "
      + `${plural(d.behind, "commit")} with unrelated history. Read both sides — `
      + `\`git log --oneline HEAD\` and \`git log --oneline ${remoteRef}\` — and decide with the `
      + "user before moving either.",
      tail,
    );
  }

  if (d.behind === 0) {
    // NOT the "rewritten branch, force-push it" case, however much it looks like
    // one. See the docstring: `behind === 0` means the remote is an ancestor of
    // HEAD, so a plain push fast-forwards and these counts contradict the
    // rejection that produced them.
    return join(
      head, measurement, unpushedWarning,
      `\nNothing exists only on ${remoteRef} — every commit it has is already in this branch — so `
      + "a plain push should have fast-forwarded. These counts therefore do not explain the "
      + "rejection: the remote ref most likely moved between the push and this measurement, or "
      + "something on the remote (a branch protection rule, a pre-receive hook) refused the push "
      + "for a reason of its own. Read the push failure in this session's Logs panel before "
      + "changing either history.\n\n"
      + `Do not force-push on the strength of these counts. If ${remoteRef} moved after they were `
      + "taken, a force-push discards whatever moved it.",
      tail,
    );
  }

  if (d.ahead === 0) {
    // The 2026-08-30 shape. Nothing is unpushed; the remote is strictly ahead,
    // which is what a rebase or reset run AFTER a commit was published leaves
    // behind. The push was rejected for moving the branch backwards.
    return join(
      head, measurement,
      "\nNothing in this session is unpushed. The remote is strictly ahead, so the push was "
      + "rejected for moving the branch BACKWARDS — the shape a rebase or a reset leaves behind "
      + "when it runs after a commit has already been pushed.\n\n"
      + `Recovery: \`git pull --rebase ${pushTarget}\` brings ${d.behind === 1 ? "that commit" : "those commits"} `
      + "back into this session, and the next push lands.\n\n"
      + `Do NOT force-push here. A force-push would delete ${plural(d.behind, "commit")} from the `
      + "remote, and this session's history no longer has "
      + `${d.behind === 1 ? "it" : "them"} to put back.`,
      tail,
    );
  }

  // Both sides carry work the other does not — the rewritten-and-not-yet-
  // republished branch. The two remedies keep opposite sides, so the
  // non-destructive one leads and the other states its cost.
  return join(
    head, measurement, unpushedWarning,
    "\nBoth sides carry work the other does not, so this needs a decision rather than a "
    + "command.\n\n"
    + `Recovery: \`git pull --rebase ${pushTarget}\` replays this session's `
    + `${plural(d.ahead, "commit")} on top of the remote's ${plural(d.behind, "commit")}, keeping `
    + "both.\n\n"
    + `Only if the remote's ${plural(d.behind, "commit")} ${d.behind === 1 ? "is a superseded copy" : "are superseded copies"} `
    + `of work this branch already carries, publish over ${d.behind === 1 ? "it" : "them"} with `
    + `${forcePush} — which discards ${d.behind === 1 ? "it" : "them"} permanently.`,
    blockedNote,
    tail,
  );
}
