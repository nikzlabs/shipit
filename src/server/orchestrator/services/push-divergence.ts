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
 * ## Fetch first, and say so when the fetch failed
 *
 * The counts are only as good as the remote-tracking ref. This clone's own
 * pushes keep it current, which covers the shape above; a push from anywhere
 * else does not, and reading a stale ref would report "nothing only on the
 * remote" for a remote that is in fact ahead — turning a warning about a
 * destructive command into a recommendation of one. So the measurement fetches
 * the single branch first and RECORDS whether that succeeded
 * ({@link MeasuredDivergence.refreshed}). A failed fetch degrades the notice —
 * the counts are labelled as last-known and the reader is told to re-check —
 * rather than suppressing it.
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
  // destructive force-push. Best-effort: a failure is reported, not fatal.
  let refreshed = true;
  try {
    await git.fetchBranch(remote, branch);
  } catch {
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
 * The persisted transcript notice for a push rejected as non-fast-forward.
 *
 * Plain prose, no markdown emphasis — `MessageList` renders a `notice` as
 * pre-wrapped text (`useMarkdown` is false for notices), so `**bold**` would
 * show up literally. Backticks match the neighbouring merged-push / conflict
 * notices.
 *
 * ## One recovery, chosen from the measurement
 *
 * Each shape gets the single command that fits it, and the shapes are told
 * apart by the two counts plus the shared-base bit:
 *
 *  - **Only the remote is ahead** — the shape of the 2026-08-30 incident: an
 *    already-published commit was dropped locally by a rebase or a reset. The
 *    fix is `git pull --rebase`, and a force-push is the one command that would
 *    make the loss permanent, so it is named as a warning rather than a remedy.
 *  - **Only this branch is ahead** — its history was rewritten after publishing.
 *    Nothing exists solely on the remote, so `--force-with-lease` is safe here
 *    and is the whole remedy (or its brokered equivalent, when the merged-branch
 *    hook would block it).
 *  - **Both** — the two remedies keep opposite sides, so the non-destructive one
 *    leads and the destructive one carries its condition and its cost.
 *  - **Unrelated histories** — no default is safe; the notice says to look
 *    before moving either side.
 *  - **Neither side ahead, or unmeasurable** — no shape is claimed at all. The
 *    notice hands over the command that answers the question.
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
  // True in every shape, and the only two facts the old notice got right: ShipIt
  // will not force a divergence open, so nothing changes on GitHub until someone
  // resolves this, and every later auto-push fails the same way.
  const tail =
    `\n\nShipIt never force-pushes on its own, so ${remoteRef} stays exactly where it is `
    + "and every later auto-push is rejected the same way until this is resolved.";

  if (!d.measured) {
    return join(
      head,
      `ShipIt could not measure how the two histories differ: ${d.reason}.\n\n`
      + "No recovery is named, because the two that exist destroy opposite sides when "
      + "chosen wrongly. Measure it first:\n\n"
      + `  git fetch ${pushTarget} && git rev-list --left-right --count HEAD...${remoteRef}\n\n`
      + "The left number is commits only in this session, the right number is commits only "
      + "on the remote. Anything above zero on the right is work a force-push would destroy.",
      tail,
    );
  }

  const stale = d.refreshed
    ? ""
    : `\nShipIt could not refresh its view of ${remoteRef} first, so these counts are against `
      + `this clone's last-known remote state. Re-check with \`git fetch ${pushTarget}\` before `
      + "acting on them.\n";

  const measurement = join(
    `Measured against ${remoteRef} at the moment of the rejection: `
    + `${plural(d.ahead, "commit")} only in this session, `
    + `${plural(d.behind, "commit")} only on the remote.\n`,
    stale,
    nameCommits(d),
  );

  const unpushedWarning = d.ahead > 0
    ? `\nA pull request on this branch would merge WITHOUT the ${plural(d.ahead, "commit")} `
      + "that never reached the remote.\n"
    : "";

  const forcePush = `\`git push --force-with-lease ${pushTarget}\``;
  // Appended to the shapes whose recovery IS a force-push, when the
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
      `\nThe two histories share no commit at all, so neither remedy is safe by default: `
      + `\`git pull --rebase\` has nothing to replay onto, and a force-push would replace the `
      + `remote's ${plural(d.behind, "commit")} with unrelated history. Read both sides — `
      + `\`git log --oneline HEAD\` and \`git log --oneline ${remoteRef}\` — and decide with the `
      + "user before moving either.",
      tail,
    );
  }

  if (d.ahead === 0 && d.behind === 0) {
    return join(
      head, measurement,
      "\nThe two histories agree on every commit, so the counts do not explain the rejection — "
      + "a branch protection rule, a hook on the remote, or a ref that moved between the push and "
      + "this measurement. Check the push failure logged for this session in the Logs panel before "
      + "changing either history; nothing here needs a rebase or a force-push.",
      tail,
    );
  }

  if (d.ahead === 0) {
    // The incident's shape. Nothing is unpushed; the remote is strictly ahead,
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

  if (d.behind === 0) {
    // Rewritten-and-republished: nothing exists only on the remote, so the
    // force-push destroys nothing and is the entire remedy.
    return join(
      head, measurement, unpushedWarning,
      `\nThe remote holds no commit this branch lacks, so nothing on GitHub is at risk. `
      + `${remoteRef} is simply not an ancestor of this branch any more — its history was `
      + "rewritten (a rebase, or a reset onto a fresh base) after those commits were published.\n\n"
      + `Recovery: publish the rewritten history with ${forcePush}.`,
      blockedNote,
      tail,
    );
  }

  // Both sides carry work the other does not. The two remedies keep opposite
  // sides, so the non-destructive one leads and the other states its cost.
  return join(
    head, measurement, unpushedWarning,
    `\nBoth sides carry work the other does not, so this needs a decision rather than a `
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
