import { getErrorMessage } from "../validation.js";

export interface CommitRef {
  sha: string;
  subject: string;
}

export interface PushDivergenceGit {
  currentBranchOrNull(): Promise<string | null>;
  fetchBranch(remote: string, branch: string): Promise<void>;
  aheadBehind(ref: string): Promise<{ ahead: number; behind: number } | null>;
  mergeBase(ref1: string, ref2: string): Promise<string | null>;
  commitSubjects(range: string, maxCount?: number): Promise<CommitRef[]>;
}

export interface UnmeasuredDivergence {
  measured: false;
  branch: string | null;
  remote: string;
  reason: string;
}

export interface MeasuredDivergence {
  measured: true;
  branch: string;
  remote: string;
  ahead: number;
  behind: number;
  sharedBase: boolean;
  remoteOnly: CommitRef[];
  remoteOnlyTruncated: boolean;
  refreshed: boolean;
}

export type PushDivergence = UnmeasuredDivergence | MeasuredDivergence;

export const MAX_NAMED_COMMITS = 5;

// Bounds the wait, not the git process; timeout leaves the measurement unrefreshed.
export const FETCH_TIMEOUT_MS = 20_000;

async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

  // Refresh before counting: a stale ref can hide commits a force-push would discard.
  let refreshed: boolean;
  try {
    refreshed = await withTimeout(git.fetchBranch(remote, branch), FETCH_TIMEOUT_MS);
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

export interface DivergedNoticeContext {
  forcePushBlocked?: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function join(...parts: string[]): string {
  return parts.join("");
}

function nameCommits(d: MeasuredDivergence): string {
  if (d.remoteOnly.length === 0) return "";
  const lines = d.remoteOnly.map((c) => `  ${c.sha} ${c.subject}`.trimEnd()).join("\n");
  const more = d.remoteOnlyTruncated
    ? `\n  …and ${d.behind - d.remoteOnly.length} more`
    : "";
  return `\nOnly on the remote:\n${lines}${more}\n`;
}

export function baseRebaseIsSafe(d: PushDivergence): boolean {
  if (!d.measured) return false;
  if (!d.sharedBase) return false;
  if (d.behind === 0) return true;
  return d.ahead > 0;
}

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
  const tail =
    `\n\nThe post-turn auto-push never forces a divergence open, so ${remoteRef} stays exactly `
    + "where it is and every later auto-push is rejected the same way until this is resolved.";

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

  const unpushedWarning = d.ahead > 0
    ? `\nThe branch on ${d.remote} does not contain ${plural(d.ahead, "commit")} from this `
      + "session, so anything merged from it there ships without them.\n"
    : "";

  const forcePush = `\`git push --force-with-lease ${pushTarget}\``;
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
