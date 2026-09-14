#!/usr/bin/env node
/**
 * ShipIt's PreToolUse guard for the Bash tool. It refuses two shapes: branch
 * changes and destructive git during merged-branch recovery, and a wait loop
 * whose own process pattern matches the command it is written in.
 */

import { readFileSync } from "node:fs";

// Sandbox sessions own their branches (docs/211). That exemption is about
// branch ownership and nothing else, so it scopes the git checks below rather
// than the whole hook — a loop that cannot terminate hangs a sandbox session
// exactly as it hangs any other.
const sandboxSession = process.env.SHIPIT_SANDBOX === "1";

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

// ---------------------------------------------------------------------------
// A wait loop that can never change its own answer.
//
// The Bash tool runs a command as `bash -c '<the whole command>'`, so every
// literal written in the command is part of the command line of the process
// that runs it — and `pgrep -f` matches full command lines. A loop waiting on
// `pgrep -f "<something from this command>"` therefore matches ITSELF: the
// condition is constant, so the loop either never exits (holding the session
// until something kills it) or never waits at all.

/** Options whose value is the NEXT token, so that token is not the pattern. */
const PGREP_VALUE_OPTS = new Set([
  "-d", "--delimiter", "-F", "--pidfile", "-G", "--group", "-g", "--pgroup",
  "-P", "--parent", "-s", "--session", "-t", "--terminal", "-u", "--euid",
  "-U", "--uid", "--ns", "--nslist", "--signal",
]);

/** Shell-ish tokens with quotes removed; null when the quoting does not close. */
function shellTokens(text) {
  const tokens = [];
  let cur = null;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Only a double-quoted context honours a backslash escape.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) { cur += text[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur ??= ""; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { tokens.push(cur); cur = null; } continue; }
    if (ch === "\\" && i + 1 < text.length) { cur = (cur ?? "") + text[++i]; continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) tokens.push(cur);
  return quote ? null : tokens;
}

/** `>/dev/null`, `2>&1`, a bare `>` and friends: never the pattern. */
function isRedirection(token) {
  return /^\d*[<>]/.test(token);
}

/** True when a redirection token's target is the token after it. */
function redirectionTakesNext(token) {
  return /^\d*[<>]{1,2}$/.test(token);
}

/**
 * The pattern a `pgrep` / `pkill` invocation searches full command lines for,
 * or null. Null is the answer for every shape this cannot read unambiguously —
 * an unknown option leaves its value looking like a second operand, and
 * guessing between two operands would refuse correct work.
 */
function fullCommandLinePattern(args) {
  let full = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (isRedirection(arg)) {
      if (redirectionTakesNext(arg)) i++;
      continue;
    }
    if (arg === "--") {
      operands.push(...args.slice(i + 1).filter((t) => !isRedirection(t)));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (name === "--full") full = true;
      else if (!arg.includes("=") && PGREP_VALUE_OPTS.has(name)) i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (/^-\d+$/.test(arg)) continue; // pkill's signal number
      const chars = arg.slice(1).split("");
      if (chars.includes("f")) full = true;
      const valueChar = chars.find((c) => PGREP_VALUE_OPTS.has(`-${c}`));
      // A value-taking short option consumes the next token when it ends the cluster.
      if (valueChar && arg.endsWith(valueChar)) i++;
      continue;
    }
    operands.push(arg);
  }
  return full && operands.length === 1 ? operands[0] : null;
}

/** Every `pgrep -f` / `pkill -f` pattern inside one loop condition. */
function fullMatchPatterns(conditionText) {
  const tokens = shellTokens(conditionText);
  if (!tokens) return []; // unreadable quoting is not something to judge
  const patterns = [];
  for (let i = 0; i < tokens.length; i++) {
    // An absolute path still names the program.
    if (!/^(.*\/)?(pgrep|pkill)$/.test(tokens[i])) continue;
    const args = [];
    for (let j = i + 1; j < tokens.length && !/^[;|&()]/.test(tokens[j]); j++) args.push(tokens[j]);
    const pattern = fullCommandLinePattern(args);
    if (pattern !== null) patterns.push(pattern);
  }
  return patterns;
}

/**
 * The condition of each `until` / `while`, up to its `do`.
 *
 * A quote counts as a start, because `timeout 600 bash -c 'until ...; done'`
 * is a real shape — and is the very one this hook's own advice recommends, so
 * missing it would let the guard bless a watcher that still cannot terminate.
 * The cost is that a loop merely QUOTED and never run, as in `echo "until
 * ..."`, is read as one. That direction is the deliberate one: refusing a
 * command that prints a sentence is a turn, and missing one that hangs is a
 * session.
 */
function loopConditions(line) {
  const out = [];
  const re = /(?:^|[\s;&|('"`])(?:until|while)\b([\s\S]*?)(?:;|\s)\s*do\b/g;
  let match;
  while ((match = re.exec(line)) !== null) out.push(match[1]);
  return out;
}

// A pattern is the agent's own text rather than anything hostile, but a
// pathological one over a very long command is still a way to stall the hook.
const COMMAND_SCAN_LIMIT = 20_000;

/**
 * Whether a pattern matches the command it is written in. Matching the command
 * TEXT is the sound half of the question: the harness embeds that text in the
 * process's command line, so a match here is a match there. A pattern that
 * matches only the wrapper around it — `bash`, say — is missed, and a miss
 * costs nothing a refusal would have saved.
 */
function matchesOwnCommand(pattern, line) {
  if (!pattern || line.length > COMMAND_SCAN_LIMIT) return false;
  try {
    return new RegExp(pattern).test(line);
  } catch {
    return false; // not a pattern this runtime reads as a regex
  }
}

function offendsSelfMatchingWatcher(line) {
  for (const condition of loopConditions(line)) {
    for (const pattern of fullMatchPatterns(condition)) {
      if (matchesOwnCommand(pattern, line)) return pattern;
    }
  }
  return null;
}

// The orchestrator enables this only during merged-branch recovery.
const guardDestructiveGit = process.env.SHIPIT_GUARD_DESTRUCTIVE_GIT === "1";

for (const seg of sandboxSession ? [] : segments(command)) {
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

// Last, and behind a catch: a guard that throws must not refuse correct work,
// and must not cost the git checks above either.
let selfMatched = null;
try {
  selfMatched = offendsSelfMatchingWatcher(command);
} catch {
  selfMatched = null;
}

if (selfMatched) {
  process.stderr.write(
    `Blocked: this wait loop searches for \`${selfMatched}\`, which is text in this very command.\n\n` +
      "The Bash tool runs a command as `bash -c '<the whole command>'`, so every " +
      "literal you write is part of the command line of the process that runs it — " +
      "and `pgrep -f` matches full command lines. This loop matches ITSELF, so its " +
      "condition never changes: it either never exits, holding the session until " +
      "something kills it, or never waits at all.\n\n" +
      "Three ways out, best first.\n\n" +
      "1. Do not poll for work this harness already tracks. A command started with " +
      "the Bash tool's background mode notifies you when it exits, so there is " +
      "nothing to wait for.\n\n" +
      "2. Wait on the artifact, not the process. Its output has a definite end " +
      "state and matching it reads no process list at all:\n" +
      "     until grep -qE '^(PASS|FAIL)' /tmp/run.log; do sleep 5; done\n\n" +
      "3. If you must match processes, bracket one character so the pattern cannot " +
      "match itself. It still matches the target, and the literal in this command " +
      "no longer matches the pattern:\n" +
      "     pgrep -f '[v]itest run src/...'\n\n" +
      "Bound the wait either way, so a mistake costs minutes and not the session:\n" +
      "     timeout 600 bash -c 'until ...; done'\n",
  );
  process.exit(2);
}

process.exit(0);
