import type { SecretFinding } from "../../shared/secret-scan.js";

/**
 * planning#296 — why the disk ladder refused to reclaim a session, as far as the
 * user needs to care. Three of the four mirror the refusal branches of
 * `GitManager.autoCommit` (`shared/git.ts`), collapsing anything they can't
 * attribute into `"unknown"` so a future refusal path still produces a message
 * instead of a blank one; `no-repository` is the ladder's own refusal, for a
 * workspace that is no longer a git repository at all and so has no commit for
 * an auto-commit to refuse.
 */
export type EvictBlockReason =
  | { kind: "secret"; findings: SecretFinding[] }
  | { kind: "conflict"; conflictedFiles: string[]; rebaseInProgress: boolean }
  | { kind: "no-repository" }
  | { kind: "unknown" };

/**
 * planning#296 — build the persisted chat notice shown when the `light → evicted`
 * rung refuses to reclaim a session because its uncommitted work could not be
 * made durable (the auto-commit was refused by the secret scanner or by an
 * unresolved merge state).
 *
 * The user cannot otherwise tell this happened: the session is idle, nothing is
 * attached to it, and the only trace is an orchestrator log line. Since the
 * session is now pinned at `light` until a human acts, the notice has to say
 * what is wrong, that the work is safe, and what unblocks it.
 *
 * Secret matches arrive already redacted (a short public prefix + length, never
 * the token body — see `secret-scan.ts`), so this text is safe to persist into
 * chat history. Tone/shape mirrors `formatSecretScanNotice`.
 */
export function formatEvictBlockedNotice(reason: EvictBlockReason): string {
  const preserved =
    "Your uncommitted changes are still on disk and were not touched — ShipIt will keep this "
    + "session's checkout until the work can be committed and pushed. Cached dependencies are "
    + "not held back, so opening the session may reinstall them.";

  if (reason.kind === "secret") {
    const noun = reason.findings.length === 1
      ? "a likely secret"
      : `${reason.findings.length} likely secrets`;
    const lines = reason.findings.map((f) => {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      return `- \`${where}\` — ${f.description} (\`${f.redacted}\`)`;
    });
    return (
      `🔒 Disk cleanup paused for this session — the auto-commit that runs before idle `
      + `cleanup found ${noun} in your uncommitted changes:\n\n`
      + `${lines.join("\n")}\n\n`
      + `${preserved}\n\n`
      + `Remove the secret (use an environment variable or a ShipIt secret instead) — or add a `
      + `\`gitleaks:allow\` comment to the line if it's a false positive — and the next turn will `
      + `commit and push normally.`
    );
  }

  // Not an auto-commit refusal, so it does NOT use the shared `preserved`
  // paragraph: that one promises the work will be committed and pushed on the
  // next turn, and here nothing ever will be. The files are safe and they are
  // also permanently un-pushable, and the only way out is a person.
  if (reason.kind === "no-repository") {
    return (
      "⚠️ Disk cleanup paused for this session — its workspace is no longer a git repository "
      + "(the `.git` directory is missing), so ShipIt cannot commit, push, or restore it.\n\n"
      + "The files in the workspace are still on disk and were not touched. They exist only "
      + "here, though: with no repository there is no branch or commit to push them to, so "
      + "automatic cleanup will keep skipping this session and its checkout will keep using "
      + "disk. Cached dependencies are not held back, so opening the session may reinstall them."
      + "\n\nOpen the session to copy out anything you still need, then archive it to free the "
      + "space."
    );
  }

  if (reason.kind === "conflict") {
    const detail = [
      reason.rebaseInProgress ? "a rebase is in progress" : "",
      reason.conflictedFiles.length > 0
        ? `unmerged paths: ${reason.conflictedFiles.map((f) => `\`${f}\``).join(", ")}`
        : "",
    ].filter(Boolean).join("; ");
    return (
      `⚠️ Disk cleanup paused for this session — the auto-commit that runs before idle cleanup `
      + `was refused because the checkout is in an unresolved merge state`
      + `${detail ? ` (${detail})` : ""}.\n\n`
      + `${preserved}\n\n`
      + `Resolve the conflict (or abort the rebase) and the next turn will commit and push normally.`
    );
  }

  return (
    `⚠️ Disk cleanup paused for this session — the auto-commit that runs before idle cleanup `
    + `did not produce a commit, so the uncommitted changes could not be pushed anywhere safe.\n\n`
    + `${preserved}\n\n`
    + `Open the session and commit or discard the changes to let it be cleaned up.`
  );
}
