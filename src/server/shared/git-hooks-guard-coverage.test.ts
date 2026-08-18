/**
 * planning#384 — the guards have to hold for git spawns nobody has written yet.
 *
 * `git-hooks-guard.test.ts` and `git-tree-uid.test.ts` prove the two mechanisms
 * work. This proves they are *applied everywhere*, by scanning the
 * orchestrator's own source for processes named `git` and failing when one
 * omits either of them:
 *
 *   1. **Hooks** — every raw git spawn goes through `gitArgsWithHooksDisabled`.
 *   2. **Uid** (docs/266-orchestrator-git-trust-boundary E2) — every raw git spawn that names a working
 *      directory also carries `gitSpawnOverridesForTree`, so it runs as the uid
 *      that OWNS that tree rather than as root.
 *
 * Rule 1 exists because the obvious way to cover future call sites — installing
 * git's `GIT_CONFIG_COUNT` env protocol once on the orchestrator process — was
 * tried and rejected: simple-git's `blockUnsafeOperationsPlugin` inspects the
 * environment and refuses to spawn at all when it sees `GIT_CONFIG_COUNT`, and
 * suppressing that would switch off its protection against inherited config
 * injection generally (see `git-hooks-guard.ts`). A source scan buys the same
 * property and fails at CI instead of at runtime.
 *
 * Rule 2 exists for a sharper reason. `safeSimpleGit` applies the uid drop at
 * one choke point, so the ~189 `createGitManager` sites are covered by
 * construction — but a raw `spawn`/`execFile` bypasses that choke point
 * entirely, and the two sites this rule caught when it was written
 * (`git-lfs.ts`'s `runGit`, `git.ts`'s `getFileBufferAtCommit`) were both
 * running as root inside a session workspace. With docs/266-orchestrator-git-trust-boundary E2's
 * `safe.directory=*` removal shipped, such a site does not merely run as root:
 * git refuses it outright, on paths as load-bearing as session provisioning.
 * Catching it at CI is the whole point.
 *
 * The simple-git half of the same problem is covered by ESLint
 * (`no-restricted-imports` on the `simple-git` default export), which is why
 * this only looks at raw process spawns.
 *
 * ## What counts as a git spawn (planning#409)
 *
 * The first version of these rules recognized a git process by one regex:
 * `spawn|execFile|execFileSync|execFileAsync` followed by a quoted `git`
 * literal. That is a rule about the shapes already in the tree, not about the
 * seam — and the seam is what has to hold. `spawnSync("git", …)` and
 * `execSync("git …")` were entirely invisible to it, as was any binary that
 * travelled in a variable, which its own docstring named as a live blind spot.
 * A guard that only sees the call shapes someone already wrote is the same
 * defect as docs/266-orchestrator-git-trust-boundary E1's "covers call sites nobody has written yet", which was
 * true of `safeSimpleGit`'s callers and false of two raw spawns.
 *
 * So a site is now discovered in two steps rather than matched in one:
 *
 *   1. **Which names in this file start a process** — read from the file's own
 *      `node:child_process` import, `as` aliases and all, plus any
 *      `const x = promisify(execFile)` alias. A file that imports nothing from
 *      `node:child_process` is skipped, which is what keeps `RE.exec(line)` and
 *      `db.exec("ALTER TABLE …")` out of a rule that has to name `exec`.
 *   2. **Whether the binary is git** — the first argument, read as a string
 *      literal (through one level of in-file `const`, and through a leading
 *      `/usr/bin/` style path), or, for the shell-string launchers, the first
 *      word of each `&&`/`;`/`|`-separated segment.
 *
 * Which way it fails is a decision, not an accident: **a binary this scanner
 * cannot read fails the build** (third rule below), because the alternative is
 * that `const GIT = "git"` silently exempts a call site from all three rules.
 * The three call sites in the tree today whose binary is computed are listed
 * there by name, so a fourth is a visible diff rather than a silent gap.
 *
 * "Cannot read" includes a *partly* readable one, which is where the second
 * review pass found this rule still fail-open: `` spawn(`${GIT_BIN}`, …) ``
 * yielded the prefix `""` and `` spawn(`/usr/bin/${tool}`, …) `` the basename
 * `bin`, and both read as readable binaries that simply were not git. For an
 * argv launcher the whole argument is the program, so ANY interpolation is
 * unreadable; for a shell string only the first word is, so a prefix that
 * already contains whitespace has settled the question.
 *
 * ## Where these rules stop
 *
 * Written here, in the test, rather than left for the next reader to infer. A
 * guard whose limits are written down is a guard; one whose limits are inferred
 * is a false sense of coverage, and this repo has shipped several of the latter.
 * The standard is planning#410's: it caught `safeSimpleGit(undefined)` and
 * `safeSimpleGit("")` as written shapes and said plainly that
 * `safeSimpleGit(x)`, where `x` is undefined at RUNTIME, reaches no regex at
 * all. The same boundary applies here, and it is the boundary of the method,
 * not of this implementation:
 *
 *   - **This reads source text, so it sees shapes, never values.**
 *     `spawn(bin, …)` where `bin` is computed is caught only as *unreadable*
 *     (the inventory rule); `spawn("git", args, { cwd })` where `cwd` turns out
 *     to be a session workspace at runtime is indistinguishable from one where
 *     it is the bare cache. That is why the uid rule demands
 *     `gitSpawnOverridesForTree(cwd)` — which resolves the tree at runtime —
 *     rather than trying to decide ownership here.
 *   - **A `cwd` inherited from the process** is invisible: a spawn with no
 *     `cwd`, no `-C`, no `--git-dir` and no `clone` passes and runs wherever the
 *     orchestrator started. `build-id.ts`'s `resolveBuildId` is a live instance.
 *   - **Indirection past one in-file `const`** is unreadable, and a name
 *     declared twice is unreadable rather than resolved to the first — but a
 *     value that crosses a module boundary is simply not followed.
 *   - **A launcher that is not `node:child_process`** — an `execa` or
 *     `cross-spawn` dependency — bypasses everything here. Neither is in
 *     `package.json`; adding one means extending this file in the same PR.
 *
 * What is NOT a limit, because it was checked: a wrapped call. `balancedSpan`
 * and `callArguments` read an argument list across lines, and `declarationValue`
 * reads a `const` initializer across lines. planning#410's review found their
 * grep required the binary on the call's own line; the equivalent hole existed
 * here inside `resolveArgv` and is fixed and pinned below.
 *
 * Scope is deliberately the ORCHESTRATOR (plus the `shared/` code it runs).
 * Session-container code is excluded: git inside the session container runs the
 * project's hooks on purpose — the agent is already inside the trust boundary,
 * and a repo's own `pre-commit` formatter firing when the agent commits is what
 * a user expects. `gitSpawnOverridesForTree` is inert there anyway (it returns
 * `{}` unless the process is root).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.join(HERE, "..", "orchestrator"), HERE];
const REPO_SRC = path.join(HERE, "..", "..");

/**
 * `node:child_process` entry points that start a process, split by how they
 * name the command.
 *
 * `fork` is absent on purpose, and for a reason about the shape: it runs a Node
 * *module*, never an arbitrary binary, so it cannot start git at all.
 */
const ARGV_LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
/** The shell-string launchers — one command string, no argv to wrap. */
const SHELL_LAUNCHERS = new Set(["exec", "execSync"]);

interface Launcher {
  /** The name as called in this file — `nodeSpawn` for `spawn as nodeSpawn`. */
  local: string;
  /** The `node:child_process` export it came from. */
  canonical: string;
}

/**
 * The names that start a process in this file, read from its own imports.
 *
 * Scanning for a fixed list of names instead would have to include `exec`, and
 * `exec` in this repo is overwhelmingly `RegExp.prototype.exec` and
 * `Database.exec` — hundreds of them. Binding the rule to what the file
 * actually imported from `node:child_process` is what makes naming `exec`
 * affordable, and it picks up `spawn as nodeSpawn` and
 * `const execFileAsync = promisify(execFile)` for free.
 *
 * `import type { … }` binds no value and is skipped: a type import cannot start
 * anything.
 */
function childProcessLaunchers(src: string): Launcher[] {
  const found = new Map<string, string>();
  const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']node:child_process["']/g;
  for (const stmt of src.matchAll(IMPORT)) {
    if (stmt[1]) continue;
    for (const spec of (stmt[2] ?? "").split(",")) {
      const parsed = /^\s*(?:(type)\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
      if (!parsed || parsed[1]) continue;
      const canonical = parsed[2] ?? "";
      if (!ARGV_LAUNCHERS.has(canonical) && !SHELL_LAUNCHERS.has(canonical)) continue;
      found.set(parsed[3] ?? canonical, canonical);
    }
  }
  const PROMISIFIED = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const [, alias, target] of src.matchAll(PROMISIFIED)) {
    const canonical = found.get(target ?? "");
    if (canonical && alias) found.set(alias, canonical);
  }
  // A namespace import reaches every launcher through one binding, so it would
  // otherwise skip the file entirely — `import * as cp` then `cp.spawn("git", …)`
  // is a silent exemption of exactly the kind planning#409 exists to remove.
  // Nothing in the tree writes it (this repo imports named bindings throughout),
  // which is the cheapest moment to close a shape rather than the most expensive.
  if (childProcessNamespaces(src).length > 0) {
    for (const canonical of [...ARGV_LAUNCHERS, ...SHELL_LAUNCHERS]) {
      if (!found.has(canonical)) found.set(canonical, canonical);
    }
  }
  return [...found].map(([local, canonical]) => ({ local, canonical }));
}

/** Local names bound to the whole `node:child_process` module. */
function childProcessNamespaces(src: string): string[] {
  const NAMESPACE = /import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s*from\s*["']node:child_process["']/g;
  return [...src.matchAll(NAMESPACE)].map((m) => m[1] ?? "").filter(Boolean);
}

/**
 * Drop comment lines before scanning. Docstrings in this very feature quote the
 * `spawn("git", …)` shape they are describing, and a scanner that reads prose as
 * code fails on documentation — which trains people to weaken the scanner.
 * Blanking rather than deleting keeps reported line numbers correct.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  out = out
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? "" : line))
    .join("\n");
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test helpers spin up throwaway fixture repos of their own; they are not
      // the orchestrator operating on a workspace a plugin can write.
      if (entry.name === "integration_tests" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The text of a balanced bracketed span starting at `open` (which must index a
 * `(` or `{`), including both brackets. String and template literals are
 * skipped so a bracket inside one cannot unbalance the walk.
 */
function balancedSpan(src: string, open: number): string {
  const close: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c in close) depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Index of the closing quote of the literal opening at `i`. */
function skipString(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === quote) return j;
  }
  return src.length;
}

/** The comma-separated arguments of a call, split at bracket depth zero. */
function callArguments(callSpan: string): string[] {
  const inner = callSpan.slice(1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(inner, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) args.push(last);
  return args;
}

/** An arrow function or `function` expression passed as a callback argument. */
function looksLikeCallback(arg: string): boolean {
  return arg.startsWith("(") || arg.startsWith("function") || arg.includes("=>");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The options object a git spawn was given, as source text — resolved through
 * one level of in-file `const NAME = { … }` indirection (which is how
 * `services/updates.ts` threads one `gitOpts` through ten call sites).
 *
 * Returns `null` when the argument is an identifier this file does not declare.
 * That is deliberately reported as "cannot prove it has no cwd" rather than
 * waved through: the scanner's job is to fail closed on a shape it cannot read.
 */
function resolveOptions(arg: string | undefined, fileSrc: string): string | null | undefined {
  if (arg === undefined || looksLikeCallback(arg)) return undefined;
  if (arg.startsWith("{")) return resolveSpreads(arg, fileSrc);
  if (!IDENTIFIER.test(arg)) return null;
  const decl = soleDeclaration(arg, fileSrc, "\\{");
  if (!decl) return null;
  return resolveSpreads(balancedSpan(fileSrc, fileSrc.indexOf("{", decl.index)), fileSrc);
}

/**
 * The single in-file `const NAME = …` declaration of a name, or `null` when
 * there is none — or **more than one**.
 *
 * Two declarations mean the name is shadowed, and this scanner has no scopes: it
 * would resolve every call site to whichever came first in the file. Review
 * demonstrated the fail-open half — a top-level `const args = ["status"]` plus a
 * function-local `const args = ["-C", ws, "status"]` makes the second call read
 * as carrying no working directory. Ambiguity is unreadability.
 */
function soleDeclaration(name: string, fileSrc: string, valuePattern: string): RegExpExecArray | null {
  const all = [...fileSrc.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=\\s*${valuePattern}`, "g"))];
  return all.length === 1 ? (all[0] as RegExpExecArray) : null;
}

/**
 * The initializer text of a `const`, from {@link start} to the `;` or line end
 * that closes it **at bracket depth zero**.
 *
 * A line-bounded slice was the shape planning#410's review named as a
 * scanner-design lesson: their grep required the binary on the same line as the
 * call, so every wrapped site read as "none found". This file had the same hole
 * one level in — `resolveArgv` read `[^;\n]*`, so
 *
 * ```ts
 * const args = gitArgsWithHooksDisabled([
 *   "-C", ws, "status",
 * ]);
 * ```
 *
 * resolved to `gitArgsWithHooksDisabled([` and the `-C` on the next line was
 * invisible. Verified fail-open before this existed, and verified red after.
 * Depth-aware scanning is the fix; strings are skipped so a bracket inside one
 * cannot unbalance it.
 */
function declarationValue(fileSrc: string, start: number): string {
  let depth = 0;
  for (let i = start; i < fileSrc.length; i++) {
    const c = fileSrc[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(fileSrc, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (depth === 0 && (c === ";" || c === "\n")) return fileSrc.slice(start, i);
  }
  return fileSrc.slice(start);
}

/**
 * An object literal is only as readable as what it spreads.
 *
 * `execFile("git", args, { ...sharedGitOpts })` starts with `{`, so a naive
 * reading returns the span, finds no `cwd` in it, and concludes there is no
 * working directory — **fail-open**, and review caught it as the shape most
 * likely to appear next. So each `...name` is resolved through the same in-file
 * `const name = { … }` lookup and appended; a spread this file does not declare
 * makes the whole literal unreadable (`null`), which is the fail-closed branch.
 *
 * The same fail-open trap sat one shape further out, and a second review found
 * it: the first version matched only `...identifier`, so `{ ...makeOpts(dir) }`,
 * `{ ...process.env }` and `{ ...base.opts }` matched NOTHING and were kept
 * verbatim — a `cwd` inside any of them was invisible. Every spread is read now,
 * and one that is not a bare in-file `const` makes the literal unreadable.
 *
 * The single exception is the call being DEMANDED,
 * `...gitSpawnOverridesForTree(…)` (and its credential sibling): those return
 * `{uid, gid}` / `{args, env}`, so they cannot be hiding a working directory,
 * and treating them as unreadable would make every compliant site look
 * unreadable. That is a statement about those two functions' return types, not
 * about calls in general.
 */
const DEMANDED_SPREADS = /^(?:gitSpawnOverridesForTree|gitCredentialSpawnOverrides)\s*\(/;

function resolveSpreads(literal: string, fileSrc: string): string | null {
  let out = literal;
  for (const [, spread] of literal.matchAll(/\.\.\.\s*([^,}]+)/g)) {
    const expr = (spread ?? "").trim();
    if (DEMANDED_SPREADS.test(expr)) continue;
    if (!IDENTIFIER.test(expr)) return null;
    const decl = soleDeclaration(expr, fileSrc, "\\{");
    if (!decl) return null;
    out += balancedSpan(fileSrc, fileSrc.indexOf("{", decl.index));
  }
  return out;
}

/**
 * The argv argument, resolved the same way — because `-C` can travel in a
 * variable too.
 *
 * `const args = gitArgsWithHooksDisabled(["-C", ws, "status"]);
 * execFileSync("git", args)` carries a working directory that an inline-only
 * reading cannot see. Review named this as the most plausible future shape. An
 * argv the scanner cannot read is treated as carrying one.
 */
function resolveArgv(arg: string | undefined, fileSrc: string): string | null {
  if (arg === undefined) return null;
  if (!IDENTIFIER.test(arg)) return arg;
  const decl = soleDeclaration(arg, fileSrc, "");
  return decl ? declarationValue(fileSrc, decl.index + decl[0].length) : null;
}

/**
 * The literal text a string expression starts with, and whether that text is the
 * WHOLE string. `null` when the expression is not a string literal at all.
 *
 * A template stops at its first `${`: `` `git clone ${url}` `` yields
 * `"git clone "`, `complete: false`. The completeness flag is the whole point —
 * the first version returned only the text, so `` `${GIT_BIN} status` `` yielded
 * `""`, which read as a perfectly readable binary that simply was not git, and
 * passed every rule in this file with no inventory entry. Review found it. A
 * prefix is worth something only to a reader that knows how much of the string
 * it is.
 */
interface LiteralPrefix { text: string; complete: boolean }

function stringLiteralPrefix(text: string): LiteralPrefix | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") {
      out += text[i + 1] ?? "";
      i++;
      continue;
    }
    if (text[i] === quote) return { text: out, complete: true };
    if (quote === "`" && text[i] === "$" && text[i + 1] === "{") return { text: out, complete: false };
    out += text[i];
  }
  return { text: out, complete: false };
}

/** A binary argument the scanner could read, or the fact that it could not. */
type Binary = { literal: string } | { unreadable: true };

/**
 * The command a launcher was given, resolved through one level of in-file
 * `const NAME = "…"` — because `const GIT = "git"` was, until planning#409, a
 * complete exemption from all three rules in this file.
 *
 * Anything else is `unreadable`, which is a *failure*, not a pass. See the
 * third rule below for why that direction was chosen and what it costs.
 *
 * An interpolated template is unreadable **unless the interpolation cannot
 * reach the program name**. For an argv launcher the whole argument IS the
 * program, so any interpolation makes it unreadable — `` spawn(`/usr/bin/${t}`) ``
 * included, whose prefix would otherwise resolve to the perfectly-innocent
 * basename `bin`. For a shell launcher only the first word is the program, so a
 * prefix that already contains whitespace has settled it: `` `git clone ${url}` ``
 * runs git no matter what `url` is.
 */
function resolveBinary(arg: string | undefined, fileSrc: string, takesArgv: boolean): Binary {
  const readPrefix = (text: string): Binary | null => {
    const prefix = stringLiteralPrefix(text);
    if (prefix === null) return null;
    if (prefix.complete) return { literal: prefix.text };
    const firstWordSettled = !takesArgv && /\S\s/.test(prefix.text);
    return firstWordSettled ? { literal: prefix.text } : { unreadable: true };
  };

  if (arg === undefined) return { unreadable: true };
  const inline = readPrefix(arg);
  if (inline !== null) return inline;
  if (!IDENTIFIER.test(arg)) return { unreadable: true };
  const decl = soleDeclaration(arg, fileSrc, "");
  if (!decl) return { unreadable: true };
  return readPrefix(declarationValue(fileSrc, decl.index + decl[0].length)) ?? { unreadable: true };
}

/**
 * Is this binary git?
 *
 * Matched on the BASENAME, so `/usr/bin/git` counts — an absolute path is the
 * obvious next shape for someone hardening a spawn, and it runs exactly the
 * same program.
 *
 * `git-lfs` deliberately does not count. Not because it is harmless — it reads
 * the repository's config too — but because the remedy these rules demand
 * (`gitArgsWithHooksDisabled`, which prepends `-c core.hooksPath=…`) is a *git*
 * argument that `git-lfs` does not accept, so flagging it would demand a fix
 * that does not work. This repo invokes LFS as `git lfs …`, which IS covered.
 */
function isGitBinary(binary: string): boolean {
  return path.basename(binary.trim()) === "git";
}

/**
 * Does this shell command string run git?
 *
 * Read per SEGMENT, not per string. `cd /srv/ws && git status` is the most
 * natural way to give a shell command a working directory, and reading only the
 * first word of the whole string called it `cd` and let it through — review
 * found that, and it is the single most likely shape this ban exists to catch.
 * So the string is split on shell operators (`&& || ; |`), on grouping, and on
 * quote characters, and every segment's first word is read.
 *
 * Splitting on quotes is what reaches `sh -c "git status"`. It fails toward
 * FALSE POSITIVES — `echo "git is fine"` is flagged — and that is the intended
 * direction: the remedy for a flagged site is to stop using a shell string,
 * which is the right answer either way.
 *
 * Leading `NAME=value` assignments are skipped per segment, since
 * `GIT_TERMINAL_PROMPT=0 git status` runs git just as much as `git status` does.
 */
function shellCommandRunsGit(command: string): boolean {
  for (const segment of command.split(/[;&|"'()]+/)) {
    for (const token of segment.trim().split(/\s+/)) {
      if (/^[A-Za-z_][\w]*=/.test(token)) continue;
      if (isGitBinary(token)) return true;
      break;
    }
  }
  return false;
}

interface LauncherSite {
  file: string;
  line: number;
  /** Whole call text, as written. */
  source: string;
  /** The same, collapsed and clipped for the failure message. */
  text: string;
  /** The local name that was called — `execFileAsync`, `nodeSpawn`, … */
  launcher: string;
  /** Whether it takes an argv array (vs a whole command string). */
  takesArgv: boolean;
  /** The command argument as written, for the failure message. */
  binaryArg: string;
  /** The same, resolved. */
  binary: Binary;
  /** The argv argument as written — what the hooks rule reads. */
  argv: string;
  /** The same, resolved through an in-file `const`; `null` when unreadable. */
  resolvedArgv: string | null;
  /** Options source text, `null` when unreadable, `undefined` when absent. */
  options: string | null | undefined;
}

/**
 * Every call to a `node:child_process` launcher in orchestrator-side source.
 *
 * A match preceded by a `.` is a member call (`this.deps.spawn(…)`, `pty.spawn(…)`,
 * `cp.exec(…)`). Those are kept when the launcher takes an argv, or when the
 * receiver is provably the `node:child_process` module itself; a `.exec(` on
 * anything else is dropped. The reason is about the shape rather than about
 * today's source: `.exec(` is the regular-expression and SQLite method of the
 * same name, which nothing short of type information can tell from a process
 * launch, while `.spawn(`/`.execFile(` on an injected dependency really are
 * process launches and `cp.exec(` on a namespace binding provably is one.
 */
function launcherSites(): LauncherSite[] {
  const sites: LauncherSite[] = [];
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const src = stripComments(fs.readFileSync(file, "utf-8"));
    const launchers = childProcessLaunchers(src);
    if (launchers.length === 0) continue;
    const namespaces = new Set(childProcessNamespaces(src));
    const byLocal = new Map(launchers.map((l) => [l.local, l]));
    // Longest first: `execFile` must not win the alternation over `execFileSync`.
    const names = [...byLocal.keys()].sort((a, b) => b.length - a.length);
    const CALL = new RegExp(`(?<![\\w$])(${names.join("|")})\\s*\\(`, "g");
    for (const match of src.matchAll(CALL)) {
      const launcher = byLocal.get(match[1] ?? "");
      if (!launcher) continue;
      const takesArgv = ARGV_LAUNCHERS.has(launcher.canonical);
      const before = src.slice(Math.max(0, match.index - 80), match.index).replace(/\s+$/, "");
      const receiver = /([A-Za-z_$][\w$]*)\s*\.$/.exec(before)?.[1];
      if (before.endsWith(".") && !takesArgv && !(receiver && namespaces.has(receiver))) continue;
      const span = balancedSpan(src, src.indexOf("(", match.index));
      const args = callArguments(span);
      sites.push({
        file: path.relative(REPO_SRC, file),
        line: src.slice(0, match.index).split("\n").length,
        source: span,
        text: `${launcher.local}${span}`.replace(/\s+/g, " ").slice(0, 140),
        launcher: launcher.local,
        takesArgv,
        binaryArg: args[0] ?? "",
        binary: resolveBinary(args[0], src, takesArgv),
        argv: (takesArgv ? args[1] : undefined) ?? "",
        resolvedArgv: takesArgv ? resolveArgv(args[1], src) : null,
        options: resolveOptions(takesArgv ? args[2] : args[1], src),
      });
    }
  }
  return sites;
}

/** Launcher calls that start a `git` process with an argv the rules can demand. */
function gitSpawnSites(): LauncherSite[] {
  return launcherSites().filter(
    (s) => s.takesArgv && "literal" in s.binary && isGitBinary(s.binary.literal),
  );
}

/**
 * Does this spawn name a working directory — i.e. can it be pointed at a tree
 * ShipIt does not own?
 *
 * Four carriers, because reading only `cwd` misses the other three: a `cwd`
 * option, a `-C <dir>` argument (`services/shipit-source.ts`), a `--git-dir` /
 * `--work-tree` argument, and `GIT_DIR` / `GIT_WORK_TREE` in the spawn's `env`.
 * The last two were named as blind spots in `git-tree-uid.ts` and are checked
 * now rather than described (planning#409); nothing in the tree uses them today,
 * which is exactly when a rule is free to add.
 *
 * A fifth carrier is not a directory the invocation is *given* but one it
 * **creates**: `clone`, `init` and `worktree add` name their destination as an
 * ordinary argument, so a spawn can produce a whole tree while naming no working
 * directory at all. planning#410 found the simple-git instance of exactly this —
 * a bare `safeSimpleGit().raw(["clone", …, targetDir])` cloned as root into a
 * session's state directory, because the choke point resolves the uid from
 * `baseDir` and a clone's destination is not one. The choke point's own comment
 * claimed it "covers a call site nobody has written yet"; that is true of the
 * tree a call READS and false of the tree it WRITES. The raw-spawn form of that
 * blind spot is closed here.
 *
 * Argv and options are read through one level of in-file `const` indirection,
 * including an object literal's own spreads, since either can travel in a
 * variable.
 *
 * Anything the scanner could not read counts as carrying one. That direction is
 * the whole point: an unreadable shape is never treated as proof there is no
 * working directory.
 */
const CREATES_A_TREE = /["'`](?:clone|init|worktree)["'`]/;

function namesAWorkingDirectory(site: LauncherSite): boolean {
  if (site.options === null || site.resolvedArgv === null) return true;
  if (/["'`]-C["'`]|["'`]--git-dir|["'`]--work-tree/.test(site.resolvedArgv)) return true;
  if (CREATES_A_TREE.test(site.resolvedArgv)) return true;
  return site.options !== undefined && /\bcwd\b|\bGIT_DIR\b|\bGIT_WORK_TREE\b/.test(site.options);
}

describe("git spawn coverage: hooks guard", () => {
  it("every orchestrator-side `git` process spawn goes through gitArgsWithHooksDisabled", () => {
    const sites = gitSpawnSites();
    const unguarded = sites
      // `resolvedArgv`, not the raw text: `const args = gitArgsWithHooksDisabled([…]);
      // execFileSync("git", args)` is the shape this file's own resolveArgv
      // docstring holds up as compliant, and reading the raw argument called it
      // `"args"` and told the author to wrap an argv that was already wrapped.
      // `null` (unreadable) stays unguarded — the fail-closed direction.
      .filter((s) => !(s.resolvedArgv ?? "").includes("gitArgsWithHooksDisabled"))
      .map((s) => `${s.file}:${s.line} — ${s.text}`);

    // If this drops to zero the regex has stopped matching anything and the
    // test would pass vacuously — the failure mode that makes a guard test
    // worthless. Fail instead.
    expect(sites.length).toBeGreaterThan(5);

    expect(unguarded, [
      "These spawn a `git` process without disabling repository hooks.",
      "The orchestrator is root and mounts the credential store and the Docker socket,",
      "and a session workspace is writable by untrusted plugin containers (planning#384).",
      "Wrap the argument list: execFileSync(\"git\", gitArgsWithHooksDisabled([...])).",
    ].join("\n")).toEqual([]);
  });
});

describe("git spawn coverage: tree-uid drop (docs/266-orchestrator-git-trust-boundary E2)", () => {
  it("every orchestrator-side `git` spawn with a working directory carries gitSpawnOverridesForTree", () => {
    const sites = gitSpawnSites();
    const withCwd = sites.filter(namesAWorkingDirectory);
    const undropped = withCwd
      // `source`, never the clipped `text` — a rule that stops matching past
      // column 140 is a rule that passes for the longest call sites.
      .filter((s) => !s.source.includes("gitSpawnOverridesForTree")
        && !(s.options ?? "").includes("gitSpawnOverridesForTree"))
      .map((s) => `${s.file}:${s.line} — ${s.text}`);

    // Same vacuity guard as above, one level deeper: the hooks test would still
    // pass if `namesAWorkingDirectory` stopped recognizing any shape, and this
    // one would then assert nothing at all.
    expect(withCwd.length).toBeGreaterThan(3);

    expect(undropped, [
      "These start `git` in a directory without deciding which uid it runs as.",
      "A session workspace is writable by untrusted code, and git executes what",
      "that repository's own config names (filter.*.clean, core.fsmonitor, alias) —",
      "so as root, in the orchestrator, that is arbitrary code beside the Docker",
      "socket and the credential store (docs/266-orchestrator-git-trust-boundary req 1).",
      "Spread the overrides into the options: { cwd, ...gitSpawnOverridesForTree(cwd) }.",
      "It resolves to {} for a root-owned tree, so it is correct to add unconditionally.",
    ].join("\n")).toEqual([]);
  });

  it("recognizes every working-directory carrier and an unreadable options argument", () => {
    // The scanner's own predicate, exercised directly: a rule that silently
    // stopped seeing `-C` or an opaque options variable would leave the suite
    // green while covering less, which is the failure this pins.
    const site = (argv: string, options: string | null | undefined): LauncherSite => ({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv, resolvedArgv: argv, options,
    });

    // These two are NOT "safe" — they are the rule's scope boundary, and saying
    // so is the point (see the negative-assertion note further down). A spawn
    // with no `cwd` and no `-C` still runs somewhere: it inherits the
    // orchestrator's process cwd. `build-id.ts`'s `resolveBuildId` is exactly
    // this shape. It is out of scope because a source scan cannot know what the
    // process cwd will be, NOT because such a spawn cannot touch a repository —
    // which is why `git-tree-uid.ts` names inherited cwd as a live blind spot
    // instead of leaving these assertions to imply it was considered and cleared.
    expect(namesAWorkingDirectory(site('["status"]', "{ encoding: \"utf8\" }"))).toBe(false);
    expect(namesAWorkingDirectory(site('["status"]', undefined))).toBe(false);

    expect(namesAWorkingDirectory(site('["status"]', "{ cwd: dir }"))).toBe(true);
    expect(namesAWorkingDirectory(site('["-C", dir, "status"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', null))).toBe(true);

    // Quoting must not be a bypass — review found the rule read only `"-C"`.
    expect(namesAWorkingDirectory(site("['-C', dir, 'status']", undefined))).toBe(true);
    expect(namesAWorkingDirectory(site("[`-C`, dir]", undefined))).toBe(true);

    // planning#409 — the three carriers `git-tree-uid.ts` used to merely NAME as
    // blind spots. A `--git-dir`/`--work-tree` argument and a `GIT_DIR`/
    // `GIT_WORK_TREE` environment entry each point git at a tree exactly the way
    // `cwd` does, and nothing in the tree uses them, so recognizing them costs
    // nothing today and closes the shape a future call site would reach for.
    expect(namesAWorkingDirectory(site('["--git-dir", dir, "log"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["--work-tree=/srv/ws", "status"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', '{ env: { GIT_DIR: dir } }'))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', '{ env: { GIT_WORK_TREE: ws } }'))).toBe(true);

    // An argv the scanner could not resolve is treated as carrying one.
    expect(namesAWorkingDirectory({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv: "args", resolvedArgv: null,
      options: undefined,
    })).toBe(true);
  });

  it("resolves a `-C` that travels in a variable", () => {
    // Review's most-plausible future shape: the working directory is in the
    // argv, and the argv is in a const. An inline-only reading passes it.
    const src = 'const args = gitArgsWithHooksDisabled(["-C", ws, "status"]);\nexecFileSync("git", args);';
    expect(resolveArgv("args", src)).toContain("-C");
    expect(resolveArgv("elsewhere", src)).toBeNull();
    expect(resolveArgv('["status"]', src)).toBe('["status"]');
  });

  it("follows an options literal's spreads, and fails closed on one it cannot read", () => {
    // `{ ...sharedGitOpts }` starts with `{`, so the naive reading returned the
    // span, found no `cwd`, and called it cwd-free — fail-OPEN. Review caught it.
    const declared = 'const shared = { cwd: dir, timeout: 5 };\nexecFile("git", a, { ...shared });';
    expect(resolveOptions("{ ...shared }", declared)).toContain("cwd");
    expect(resolveOptions("{ ...fromAnotherModule }", declared)).toBeNull();
    // The call being demanded is a call, not an identifier — never unreadable.
    expect(resolveOptions("{ cwd, ...gitSpawnOverridesForTree(cwd) }", declared)).toContain("cwd");
  });

  it("reads a cwd through one level of in-file `const opts = {…}` indirection", () => {
    const src = 'const gitOpts = { cwd: HOST_REPO_DIR, timeout: 5 };\nexecFileSync("git", a, gitOpts);';
    expect(resolveOptions("gitOpts", src)).toContain("cwd");
    // Not declared in this file — unreadable, so the caller must treat it as
    // carrying a working directory rather than assume it does not.
    expect(resolveOptions("somethingElse", src)).toBeNull();
  });
});

/**
 * docs/266-orchestrator-git-trust-boundary E2 / planning#410 — a bare `safeSimpleGit()` has no tree to stat, so
 * it is the ONE orchestrator git shape with no ownership predicate at all.
 *
 * The general statement, because it is what tells the next reader which sites to
 * distrust: **`safeSimpleGit` is complete for the tree a call site READS and
 * blind to a tree it CREATES.** The drop is resolved from `baseDir`, and a
 * `clone` names its destination as an *argument*, never as `baseDir` — so the
 * choke point cannot see the tree about to come into existence, however careful
 * a future call site is.
 *
 * A bare `safeSimpleGit()` is the sharpest case of that: no `baseDir` at all, so
 * it runs as root and leaves its destination `root:root` — after which any later
 * `safeSimpleGit(<destination>)` drops to the destination's session uid and meets
 * a tree it does not own.
 *
 * That is not hypothetical; it is the shape of both defects found in this class.
 * `repo-git.ts`'s `cloneFromCache` was fixed by docs/270, and
 * `plugin-generations.ts`'s `checkoutCommit` had exactly the same bug found by
 * planning#410's audit — a **human** audit, two feature cycles after E1, which
 * is the process this rule replaces. Neither was visible at runtime anywhere it
 * gets exercised: the drop is inert unless the process is root, so every test
 * and the dogfood instance pass either way.
 *
 * So the rule is a census, not a ban. There are legitimate bare sites (a clone
 * whose source is root-owned, a clone from a URL with no local tree at all), and
 * the rule's job is to make ADDING one a decision someone writes down rather
 * than a line that slips through. A new one — in a listed file or a new file —
 * fails the build with the question it has to answer: what owns the destination
 * when the next git call resolves it?
 */
describe("git spawn coverage: bare safeSimpleGit() is a census (docs/266-orchestrator-git-trust-boundary E2)", () => {
  /**
   * `safeSimpleGit()` with no usable `baseDir`, therefore no ownership
   * predicate — including the spellings that are semantically bare but are not
   * an empty argument list.
   *
   * `baseDir` is `string | undefined`, so `safeSimpleGit(undefined)` and
   * `safeSimpleGit("")` behave exactly like `safeSimpleGit()` and an
   * `\(\s*\)`-only rule waved all three through. Caught by the independent
   * review of PR #2366, which is the right way round: a tripwire nobody tries
   * to get past is a tripwire nobody has measured.
   *
   * What it still cannot see, stated rather than implied: `safeSimpleGit(x)`
   * where `x` is a variable that happens to be `undefined` at runtime. No regex
   * reaches that, which is why the rule below is described as a census — a
   * pinned list that makes the literal shape a written-down decision — and NOT
   * as a fail-closed guarantee over the whole bug class.
   */
  const BARE_SIMPLE_GIT = /\bsafeSimpleGit\s*\(\s*(?:undefined\s*|""\s*|''\s*|``\s*)?\)/g;

  /**
   * Every bare site that exists on purpose, with what owns the tree its git
   * touches. Keyed by file and COUNT, not by line, so ordinary edits above a
   * site don't churn the list while a new site still fails.
   *
   * **Both answers are required, and that is the planning#428 correction**
   * (docs/272-shared-cache-ownership req 7). This census used to carry one `why`
   * per site, and every entry answered about the DESTINATION — the question the
   * docs/266 audit had learned to ask. planning#428 is a failure on the SOURCE:
   * root reading a uid-1000 bare cache is `fatal: detected dubious ownership`,
   * and `repo-git.ts:284` was cleared 21/21 by a census that never asked. Two
   * fields, so half an answer cannot pass as a whole one.
   */
  const ALLOWED: Record<string, { count: number; source: string; destination: string }> = {
    "server/orchestrator/repo-git.ts": {
      count: 1,
      source: "cloneFromCache reads the shared bare cache. It is ShipIt's own tree and must be "
        + "root-owned — which planning#428 proved was a belief about the disk, not a fact: 6 of 10 "
        + "production caches were uid 1000 and arming broke session creation here. Now ENFORCED: "
        + "`ensureSharedTreeOwnedByShipIt(this.repoDir)` runs before the clone "
        + "(docs/272-shared-cache-ownership).",
      destination: "A fresh session workspace, handed to the session's identity by the "
        + "object-aware `handWorkspaceBackToWorker(sessionDir)` before the next git call.",
    },
    "server/orchestrator/plugin-generations.ts": {
      count: 1,
      source: "checkoutCommit reads the plugin bare cache — the same `repo-cache/<hash>` root as "
        + "above, via the same `getBareCacheDir`, so the same enforcement covers it: every path "
        + "that populates or refreshes that cache goes through `RepoGit.fetchCache`.",
      destination: "A generation staging dir inside a session, handed over by "
        + "`handWorkspaceBackToWorker(targetDir)` before the dropped git that follows "
        + "(planning#410).",
    },
    "server/orchestrator/services/marketplace.ts": {
      count: 1,
      source: "A URL. There is no local source tree to own, so no ownership predicate applies "
        + "to the read at all.",
      destination: "`<stateDir>/marketplace-cache/<id>` (or a rebuild's staging sibling) — "
        + "ShipIt's own, a sibling of `sessions/` and not under it, so no session handover is "
        + "owed. Its ownership is kept ShipIt's by the boot pass in `startup-janitor.ts`, which "
        + "is what planning#418 lacked: that fix made a broken cache recoverable and left the "
        + "drift that broke it unaddressed.",
    },
  };

  it("every listed bare site answers BOTH ownership questions", () => {
    // The structural half of the rule. A site added with an empty or placeholder
    // answer is the exact failure planning#428 was: a census entry that reads as
    // a clearance without being one.
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(entry.source.length, `${file}: who owns the SOURCE tree?`).toBeGreaterThan(40);
      expect(entry.destination.length, `${file}: who owns the DESTINATION tree?`).toBeGreaterThan(40);
    }
  });

  it("every bare safeSimpleGit() is a listed site with a stated owner", () => {
    const found = new Map<string, number>();
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      const count = [...src.matchAll(BARE_SIMPLE_GIT)].length;
      if (count > 0) found.set(path.relative(REPO_SRC, file).split(path.sep).join("/"), count);
    }

    const expected = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, { count }]) => [file, count]),
    );

    // Vacuity guard, same as the rules above: if the pattern stops matching, the
    // census is empty and asserts nothing.
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    expect(Object.fromEntries([...found].sort()), [
      "A bare `safeSimpleGit()` runs as ROOT and has no tree to resolve a uid from —",
      "it is the only orchestrator git shape with no ownership predicate.",
      "Its destination is left root-owned, and the next `safeSimpleGit(<destination>)`",
      "drops to that path's session uid and meets a tree it does not own —",
      "`fatal: detected dubious ownership`, because ShipIt grants no safe.directory.",
      "Both known instances of this bug had exactly that shape (repo-git.ts's",
      "cloneFromCache, plugin-generations.ts's checkoutCommit) and neither was visible",
      "at runtime: the drop is inert unless the process is root, so tests pass either way.",
      "",
      "If you added one: hand the destination over (handWorkspaceBackToWorker — the",
      "object-aware one, because `clone --local` hardlinks the source's objects) before",
      "the next git call, then add the site here with BOTH answers — who owns the",
      "source and who owns the destination. A site can fail on either, and planning#428",
      "failed on the source while this census asked only about the destination.",
    ].join("\n")).toEqual(expected);
  });

  it("the bare-site pattern reads the argument list, not the name", () => {
    const bare = (src: string): boolean => {
      BARE_SIMPLE_GIT.lastIndex = 0;
      return BARE_SIMPLE_GIT.test(src);
    };

    // Safe because of the SHAPE: a call WITH a directory carries the predicate —
    // `resolveGitTreeUid(baseDir)` decides the uid — so it is not this rule's
    // subject at all. True of any argument, not of the ones written today.
    expect(bare("safeSimpleGit(workspaceDir)")).toBe(false);
    expect(bare("safeSimpleGit(dir, opts)")).toBe(false);

    expect(bare("await safeSimpleGit().raw([...])")).toBe(true);
    expect(bare("const git = safeSimpleGit( );")).toBe(true);

    // The bypasses review found. `baseDir` is `string | undefined`, so each of
    // these IS a bare call — same root, same absent predicate — and the
    // original `\(\s*\)` rule passed all three.
    expect(bare("safeSimpleGit(undefined)")).toBe(true);
    expect(bare('safeSimpleGit("")')).toBe(true);
    expect(bare("safeSimpleGit('')")).toBe(true);

    // NOT caught, and the rule says so rather than pretending otherwise: a
    // variable that is `undefined` at runtime is invisible to any regex. This
    // assertion is the honest record of the rule's edge, not a claim that the
    // shape is safe.
    expect(bare("safeSimpleGit(maybeDir)")).toBe(false);
  });
});

/**
 * planning#428 / docs/272-shared-cache-ownership req 7 — **every** clone, not
 * just the bare ones.
 *
 * The census above covers the shape with no ownership predicate at all. But the
 * question planning#428 exposed — *who owns the SOURCE?* — applies to a clone
 * whether or not it has a `baseDir`, and the sites that DO have one were audited
 * by hand in the arming runbook's Table B2. A hand-audited table is exactly what
 * goes stale: Table B2 cleared `repo-git.ts:284` as "shared bare cache,
 * root-owned", which was true of the code and false of the disk.
 *
 * So this rule moves that table into CI. Every clone site is listed with both
 * answers, and a new one fails the build with the two questions it has to answer.
 *
 * **The stated gap**, because an unstated one is worse than a named one:
 * simple-git's `.clone()` METHOD form is not matched here — the pattern reads the
 * `"clone"` argv literal, which is how every raw and `raw([...])` clone in this
 * tree is written. There is exactly one method-form site
 * (`services/marketplace.ts`'s `cloneCatalog`), it is censused by the bare rule
 * above with both answers, and a `.clone(`-shaped pattern would collide with
 * `Response.clone()` (`trackers/github/adapter.ts`) the same way `.exec(` collides
 * with `RegExp.prototype.exec` several hundred times over.
 */
describe("git spawn coverage: every clone states both owners (planning#428)", () => {
  /**
   * `"clone"` in the SUBCOMMAND POSITION — the first element of an argv array,
   * `["clone", …]`, across a line break too (`session-fork-merge.ts` writes it
   * one argument per line).
   *
   * Anchored on the `[` rather than matching the bare word, because the word is
   * also a perfectly ordinary string in this tree:
   * `credentialFreeRemote(url, "clone")` passes it as a CONTEXT LABEL for a log
   * line, one argument away from the real subcommand on the same line. An
   * unanchored pattern counted that as a fourth clone site in `repo-git.ts` —
   * caught by this rule failing on its own first run, which is the cheap version
   * of the lesson: a census whose pattern over-matches gets its numbers padded
   * until someone stops trusting them.
   */
  const CLONE_ARGV = /\[\s*(["'])clone\1/g;

  const CLONE_SITES: Record<string, { count: number; source: string; destination: string }> = {
    "server/orchestrator/repo-git.ts": {
      count: 3,
      source: "Two clone from a URL (`clone`, `cloneBare`) — no local source tree, so nothing to "
        + "own. The third (`cloneFromCache`) reads the shared bare cache and is the planning#428 "
        + "site: enforced ShipIt-owned by `ensureSharedTreeOwnedByShipIt` before the clone.",
      destination: "The URL clones write into `baseDir` itself — the cache dir, root-owned. "
        + "`cloneFromCache`'s destination is a session workspace, handed over object-aware.",
    },
    "server/orchestrator/plugin-generations.ts": {
      count: 1,
      source: "The plugin bare cache under the same `repo-cache/<hash>` root, same enforcement.",
      destination: "A generation staging dir inside a session, handed over by "
        + "`handWorkspaceBackToWorker` before the dropped git that follows.",
    },
    "server/orchestrator/services/session-fork-merge.ts": {
      count: 1,
      source: "The ACTIVE SESSION's workspace — a tree untrusted code can write, so it must NOT "
        + "be read as root: the clone runs dropped to the source session's own identity "
        + "(planning#407). The mirror image of the cache case, and the reason `--no-hardlinks` "
        + "is required there (root-owned 0444 objects a non-root uid may not link).",
      destination: "The fork's workspace: created first, chowned to the SOURCE identity for the "
        + "clone's duration, then sealed and handed to the FORK's identity. Both orderings are "
        + "argued in place.",
    },
  };

  it("every listed clone site answers BOTH ownership questions", () => {
    for (const [file, entry] of Object.entries(CLONE_SITES)) {
      expect(entry.source.length, `${file}: who owns the SOURCE tree?`).toBeGreaterThan(40);
      expect(entry.destination.length, `${file}: who owns the DESTINATION tree?`).toBeGreaterThan(40);
    }
  });

  it("every `\"clone\"` argv site is censused", () => {
    const found = new Map<string, number>();
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      const count = [...src.matchAll(CLONE_ARGV)].length;
      if (count > 0) found.set(path.relative(REPO_SRC, file).split(path.sep).join("/"), count);
    }

    const expected = Object.fromEntries(
      Object.entries(CLONE_SITES).map(([file, { count }]) => [file, count]),
    );

    // Vacuity guard: a pattern that matches nothing asserts nothing.
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    expect(Object.fromEntries([...found].sort()), [
      "A clone spans TWO trees with two owners, and it can fail on either:",
      "  - the SOURCE, because git's ownership check tests the repository being READ",
      "    and `clone --local` can only hardlink an object file the cloning identity",
      "    may link (`protected_hardlinks` is 1 on the deploy hosts);",
      "  - the DESTINATION, because the next `safeSimpleGit(<destination>)` drops to",
      "    that path's session uid and meets whatever the clone left behind.",
      "",
      "planning#428 was a SOURCE failure that a destination-only census cleared 21/21,",
      "against a build that then could not start a session for 6 of 10 repositories.",
      "So list the site here with BOTH answers.",
    ].join("\n")).toEqual(expected);
  });
});

/**
 * planning#409 — the two rules above are only worth what their *discovery* is
 * worth, and discovery used to be one regex over four launcher names and a
 * quoted `git` literal.
 *
 * Everything below widens that, and each rule here is the enforced version of a
 * sentence `git-tree-uid.ts` previously carried as a named gap.
 */
describe("git spawn coverage: what counts as a git spawn (planning#409)", () => {
  /**
   * Launcher calls whose binary this scanner cannot read, as
   * `file — launcher(argument)`.
   *
   * These are the calls that are invisible to the hooks and uid rules, and this
   * is the fail-closed direction being paid for: a computed binary FAILS unless
   * it is listed, rather than passing silently. The cost is real — none of the
   * three below can start git — and it is the cost that buys the property that
   * `const GIT = "git"; spawn(GIT, …)` cannot exempt a call site from every rule
   * in this file, which is what it did before.
   *
   * No line numbers: an inventory keyed on line churns on every edit above it,
   * and a rule people renumber is a rule people stop reading.
   */
  const BINARY_NOT_READABLE = [
    // `cliInvocation(agentId, …)` — an agent CLI, `claude` or `codex`.
    "server/orchestrator/services/redaction.ts — execFile(binary)",
    // The resolved agent harness binary, from the agent registry.
    "server/orchestrator/session-namer.ts — execFile(binary)",
    // `LOCK_ONLY_COMMAND[detectPackageManager(dir)]` — npm, pnpm or yarn.
    "server/orchestrator/templates.ts — execFile(cmd)",
  ];

  it("no launcher call starts a binary this scanner cannot read", () => {
    const unreadable = launcherSites()
      .filter((s) => !("literal" in s.binary))
      .map((s) => `${s.file} — ${s.launcher}(${s.binaryArg})`)
      .sort();

    // NOT de-duplicated. A `Set` here would let a SECOND `execFile(binary)` in
    // `redaction.ts` — one that does start git — collapse onto the entry already
    // approved for the first, with no diff to review. Review caught that; an
    // inventory that absorbs new call sites silently is the trap this shape is
    // most prone to.
    expect(unreadable, [
      "A `spawn`/`execFile` whose command is computed is invisible to every rule in",
      "this file: the hooks wrapper, the tree-uid drop, and the safe.directory ban all",
      "start by asking whether the binary is git, and this one cannot be asked.",
      "`const GIT = \"git\"` used to be a complete, silent exemption.",
      "",
      "If the new call cannot start git, add it to BINARY_NOT_READABLE with the reason.",
      "If it can, make the binary a literal so the other rules can see it.",
    ].join("\n")).toEqual(BINARY_NOT_READABLE);
  });

  it("no orchestrator-side code runs git through a shell command string", () => {
    const shellGit = launcherSites()
      .filter((s) => !s.takesArgv && "literal" in s.binary && shellCommandRunsGit(s.binary.literal))
      .map((s) => `${s.file}:${s.line} — ${s.text}`);

    expect(shellGit, [
      "`exec`/`execSync` take one command STRING, so there is no argument list for",
      "`gitArgsWithHooksDisabled` to wrap — a git call in this shape cannot satisfy the",
      "hooks rule at all, and it adds a shell that re-splits interpolated paths.",
      "Use execFile/spawn with an argv: execFile(\"git\", gitArgsWithHooksDisabled([...])).",
    ].join("\n")).toEqual([]);
  });

  it("reads the launchers a file actually imported, aliases included", () => {
    const cp = (body: string): string[] =>
      childProcessLaunchers(body).map((l) => `${l.local}:${l.canonical}`).sort();

    expect(cp('import { spawn } from "node:child_process";')).toEqual(["spawn:spawn"]);
    expect(cp('import { spawn as nodeSpawn } from "node:child_process";')).toEqual(["nodeSpawn:spawn"]);
    expect(cp('import { execFile, execFileSync } from "node:child_process";'))
      .toEqual(["execFile:execFile", "execFileSync:execFileSync"]);

    // `spawnSync` and `execSync` — the two entry points the original regex could
    // not see at all. A future `spawnSync("git", …)` was a silent exemption.
    expect(cp('import { spawnSync, execSync } from "node:child_process";'))
      .toEqual(["execSync:execSync", "spawnSync:spawnSync"]);

    // The alias IS the call site: `services/updates.ts` calls `execFileAsync`.
    expect(cp('import { execFile } from "node:child_process";\nconst execFileAsync = promisify(execFile);'))
      .toEqual(["execFile:execFile", "execFileAsync:execFile"]);

    // Safe because of the SHAPE, not because of the file: a `type` import binds
    // no value, so nothing named by one can start a process — true of every type
    // import. `service-manager.ts` and both oauth refreshers have exactly this
    // line beside a real value import, and the real one is still found.
    expect(cp('import type { ChildProcess } from "node:child_process";')).toEqual([]);
    expect(cp('import { spawn } from "node:child_process";\nimport type { SpawnOptions } from "node:child_process";'))
      .toEqual(["spawn:spawn"]);

    // Safe because of the SHAPE: `exec` from anywhere other than
    // `node:child_process` is a different function. This is what makes naming
    // `exec` affordable at all — `RegExp.prototype.exec` and `Database.exec`
    // appear hundreds of times in this tree, in files that import neither.
    expect(cp('import { promisify } from "node:util";')).toEqual([]);
    expect(cp('import { exec } from "./my-helpers.js";')).toEqual([]);

    // A namespace import reaches every launcher through one binding, so binding
    // the scan to named imports alone would skip such a file outright — the same
    // silent-exemption shape as `const GIT = "git"`. Nothing writes it today,
    // which is the cheapest moment to close it.
    expect(cp('import * as cp from "node:child_process";'))
      .toEqual(["exec:exec", "execFile:execFile", "execFileSync:execFileSync",
        "execSync:execSync", "spawn:spawn", "spawnSync:spawnSync"]);
    expect(childProcessNamespaces('import * as cp from "node:child_process";')).toEqual(["cp"]);
    // Safe because of the SHAPE: a named-import clause binds the names inside
    // the braces, never the module, so there is no receiver to call through.
    expect(childProcessNamespaces('import { spawn } from "node:child_process";')).toEqual([]);
  });

  it("resolves a binary through a literal, a path, and one level of `const`", () => {
    const src = 'const GIT = "git";\nconst DOCKER = "docker";\nspawn(GIT, args);';
    expect(resolveBinary('"git"', src, true)).toEqual({ literal: "git" });
    // The exemption this rule closes: the binary in a variable.
    expect(resolveBinary("GIT", src, true)).toEqual({ literal: "git" });
    expect(resolveBinary("DOCKER", src, true)).toEqual({ literal: "docker" });
    // Computed — the fail-closed branch, inventoried above rather than waved through.
    expect(resolveBinary("binary", src, true)).toEqual({ unreadable: true });
    expect(resolveBinary(undefined, src, true)).toEqual({ unreadable: true });

    // An absolute path runs the same program, so it is the same rule.
    expect(isGitBinary("git")).toBe(true);
    expect(isGitBinary("/usr/bin/git")).toBe(true);
    // Safe because of the SHAPE: these are different programs, and demanding a
    // git-only flag (`-c core.hooksPath=…`) of them would be a fix that fails.
    // `git-lfs` is named here as a boundary, NOT as harmless — this repo reaches
    // LFS as `git lfs …`, which the rules above do cover.
    expect(isGitBinary("docker")).toBe(false);
    expect(isGitBinary("git-lfs")).toBe(false);
    expect(isGitBinary("/opt/gitless/bin/gitless")).toBe(false);
  });

  it("reads the binary out of a shell command string, past env assignments", () => {
    expect(shellCommandRunsGit("git status")).toBe(true);
    expect(shellCommandRunsGit("  /usr/bin/git fetch origin  ")).toBe(true);
    // A leading assignment is the natural way to write this in a shell string,
    // and it still runs git.
    expect(shellCommandRunsGit("GIT_TERMINAL_PROMPT=0 git fetch")).toBe(true);

    // Safe because of the SHAPE: the first word is the program, and these name
    // other programs. A `git` appearing later is an argument — `npm run git` runs
    // npm — so the rule reads the first word only.
    expect(shellCommandRunsGit("docker ps")).toBe(false);
    expect(shellCommandRunsGit("npm run git")).toBe(false);

    // A template's prefix is enough for a SHELL command, because interpolation
    // cannot change the first word of a string that already starts with one.
    expect(stringLiteralPrefix(`\`git clone \${url}\``)).toEqual({ text: "git clone ", complete: false });
    expect(stringLiteralPrefix(`\`\${bin} clone\``)).toEqual({ text: "", complete: false });
    expect(stringLiteralPrefix('"git status"')).toEqual({ text: "git status", complete: true });
    expect(stringLiteralPrefix("someVariable")).toBeNull();

    // …and NOT enough for an argv launcher, where the whole argument is the
    // program. This is the hole review found: the prefix used to be returned
    // bare, so `${GIT_BIN}` read as the readable non-git binary "" and
    // `/usr/bin/${tool}` as the readable non-git binary "bin" — both passing
    // every rule in this file with no inventory entry.
    expect(resolveBinary(`\`\${GIT_BIN}\``, "", true)).toEqual({ unreadable: true });
    expect(resolveBinary(`\`/usr/bin/\${tool}\``, "", true)).toEqual({ unreadable: true });
    expect(resolveBinary(`\`git clone \${url}\``, "", false)).toEqual({ literal: "git clone " });
    expect(resolveBinary(`\`\${GIT_BIN} status\``, "", false)).toEqual({ unreadable: true });
  });

  it("splits a shell command into segments, so `cd X && git …` is not hidden by `cd`", () => {
    // The shape the ban exists for, and the one reading only the first word of
    // the whole string let straight through.
    expect(shellCommandRunsGit("cd /srv/ws && git status")).toBe(true);
    expect(shellCommandRunsGit("mkdir -p x; git init x")).toBe(true);
    expect(shellCommandRunsGit('sh -c "git status"')).toBe(true);
    expect(shellCommandRunsGit("ls | git hash-object --stdin")).toBe(true);

    // Safe because of the SHAPE: no segment of either starts with git. `git` as
    // a later word is an argument to another program, and an argument cannot
    // start a process.
    expect(shellCommandRunsGit("npm run git")).toBe(false);
    expect(shellCommandRunsGit("docker ps && docker rm x")).toBe(false);
  });

  it("treats a shadowed name as unreadable rather than resolving it to the first declaration", () => {
    // This scanner has no scopes. Review showed the fail-open half: a top-level
    // `const args = ["status"]` makes a later, function-local
    // `const args = ["-C", ws, …]` read as carrying no working directory.
    const shadowed = 'const args = ["status"];\nfunction f() { const args = ["-C", ws, "status"]; }';
    expect(resolveArgv("args", shadowed)).toBeNull();
    expect(resolveArgv("args", 'const args = ["-C", ws];')).toContain("-C");

    const twoOpts = "const opts = { timeout: 5 };\nfunction f() { const opts = { cwd: dir }; }";
    expect(resolveOptions("opts", twoOpts)).toBeNull();
  });

  it("reads a `const` initializer that wraps across lines", () => {
    // planning#410's review named this as a scanner-design lesson: their grep
    // required the binary on the same line as the call, so every wrapped site
    // read as "none found". This file had the identical hole one level in —
    // `resolveArgv` read `[^;\n]*`, so the `-C` below sat on a line the resolver
    // never reached and the uid rule passed a site that carries one. Verified
    // fail-open before the depth-aware reader existed.
    const wrapped = 'const args = gitArgsWithHooksDisabled([\n  "-C",\n  ws,\n  "status",\n]);';
    expect(resolveArgv("args", wrapped)).toContain("-C");
    expect(resolveArgv("args", wrapped)).toContain("gitArgsWithHooksDisabled");

    // The call itself was never line-bound — `balancedSpan` reads the argument
    // list across lines — so a wrapped CALL was always seen. It is the resolver
    // that was, and this pins both halves.
    const wrappedBinary = 'const GIT =\n  "git";';
    expect(resolveBinary("GIT", wrappedBinary, true)).toEqual({ literal: "git" });
  });

  it("fails closed on a spread it cannot read, whatever shape the spread has", () => {
    // The first version matched only `...identifier`, so a spread of a CALL or a
    // member expression matched nothing at all and was kept verbatim — a `cwd`
    // inside it invisible. Review found all three shapes.
    const src = "const shared = { cwd: dir };";
    expect(resolveOptions("{ ...makeOpts(dir) }", src)).toBeNull();
    expect(resolveOptions("{ ...process.env }", src)).toBeNull();
    expect(resolveOptions("{ ...base.opts }", src)).toBeNull();
    expect(resolveOptions("{ ...shared }", src)).toContain("cwd");

    // Safe because of what these two functions RETURN — `{uid, gid}` and
    // `{args, env}` — not because they are calls. They cannot carry a working
    // directory, and they are the very thing the uid rule demands, so treating
    // them as unreadable would make every compliant call site look unreadable.
    expect(resolveOptions("{ cwd, ...gitSpawnOverridesForTree(cwd) }", src)).toContain("cwd");
    expect(resolveOptions("{ ...gitCredentialSpawnOverrides(cred) }", src)).not.toBeNull();
  });

  it("counts a tree a git spawn CREATES, not only one it is given (planning#410)", () => {
    const site = (argv: string): LauncherSite => ({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv, resolvedArgv: argv, options: undefined,
    });

    // `clone`/`init`/`worktree add` name their destination as an ordinary
    // argument, so the invocation writes a whole tree while naming no working
    // directory. planning#410 found the simple-git form of this cloning as root
    // into a session's state directory.
    expect(namesAWorkingDirectory(site('["clone", "--local", src, dest]'))).toBe(true);
    expect(namesAWorkingDirectory(site('["init", dest]'))).toBe(true);
    expect(namesAWorkingDirectory(site('["worktree", "add", dest]'))).toBe(true);

    // Safe because of the SHAPE: these read an existing repository and create no
    // tree, so the uid that should run them is the one that owns the tree they
    // are pointed at — which is the `cwd`/`-C` question, already asked above.
    expect(namesAWorkingDirectory(site('["merge-base", "--is-ancestor", a, b]'))).toBe(false);
    expect(namesAWorkingDirectory(site('["rev-parse", "HEAD"]'))).toBe(false);
  });
});

/**
 * docs/266-orchestrator-git-trust-boundary E2 — nobody may hand git a `safe.directory` except the one place that
 * owns the policy.
 *
 * This is the rule the correction earned. `safe.directory` is honoured from
 * git's **protected configuration** — the system and global files, the command
 * line, and the config environment protocols. Stated as a rule because the list
 * keeps being wrong: *anything ShipIt itself puts in a git process's argv or
 * environment can re-grant trust; only the repository's own config cannot.*
 * Measured against git 2.39.5 with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`,
 * correcting a claim this repo carried in four places that `-c` was never
 * honoured. The repo-local half is genuinely NOT honoured, which is what the
 * boundary rests on: the untrusted side owns `.git/config` and still cannot
 * grant itself trust.
 *
 * So this is not a hole — a `-c` and the `GIT_CONFIG_*` env protocol come from
 * ShipIt's own argv and environment, never from the repository. It is a
 * maintenance rule: the fail-closed refusal E2 arms can be silenced by ShipIt's
 * OWN code, one `-c safe.directory=*` at a time, by someone fixing a "git
 * suddenly refuses this path" bug the fastest way rather than the right way.
 * That is a lint, not a sentence in a doc.
 *
 * The env half is covered elsewhere and only partly, and the gap is bigger than
 * the first version of this rule assumed. Git has **two** environment protocols
 * with protected-configuration weight, and simple-git guards only one:
 * `vulnerabilityCheck` flags `GIT_CONFIG_COUNT` and returns nothing for
 * `GIT_CONFIG_PARAMETERS` (verified by calling it directly). Measured on git
 * 2.39.5: `GIT_CONFIG_PARAMETERS="'safe.directory=*'"` re-grants exactly like
 * `-c`. `RepoGit.sanitizeGitEnv` strips both, but only on RepoGit's own call
 * chains — a raw `spawn` forwarding `process.env` (`git-lfs.ts`,
 * `git-lfs-blob.ts`) does not.
 *
 * The first version of this rule not only missed `GIT_CONFIG_PARAMETERS`, its
 * pinning test asserted a line naming it was NOT flagged — pinning the gap open.
 * Found by independent review; both protocols are covered now.
 *
 * ## Why the negative assertions below are written the way they are
 *
 * A `toBe(false)` here is not a neutral statement about a regex. It is a claim
 * that a shape is SAFE to ignore, and a wrong one is worse than no test at all:
 * it converts an unknown into a certified-false known, so the next reader stops
 * looking. That is exactly how `GIT_CONFIG_PARAMETERS` got missed — an assertion
 * that a line naming it was not flagged read as "considered and excluded" when
 * the truth was "never considered".
 *
 * So every `toBe(false)` in this file must say WHY the shape is safe, not merely
 * that it is excluded, and the reason must be about the shape rather than about
 * the current source. The one below is safe because a trailing `//` comment
 * cannot pass anything to git — a property of comments, not of
 * `github-ci-fix.ts`. If you widen these rules and cannot write that sentence
 * for an exclusion, the exclusion is wrong.
 */
describe("git spawn coverage: nobody re-grants safe.directory (docs/266-orchestrator-git-trust-boundary E2)", () => {
  /**
   * The one module that owns the policy — `git-config.ts`'s
   * `removeSafeDirectoryGrant`.
   *
   * It names the key in order to `--unset-all` it, which is the opposite of a
   * grant: the gitconfig lives in a persistent volume and pre-planning#410
   * builds wrote `safe.directory=*` into it, so boot has to actively remove one.
   * This rule stays scoped to that module rather than being tightened to "nobody
   * anywhere", because the removal has to live somewhere and the line below
   * still constrains WHAT it may do there.
   */
  const POLICY_OWNER = path.join("orchestrator", "git-config.ts");

  /**
   * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` being **set** — as an object key or
   * an assignment. Deliberately not a bare name match: `repo-git.ts` lists these
   * variables in `sanitizeGitEnv`'s strip list, which is the opposite of the
   * hazard and must not be flagged.
   */
  const CONFIG_ENV_SET = /\bGIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)["'`]?\s*[:=][^=]/;

  /**
   * The key being **passed to git** — quoted as a config key, or written in
   * `key=value` form — rather than merely mentioned.
   *
   * `stripComments` blanks whole comment lines but not a trailing `//` (widening
   * it would eat the `//` in every URL literal), so a bare name match flags
   * `github-ci-fix.ts`'s `// GHA safe.directory` annotation on a CI-log noise
   * pattern. The shapes that matter are all quoted or `=`-joined:
   * `["-c", "safe.directory=*"]`, `["config", "--global", "safe.directory"]`.
   * A name assembled from fragments at runtime would slip through; nothing in
   * this repo does that, and it is not the mistake this rule guards against.
   */
  const PASSES_SAFE_DIRECTORY = /["'`]safe\.directory|safe\.directory\s*=/;

  /**
   * The single form the policy owner may use — `--unset-all`, the REMOVAL.
   *
   * planning#410 deleted the grant, so "nobody grants `safe.directory`" is now
   * true without exception and the rule says so. Before, this only demanded the
   * `config --global` scope, which would still have passed a
   * `["config", "--global", "safe.directory", "*"]` reintroducing the grant in
   * the one file allowed to name the key at all.
   */
  const isTheRemoval = (line: string): boolean => line.includes('"--unset-all"');

  it("nothing grants safe.directory, and only git-config.ts may even name it", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of ROOTS.flatMap(sourceFiles)) {
      const rel = path.relative(REPO_SRC, file);
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      scanned++;
      if (rel.endsWith(POLICY_OWNER)) {
        // Even here, only the `git config --global --unset-all` form is allowed.
        // The scope matters because the global config is what the untrusted side
        // cannot reach, so a `-c` would defeat its own purpose; the `--unset-all`
        // matters because after planning#410 there is no legitimate grant left to
        // write, in any scope, from anywhere.
        for (const line of src.split("\n")) {
          if (!PASSES_SAFE_DIRECTORY.test(line)) continue;
          if (!line.includes('"config", "--global"')) {
            offenders.push(`${rel} — safe.directory outside the \`config --global\` removal: ${line.trim()}`);
          } else if (!isTheRemoval(line)) {
            offenders.push(`${rel} — grants safe.directory instead of removing it: ${line.trim()}`);
          }
        }
        continue;
      }
      if (PASSES_SAFE_DIRECTORY.test(src)) {
        offenders.push(`${rel} — passes safe.directory to git outside ${POLICY_OWNER}`);
      }
    }

    // Vacuity guard: if the walker stops finding files, this asserts nothing.
    expect(scanned).toBeGreaterThan(50);

    expect(offenders, [
      "`safe.directory` is honoured from git's protected configuration — which is",
      "everything ShipIt itself supplies (system/global files, the command line,",
      "the config env protocols) and never the repository's own config. So a `-c",
      "safe.directory=...` anywhere in ShipIt's own code silences exactly the",
      "`detected dubious ownership` refusal docs/266-orchestrator-git-trust-boundary E2 armed (req 7).",
      "The refusal is the signal that a git call site failed to drop to the tree's",
      "owner. Fix the call site with gitSpawnOverridesForTree — never the refusal.",
      `Only ${POLICY_OWNER}'s \`git config --global --unset-all\` may name the key,`,
      "and only to remove a grant a pre-planning#410 build persisted into the",
      "credentials volume. Nothing may write one.",
    ].join("\n")).toEqual([]);
  });

  it("nothing sets git's GIT_CONFIG_* environment protocol", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      for (const [i, line] of src.split("\n").entries()) {
        if (CONFIG_ENV_SET.test(line)) {
          offenders.push(`${path.relative(REPO_SRC, file)}:${i + 1} — ${line.trim()}`);
        }
      }
    }

    expect(offenders, [
      "Git's GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n protocol carries the same",
      "protected-configuration weight as `-c`, so it can re-grant safe.directory",
      "the same way. simple-git refuses to spawn when it sees GIT_CONFIG_COUNT and",
      "RepoGit.sanitizeGitEnv strips it, but neither reaches a raw spawn that sets",
      "it on purpose — which is what this catches.",
    ].join("\n")).toEqual([]);
  });

  it("the safe.directory rule reads the key, not the whole line", () => {
    // Pins the predicate itself: an assignment must be caught.
    expect(CONFIG_ENV_SET.test('GIT_CONFIG_COUNT: "1",')).toBe(true);
    expect(CONFIG_ENV_SET.test("env.GIT_CONFIG_KEY_0 = key;")).toBe(true);

    // Safe because of the SHAPE, not because of the file it happens to be in:
    // a bare name in a list is a value being enumerated, and `sanitizeGitEnv`
    // enumerates these in order to STRIP them — the opposite of setting one.
    // Nothing here reaches a git process's environment.
    expect(CONFIG_ENV_SET.test('  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",')).toBe(false);

    // BOTH protocols, not just the one simple-git happens to guard. Measured on
    // git 2.39.5: GIT_CONFIG_PARAMETERS="'safe.directory=*'" re-grants exactly
    // like `-c`, and simple-git's vulnerabilityCheck returns nothing for it.
    // The first version of this rule missed it — and this very assertion, in its
    // original form, pinned the gap open by only naming COUNT.
    expect(CONFIG_ENV_SET.test('GIT_CONFIG_PARAMETERS: "\'safe.directory=*\'",')).toBe(true);
    expect(CONFIG_ENV_SET.test("env.GIT_CONFIG_PARAMETERS = injected;")).toBe(true);

    expect(PASSES_SAFE_DIRECTORY.test('["-c", "safe.directory=*", "status"]')).toBe(true);
    expect(PASSES_SAFE_DIRECTORY.test('["config", "--global", "safe.directory", "*"]')).toBe(true);

    // The grant/removal split inside the policy owner (planning#410). The first
    // line is the shape that was legal before the switch was deleted and must
    // not become legal again; the second is the only shape left.
    expect(isTheRemoval('["config", "--global", "safe.directory", "*"]')).toBe(false);
    expect(isTheRemoval('["config", "--global", "--replace-all", "safe.directory", "*"]')).toBe(false);
    expect(isTheRemoval('["config", "--global", "--unset-all", "safe.directory"]')).toBe(true);

    // Safe because of the SHAPE: text after `//` is a comment, and a comment
    // cannot pass an argument to a git process — true of every comment, not a
    // carve-out for the `// GHA safe.directory` annotation in `github-ci-fix.ts`
    // that made a bare-name match fail. The key only reaches git quoted or
    // `=`-joined, which is what the two assertions above cover.
    expect(PASSES_SAFE_DIRECTORY.test("/^Adding repository/,  // GHA safe.directory")).toBe(false);
  });
});
