#!/usr/bin/env node
/** Blocks branch changes and destructive git during merged-branch recovery. */

import { readFileSync } from "node:fs";

// Sandbox sessions own their branches.
if (process.env.SHIPIT_SANDBOX === "1") process.exit(0);

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // can't parse stdin — fail open
}

if (payload?.tool_name !== "Bash") process.exit(0);
const command = payload?.tool_input?.command;
if (typeof command !== "string" || !command.trim()) process.exit(0);

/** Split a shell line into candidate commands. */
function segments(line) {
  return line.split(/\|\||&&|[;\n|]/);
}

/** Parse a direct git invocation, or return null. */
function parseGit(seg) {
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  // Step past leading `VAR=value` env assignments.
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] !== "git") return null;
  i++;
  // Step past git's own global options to reach the subcommand.
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (tokens[i] === "-C" || tokens[i] === "-c") i++; // these take a value
    i++;
  }
  const rest = tokens.slice(i + 1);
  return {
    sub: tokens[i],
    rest,
    positionals: rest.filter((t) => !t.startsWith("-")),
  };
}

function offends(seg) {
  const parsed = parseGit(seg);
  if (!parsed) return null;
  const { sub, rest, positionals } = parsed;

  if (sub === "checkout") {
    if (rest.includes("-b") || rest.includes("-B")) {
      return "`git checkout -b` creates a new branch";
    }
    return null;
  }
  if (sub === "switch") {
    if (rest.some((t) => ["-c", "-C", "--create", "--orphan"].includes(t))) {
      return "`git switch -c` creates a new branch";
    }
    if (positionals.length > 0) {
      return "`git switch` moves off the session branch";
    }
    return null;
  }
  if (sub === "branch") {
    // A positional outside list/delete forms creates or moves a branch.
    const isDelete = rest.some((t) => ["-d", "-D", "--delete"].includes(t));
    const isList = rest.some((t) =>
      [
        "-l",
        "--list",
        "-a",
        "--all",
        "-r",
        "--remotes",
        "--merged",
        "--no-merged",
        "--contains",
        "--no-contains",
        "--points-at",
      ].includes(t),
    );
    if (positionals.length > 0 && !isDelete && !isList) {
      return "`git branch` here would create or move a branch";
    }
    return null;
  }
  if (sub === "worktree" && rest[0] === "add") {
    return "`git worktree add` creates a separate branch/worktree";
  }
  return null;
}

/** Find destructive git forms blocked during merged-branch recovery. */
function offendsDestructive(seg) {
  const parsed = parseGit(seg);
  if (!parsed) return null;
  const { sub, rest } = parsed;

  if (sub === "reset" && rest.includes("--hard")) {
    return "`git reset --hard` discards this branch's state";
  }
  // Allow commands that control an existing rebase, especially abort.
  if (sub === "rebase") {
    const notAStart = rest.some((t) =>
      [
        "--continue",
        "--abort",
        "--skip",
        "--quit",
        "--edit-todo",
        "--show-current-patch",
        "--help",
        "-h",
      ].includes(t),
    );
    if (!notAStart) {
      return "`git rebase` rewrites this branch's history";
    }
  }
  // A plain pull merges and remains allowed.
  if (sub === "pull" && rest.some((t) => t === "--rebase" || t === "-r" || t.startsWith("--rebase="))) {
    return "`git pull --rebase` rewrites this branch's history";
  }
  if (sub === "checkout" && rest.some((t) => t === "-f" || t === "--force")) {
    return "`git checkout -f` overwrites the working tree";
  }
  if (
    sub === "push" &&
    rest.some(
      (t) =>
        t === "-f" ||
        t === "--force" ||
        // `--force-with-lease` / `--force-if-includes` also take an `=<ref>` form.
        t.startsWith("--force-with-lease") ||
        t.startsWith("--force-if-includes"),
    )
  ) {
    return "`git push --force` rewrites the remote branch";
  }
  return null;
}

// The orchestrator enables this only during merged-branch recovery.
const guardDestructiveGit = process.env.SHIPIT_GUARD_DESTRUCTIVE_GIT === "1";

for (const seg of segments(command)) {
  const reason = offends(seg);
  if (reason) {
    process.stderr.write(
      `Blocked: ${reason}.\n\n` +
        "This ShipIt session is already on its own dedicated branch — " +
        "auto-commit, auto-push, and `gh pr create` all target it. Creating " +
        "or switching branches strands your work off the branch ShipIt is " +
        "tracking. Stay on the current branch and run your git / `gh` " +
        "commands there; `gh pr create` pushes the current branch for you.\n",
    );
    process.exit(2);
  }

  const destructive = guardDestructiveGit ? offendsDestructive(seg) : null;
  if (destructive) {
    process.stderr.write(
      `Blocked: ${destructive}.\n\n` +
        "This session's PR has merged and ShipIt has recorded the merged head " +
        "commit, so the branch is in exactly the state `shipit branch " +
        "reset-to-base` exists to handle. Run that command instead — it moves " +
        "the branch to the fresh base only when doing so is safe (HEAD still " +
        "at the merged tip, clean tree, on the session branch, no rebase or " +
        "merge in progress) and refuses otherwise.\n\n" +
        "If it already refused, that refusal is the signal: the branch is " +
        "carrying something a reset would destroy, and there is no reflog " +
        "entry for uncommitted edits. Report what it said and let the user " +
        "decide — do not reproduce the reset by hand.\n\n" +
        "planning#279: if the user tells you to go ahead anyway, the sanctioned " +
        "override is `shipit branch reset-to-base --force --reason \"<why>\"`, " +
        "not a manual reset. That path is brokered, so it still refuses over " +
        "an uncommitted tree (the one loss with no reflog entry) and it " +
        "records the reason in the transcript. It is also not blocked here — " +
        "this hook only inspects `git` invocations, so the shim passes " +
        "through untouched. A hand-rolled reset does the same damage with no " +
        "check and no record, which is why it stays blocked.\n",
    );
    process.exit(2);
  }
}

process.exit(0);
