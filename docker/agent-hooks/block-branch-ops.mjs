#!/usr/bin/env node
/**
 * ShipIt PreToolUse hook: keep the agent on the session's dedicated branch.
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
 * Inspect one segment. Returns a human-readable reason string if it would
 * create or switch branches, or null otherwise.
 */
function offends(seg) {
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
  const sub = tokens[i];
  const rest = tokens.slice(i + 1);
  const positionals = rest.filter((t) => !t.startsWith("-"));

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
}

process.exit(0);
