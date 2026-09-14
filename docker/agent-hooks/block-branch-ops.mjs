#!/usr/bin/env node
/**
 * ShipIt's PreToolUse guard for the Bash tool. It refuses two shapes: branch
 * changes and destructive git during merged-branch recovery, and a wait loop
 * whose own process pattern matches the command it is written in.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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

// A wait loop whose own `pgrep -f` test can only ever be true. The Bash tool
// runs a command as `bash -c '<the whole command>'`, so every literal in it is
// part of the command line of the process running it, and `pgrep -f` matches
// full command lines. What this judges is that test, not the loop's control
// flow: a deadline or a `break` elsewhere can still end the loop, and the test
// is broken either way.

/**
 * Options that cannot change whether the calling shell is among the matches.
 * Anything else — `-x` exact, `-A` ignore-ancestors, `-P` parent, `-v` inverse,
 * a uid or session filter, an option procps adds next year — is a deliberate
 * way to exclude the caller or to invert the test, and the honest answer there
 * is no answer at all.
 */
const HARMLESS_LONG = new Set([
  "--full", "--list-full", "--list-name", "--count", "--ignore-case",
  "--lightweight", "--newest", "--oldest",
]);
const HARMLESS_LONG_WITH_VALUE = new Set(["--delimiter", "--signal"]);
const HARMLESS_SHORT = new Set(["f", "a", "l", "c", "i", "w", "n", "o"]);
const HARMLESS_SHORT_WITH_VALUE = new Set(["d"]);

/** A heredoc body is data the shell feeds a program, never something it runs. */
function withoutHeredocBodies(line) {
  const kept = [];
  let terminator = null;
  for (const one of line.split("\n")) {
    if (terminator !== null) {
      if (one.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(one);
    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(one);
    if (opener) terminator = opener[2];
  }
  return kept.join("\n");
}

/**
 * Tokens, each marked with whether the shell would have quoted it away.
 * Quoting is the difference between code and data: `printf '%s' 'while pgrep
 * -f x; do ...'` runs nothing, and refusing it would refuse ordinary work.
 * Null when the quoting never closes — what cannot be read is not judged.
 */
function tokenize(text) {
  const tokens = [];
  let value = null;
  let quoted = false;
  let quote = null;
  const push = () => {
    if (value !== null) tokens.push({ value, quoted });
    value = null;
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Only a double-quoted context honours a backslash escape.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) { value += text[++i]; continue; }
      value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; value ??= ""; quoted = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (";|&()".includes(ch)) {
      push();
      const doubled = (ch === "&" || ch === "|") && text[i + 1] === ch;
      if (doubled) i++;
      tokens.push({ value: doubled ? ch + ch : ch, quoted: false, operator: true });
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) { value = (value ?? "") + text[++i]; continue; }
    value = (value ?? "") + ch;
  }
  push();
  return quote ? null : tokens;
}

/** Where this invocation's arguments stop: an operator, or a redirection. */
function endsArguments(token) {
  return token.operator === true || (!token.quoted && /^\d*[<>]/.test(token.value));
}

/**
 * The pattern this `pgrep` / `pkill` tests full command lines against, or null
 * for every shape that cannot be read unambiguously. Null is the important
 * half: an option this does not know, or a second operand, means a guess — and
 * a guess here refuses correct work, which a hook has no way to undo.
 */
function fullCommandLinePattern(args, program) {
  let full = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split(/=(.*)/s);
      if (HARMLESS_LONG.has(name)) {
        if (name === "--full") full = true;
        continue;
      }
      if (HARMLESS_LONG_WITH_VALUE.has(name)) {
        if (inline === undefined) i++;
        continue;
      }
      return null;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // A signal names what pkill sends, not what it matches.
      if (program === "pkill" && /^-(\d+|[A-Z]{2,})$/.test(arg)) continue;
      const chars = [...arg.slice(1)];
      let takesNext = false;
      let unknown = false;
      for (const [at, ch] of chars.entries()) {
        if (HARMLESS_SHORT.has(ch)) {
          if (ch === "f") full = true;
          continue;
        }
        // A value-taking option swallows the rest of the cluster, or the next token.
        if (HARMLESS_SHORT_WITH_VALUE.has(ch)) {
          takesNext = at === chars.length - 1;
          break;
        }
        unknown = true;
        break;
      }
      if (unknown) return null;
      if (takesNext) i++;
      continue;
    }
    operands.push(arg);
  }
  return full && operands.length === 1 ? operands[0] : null;
}

/** Every readable `pgrep -f` / `pkill -f` pattern among these tokens. */
function fullMatchPatterns(tokens) {
  const patterns = [];
  for (let i = 0; i < tokens.length; i++) {
    // An absolute path still names the program, and so does a quoted one:
    // quoting stops `while` being a keyword, and does not stop `pgrep` being
    // a command.
    const program = /^(?:.*\/)?(pgrep|pkill)$/.exec(tokens[i].value)?.[1];
    if (!program) continue;
    const args = [];
    for (let j = i + 1; j < tokens.length && !endsArguments(tokens[j]); j++) args.push(tokens[j].value);
    const pattern = fullCommandLinePattern(args, program);
    if (pattern !== null) patterns.push(pattern);
  }
  return patterns;
}

/**
 * The tokens of each `until` / `while` condition, up to that loop's `do`.
 * A quoted keyword is not a keyword — bash refuses `wh"ile" x; do y; done` as
 * a syntax error — so quoting is what separates a loop from a word about one.
 */
function loopConditions(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].quoted || !/^(?:until|while)$/.test(tokens[i].value)) continue;
    let end = i + 1;
    while (end < tokens.length && !(!tokens[end].quoted && tokens[end].value === "do")) end++;
    out.push(tokens.slice(i + 1, end));
  }
  return out;
}

// A pattern is the agent's own text rather than anything hostile, but
// catastrophic backtracking does not care: `a(a+)+$` over 26 characters takes
// seconds, and a `try` cannot interrupt it. A hook that stalls is the failure
// this one exists to prevent, so the match runs under a deadline it can lose.
const MATCH_TIMEOUT_MS = 100;

/**
 * Whether a pattern matches the command it is written in. Matching the command
 * TEXT is the sound half of the question: the harness embeds that text in the
 * process's command line, so a match here is a match there. A pattern that
 * matches only the wrapper around it — `bash`, say — is missed, and a miss
 * costs nothing a refusal would have saved.
 */
function matchesOwnCommand(pattern, line) {
  if (!pattern) return false;
  try {
    return runInNewContext("new RegExp(p).test(s)", { p: pattern, s: line }, {
      timeout: MATCH_TIMEOUT_MS,
    }) === true;
  } catch {
    // Not a regex this runtime reads, or too slow to decide inside the deadline.
    return false;
  }
}

function offendsSelfMatchingWatcher(line) {
  const tokens = tokenize(withoutHeredocBodies(line));
  if (!tokens) return null;
  for (const condition of loopConditions(tokens)) {
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
    `Blocked: this wait loop tests for \`${selfMatched}\`, which is text in this very command.\n\n` +
      "The Bash tool runs a command as `bash -c '<the whole command>'`, so every " +
      "literal you write is part of the command line of the process that runs it — " +
      "and `pgrep -f` matches full command lines. This test matches ITSELF, so it is " +
      "true whatever the processes are doing: the loop waits for something that has " +
      "already happened, or never notices that it did.\n\n" +
      "Three ways out, best first.\n\n" +
      "1. Do not poll for work this harness already tracks. A command started with " +
      "the Bash tool's background mode notifies you when it exits, so there is " +
      "nothing to wait for.\n\n" +
      "2. Wait on the artifact, not the process. Its output has a definite end " +
      "state and matching it reads no process list at all:\n" +
      "     until grep -qE '^(PASS|FAIL)' /tmp/run.log; do sleep 5; done\n\n" +
      "3. If you must match processes, exclude yourself. Any of these is enough, " +
      "and each is left alone here:\n" +
      "     pgrep -A  -f 'vitest run src/...'   # ignore this shell's ancestors\n" +
      "     pgrep -f '[v]itest run src/...'     # a pattern that cannot match itself\n\n" +
      "Bound the wait either way, so a mistake costs minutes and not the session:\n" +
      "     timeout 600 bash -c 'until ...; done'\n",
  );
  process.exit(2);
}

process.exit(0);
