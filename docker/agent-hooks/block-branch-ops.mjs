#!/usr/bin/env node
/**
 * ShipIt's PreToolUse guard for the Bash tool. It refuses two shapes: branch
 * changes and destructive git during merged-branch recovery, and a process
 * test whose own pattern matches the command it is written in.
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

// A `pgrep -f` test that can only ever be true. The Bash tool runs a command
// as `bash -c '<the whole command>'`, so every literal in it is part of the
// command line of the process running it, and `pgrep -f` matches full command
// lines. What this judges is the test alone — not a loop's control flow, and
// not whether there is a loop at all. This first shipped scoped to `until` /
// `while` conditions, on the reasoning that a one-shot listing "costs one
// extra line of output". That reasoning was wrong and an incident refuted it:
// `pgrep -f` exits 0 and `pgrep -fc` counts 1 when the job has finished, so a
// bare liveness check returns a wrong answer with nothing to notice, and the
// agent reported a test suite as still running minutes after it ended.

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
  // A delimiter may be quoted, backslash-escaped, or carry characters a bare
  // identifier cannot (`<<"END-TEXT"`), and one line may open several. Missing
  // any of those read the body as commands and refused a `cat`. `<<<` is a
  // herestring and opens nothing, which every branch here declines to match.
  const OPENER = /<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\([^\s;|&<>]+)|([A-Za-z_][A-Za-z0-9_-]*))/g;
  const pending = [];
  let terminator = null;
  for (const one of line.split("\n")) {
    if (terminator !== null) {
      if (one.trim() === terminator) terminator = pending.shift() ?? null;
      continue;
    }
    kept.push(one);
    for (const m of one.matchAll(OPENER)) pending.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (pending.length) terminator = pending.shift();
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
  // Whether the next word would be the COMMAND of a simple command rather than
  // an argument to one. `echo pgrep -f x` prints; it does not run pgrep, and
  // reading the two the same way refuses ordinary work.
  let atCommandStart = true;
  const push = () => {
    if (value !== null) {
      tokens.push({ value, quoted, command: atCommandStart });
      // An env assignment and a reserved word PRESERVE command position; they
      // cannot create one. `echo time pgrep -f x` prints three words, and
      // reading `time` as a keyword there refused an echo. A quoted keyword is
      // not a keyword (bash rejects `wh"ile" x; do`), but `VAR="x" cmd` is
      // still an assignment.
      atCommandStart =
        atCommandStart &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) ||
          (!quoted &&
            ["!", "{", "time", "until", "while", "if", "then", "elif", "else", "do"].includes(value)));
    }
    value = null;
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Inside double quotes bash KEEPS a backslash unless it escapes one of
      // ``$ ` " \`` or a newline. Dropping every one of them changed the regex
      // being judged: `"job\.js"` reaches pgrep as `job\.js` (a literal dot),
      // and reading it as `job.js` made the dot match anything.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === "\n") { i++; continue; }
        if ("$`\"\\".includes(next)) { value += text[++i]; continue; }
      }
      value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; value ??= ""; quoted = true; continue; }
    // A backslash-newline is a line continuation: bash removes it entirely, so
    // it must not seed a word. Seeding one hid the `#` below from the comment
    // test on the line after a continuation.
    if (ch === "\\" && text[i + 1] === "\n") { i++; continue; }
    // Bash starts a comment at a `#` that begins a word, and `value === null`
    // is exactly that position. Only the tokens are dropped: the comment text
    // is still in the process's command line, so it stays matchable below.
    if (ch === "#" && value === null) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    // `2>&1`, `>&2` and `&>/dev/null` are each one redirection word. Reading
    // that `&` as a control operator split the word: `2>&1` left a stray `1`
    // looking like a second pattern, and `&>` ended the arguments early, hiding
    // a `-A` written after it — the very escape the refusal recommends.
    if (ch === "&" && (text[i + 1] === ">" || (value !== null && /[<>]$/.test(value)))) {
      value = (value ?? "") + ch;
      continue;
    }
    // A newline ends a command as surely as `;`. Treating it as plain
    // whitespace ran one command's arguments into the next, which read as a
    // second operand and silently declined to judge anything multi-line.
    if (ch === "\n" || ";|&()".includes(ch)) {
      push();
      const doubled = (ch === "&" || ch === "|") && text[i + 1] === ch;
      if (doubled) i++;
      tokens.push({ value: doubled ? ch + ch : ch === "\n" ? ";" : ch, quoted: false, operator: true });
      atCommandStart = true;
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === "\\" && i + 1 < text.length) { value = (value ?? "") + text[++i]; continue; }
    value = (value ?? "") + ch;
  }
  push();
  return quote ? null : tokens;
}

/** A redirection word — `>`, `2>`, `>>/dev/null`, `&>`. Not an argument, not a command. */
function isRedirection(token) {
  return !token.quoted && /^(?:\d*[<>]|&>)/.test(token.value);
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

/** Every readable `pgrep -f` / `pkill -f` invocation among these tokens. */
function fullMatchInvocations(tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    // An absolute path still names the program, and a quoted one still runs.
    // Command POSITION is the real test: `echo pgrep -f x` prints a word.
    if (tokens[i].command !== true) continue;
    const program = /^(?:.*\/)?(pgrep|pkill)$/.exec(tokens[i].value)?.[1];
    if (!program) continue;
    const args = [];
    let j = i + 1;
    for (; j < tokens.length && tokens[j].operator !== true; j++) {
      // Step over a redirection, and over its operand when it has one. Stopping
      // here instead hid every option written after it — `pgrep -f x >/dev/null
      // -A` is a caller-excluding command bash accepts, and it read as a plain
      // `-f`.
      if (isRedirection(tokens[j])) {
        if (/^\d*[<>]+$/.test(tokens[j].value)) j++;
        continue;
      }
      args.push(tokens[j].value);
    }
    // Piped onward, a `pgrep`'s consumer decides what a match means — filtering
    // the wrapper out with `grep -v` is a correct way to write this, and there
    // is no reading the filter that is not a guess. `pkill` is NOT exempt: it
    // has already sent the signal by the time anything downstream sees a byte,
    // and measured here `pkill -f <self-matching> | cat` still kills the shell.
    if (program === "pgrep" && tokens[j]?.value === "|") continue;
    const pattern = fullCommandLinePattern(args, program);
    if (pattern !== null) found.push({ program, pattern });
  }
  return found;
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
/**
 * Constructs the two regex engines do not read alike. `pgrep` compiles POSIX
 * ERE; this compiles a JS `RegExp`. A bracket expression is the measured case:
 * ERE's `[[:digit:]]+` wants digits, while JS reads it as a character set of
 * `[:digt` followed by `]+` and matches the pattern's own text — so the hook
 * saw a self-match that the real `pgrep` would not have made.
 *
 * Letter escapes are declined as a class rather than enumerated. Measured
 * against the real `pgrep` here, glibc's ERE does support `\w`, so that one
 * agrees; `\d` is a JS extension. Which letters agree is a libc detail this
 * hook should not encode, and declining the lot only costs misses.
 */
function readsDifferentlyAsEre(pattern) {
  return /\[\[:[a-z]+:\]\]/.test(pattern) || /\\[A-Za-z]/.test(pattern);
}

/**
 * A pattern anchored to the START of a command line, which the agent's text
 * never occupies: the real argv begins with the wrapper (`/bin/bash -c …`).
 * Testing `^pgrep…` against the submitted text alone said yes where the live
 * `pgrep` says no, so an opening anchor is declined rather than judged.
 */
function anchoredToCommandStart(pattern) {
  return pattern.startsWith("^");
}

function matchesOwnCommand(pattern, line) {
  if (!pattern) return false;
  if (readsDifferentlyAsEre(pattern) || anchoredToCommandStart(pattern)) return false;
  try {
    return runInNewContext("new RegExp(p).test(s)", { p: pattern, s: line }, {
      timeout: MATCH_TIMEOUT_MS,
    }) === true;
  } catch {
    // Not a regex this runtime reads, or too slow to decide inside the deadline.
    return false;
  }
}

function offendsSelfMatchingProcessTest(line) {
  const tokens = tokenize(withoutHeredocBodies(line));
  if (!tokens) return null;
  for (const found of fullMatchInvocations(tokens)) {
    if (matchesOwnCommand(found.pattern, line)) return found;
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
  selfMatched = offendsSelfMatchingProcessTest(command);
} catch {
  selfMatched = null;
}

if (selfMatched) {
  const consequence =
    selfMatched.program === "pkill"
      ? "This pattern matches ITSELF. `pkill` never signals its own process, but the " +
        "shell running this command carries the same pattern, so this signals your own " +
        "tool call. Measured in this harness: the command dies part-way through, with " +
        "no error and no output after that point.\n"
      : "This test matches ITSELF, so it is true whatever the processes are doing. It " +
        "exits 0 and reports a match when the job you are asking about has already " +
        "finished — `pgrep -fc` counts this shell as 1, and `-a` prints its command " +
        "line among the results. A one-shot check therefore tells you work is still " +
        "running when it is not, and a loop built on it waits for something that has " +
        "already happened, or never notices that it did.\n";
  const waysOut =
    selfMatched.program === "pkill"
      ? "Name the target in a way that cannot include you:\n" +
        "     pkill -f '[v]itest run src/...'    # a pattern that cannot match itself\n" +
        "     pkill -A -f 'vitest run src/...'   # ignore this shell's ancestors\n\n" +
        "Better still, do not hunt for the process at all: a command started with the " +
        "Bash tool's background mode can be stopped by the harness that started it.\n"
      : "Three ways out, best first.\n\n" +
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
        "If you do wait in a loop, bound it, so a mistake costs minutes and not the " +
        "session:\n" +
        "     timeout 600 bash -c 'until ...; done'\n";
  process.stderr.write(
    `Blocked: this \`${selfMatched.program} -f\` looks for \`${selfMatched.pattern}\`, ` +
      "which is text in this very command.\n\n" +
      "The Bash tool runs a command as `bash -c '<the whole command>'`, so every " +
      "literal you write is part of the command line of the process that runs it — " +
      `and \`${selfMatched.program} -f\` matches full command lines. ` +
      `${consequence}\n` +
      waysOut,
  );
  process.exit(2);
}

process.exit(0);
