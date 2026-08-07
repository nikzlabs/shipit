#!/usr/bin/env node
/**
 * ShipIt PreToolUse hook: keep the agent on the session's dedicated branch,
 * and — while the session sits on a merged branch — keep it off hand-rolled
 * destructive git.
 *
 * Every ShipIt session is created on its own branch — auto-commit, auto-push,
 * and `gh pr create` all target it. If the agent runs `git checkout -b` (or
 * `git switch -c`, `git branch <name>`, `git switch <other>`), its work is
 * stranded off the branch ShipIt is tracking: commits land nowhere useful and
 * the PR ends up empty.
 *
 * The system prompt already tells the agent not to do this, but the Claude
 * Code CLI also injects its own built-in git guidance ("if on the default
 * branch, branch first") which the agent sometimes follows. This hook is the
 * structural enforcement layer that doesn't depend on prompt precedence.
 *
 * planning#267 adds a SECOND, narrowly-scoped rule on top of the same mechanism:
 * when `SHIPIT_GUARD_DESTRUCTIVE_GIT=1`, `git reset --hard`, `git checkout -f`
 * and force-pushes are blocked too. That env var is set only when the session
 * is merged with a recorded `mergedHeadSha` — i.e. exactly the state
 * `shipit branch reset-to-base` guards (docs/239). That command fails closed on
 * a safety gate (HEAD === mergedHeadSha, clean tree, on the session branch, no
 * in-progress sequencer), and its refusal is what turns three hazards — a wake
 * queued behind uncommitted work, a branch advanced between merge and
 * detection, a duplicate wake after a restart — from unrecoverable data loss
 * into a visible no-op. A refused agent that reaches for
 * `git reset --hard origin/main` reproduces the loss in one line, so the
 * refusal needs the same structural backing as the branch rule.
 *
 * It is deliberately NOT a blanket block: outside that state `git reset --hard`
 * has legitimate uses (throwing away a local mess the user asked to discard),
 * and blocking it everywhere is a worse trade than the hazard.
 *
 * Wired up via /etc/shipit/managed-settings.json (PreToolUse, matcher "Bash").
 * The settings file is always passed to the Claude CLI (see
 * src/server/session/claude.ts), so this hook is always active — unlike the
 * Stop hook, which self-gates on the SHIPIT_AUTO_CREATE_PR env var.
 *
 * Exit codes (Claude Code PreToolUse semantics):
 *   0 - allow the tool call
 *   2 - block the tool call; stderr is fed back to the model
 *
 * Heuristic, not a full shell parser: we split the command on common shell
 * separators and inspect each segment that invokes `git`. False negatives
 * (exotic quoting) are acceptable — the prompt instruction is the first line
 * of defense. False positives are avoided by requiring `git` to be the actual
 * command token of a segment.
 *
 * See docs/130-block-branch-ops/plan.md.
 */

import { readFileSync } from "node:fs";

// docs/211 — a Sandbox session has no single dedicated branch: the agent clones
// repos into /workspace subdirs and owns its own branches/PRs there. Keeping the
// agent pinned to one branch would break that, so the orchestrator sets
// SHIPIT_SANDBOX=1 in the CLI env for sandbox sessions and we no-op here. (The
// gate keys off the server-set env, derived from the session's authoritative
// kind — never anything the agent can write.)
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

/**
 * Split a shell line into the simple commands joined by &&, ||, ;, |, or
 * newlines. Good enough for a hook heuristic — we only need to isolate
 * candidate `git` invocations, not faithfully parse the shell.
 */
function segments(line) {
  return line.split(/\|\||&&|[;\n|]/);
}

/**
 * Locate the git invocation in one segment. Returns `{ sub, rest, positionals }`
 * for a segment whose command token is `git`, or null otherwise. Shared by both
 * rules so they agree on what counts as "actually invoking git".
 */
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

/**
 * Inspect one segment. Returns a human-readable reason string if it would
 * create or switch branches, or null otherwise.
 */
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
    // Read-only forms (`git branch`, `-a`, `-v`, `--list <pattern>`,
    // `--merged`, `--contains`, …) and deletions are fine. A bare positional
    // name with none of those flags means a branch is being created,
    // renamed, or force-moved.
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

/**
 * planning#267 — inspect one segment for hand-rolled destructive git. Only consulted
 * when the session is in the merged state `shipit branch reset-to-base` guards
 * (see `guardDestructiveGit` below). Returns a reason string or null.
 *
 * Scoped to the three forms that can silently discard this branch's work:
 * a hard reset, a forced checkout, and a force-push. Everything else — a mixed
 * or soft reset, `git checkout -- <path>`, a plain push — stays allowed.
 */
function offendsDestructive(seg) {
  const parsed = parseGit(seg);
  if (!parsed) return null;
  const { sub, rest } = parsed;

  if (sub === "reset" && rest.includes("--hard")) {
    return "`git reset --hard` discards this branch's state";
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

// planning#267 — the destructive-git rule is scoped to the merged-with-recorded-head
// state; the orchestrator sets SHIPIT_GUARD_DESTRUCTIVE_GIT=1 for exactly those
// turns (server-derived from the session's `mergedHeadSha`, never anything the
// agent can write). Outside it the rule is off, so an ordinary "throw away my
// local mess" reset is untouched. Note the sandbox exit above already covers
// sandbox sessions, which own their own branches and repos.
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
