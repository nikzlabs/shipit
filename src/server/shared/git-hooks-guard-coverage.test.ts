/**
 * planning#384 — the guards have to hold for git spawns nobody has written yet.
 *
 * `git-hooks-guard.test.ts` and `git-tree-uid.test.ts` prove the two mechanisms
 * work. This proves they are *applied everywhere*, by scanning the
 * orchestrator's own source for processes named `git` and failing when one
 * omits either of them:
 *
 *   1. **Hooks** — every raw git spawn goes through `gitArgsWithHooksDisabled`.
 *   2. **Uid** (docs/266 E2) — every raw git spawn that names a working
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
 * running as root inside a session workspace. Once docs/266 E2 removes
 * `safe.directory=*` such a site does not merely run as root: git refuses it
 * outright, on paths as load-bearing as session provisioning. Catching it at CI
 * is the whole point.
 *
 * The simple-git half of the same problem is covered by ESLint
 * (`no-restricted-imports` on the `simple-git` default export), which is why
 * this only looks at raw process spawns.
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
 * A `git` process being started: `spawn("git", …)`, `execFile("git", …)`,
 * `execFileSync("git", …)`, `execFileAsync("git", …)`, and the same with the
 * argument list on the following line.
 */
const GIT_SPAWN = /\b(?:spawn|execFile|execFileSync|execFileAsync)\s*\(\s*\n?\s*["'`]git["'`]\s*,/g;

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
  const decl = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*\\{`).exec(fileSrc);
  if (!decl) return null;
  return resolveSpreads(balancedSpan(fileSrc, fileSrc.indexOf("{", decl.index)), fileSrc);
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
 * `...gitSpawnOverridesForTree(dir)` is a call, not an identifier, and is the
 * thing being demanded — it never makes a literal unreadable.
 */
function resolveSpreads(literal: string, fileSrc: string): string | null {
  let out = literal;
  for (const [, name] of literal.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) {
    const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\{`).exec(fileSrc);
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
  const decl = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*([^;\\n]*)`).exec(fileSrc);
  return decl ? decl[1] : null;
}

interface GitSpawnSite {
  file: string;
  line: number;
  /** Whole call text, as written. */
  source: string;
  /** The same, collapsed and clipped for the failure message. */
  text: string;
  /** The argv argument as written — what the hooks rule reads. */
  argv: string;
  /** The same, resolved through an in-file `const`; `null` when unreadable. */
  resolvedArgv: string | null;
  /** Options source text, `null` when unreadable, `undefined` when absent. */
  options: string | null | undefined;
}

function gitSpawnSites(): GitSpawnSite[] {
  const sites: GitSpawnSite[] = [];
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const src = stripComments(fs.readFileSync(file, "utf-8"));
    for (const match of src.matchAll(GIT_SPAWN)) {
      const span = balancedSpan(src, src.indexOf("(", match.index));
      const args = callArguments(span);
      sites.push({
        file: path.relative(REPO_SRC, file),
        line: src.slice(0, match.index).split("\n").length,
        source: span,
        text: span.replace(/\s+/g, " ").slice(0, 140),
        argv: args[1] ?? "",
        resolvedArgv: resolveArgv(args[1], src),
        options: resolveOptions(args[2], src),
      });
    }
  }
  return sites;
}

/**
 * Does this spawn name a working directory — i.e. can it be pointed at a tree
 * ShipIt does not own?
 *
 * Two carriers, because a `cwd`-only reading would miss the second: a `cwd`
 * option, and a `-C <dir>` argument (`services/shipit-source.ts`). Both are read
 * through one level of in-file `const` indirection, including an object literal's
 * own spreads, since either can travel in a variable.
 *
 * Anything the scanner could not read counts as carrying one. That direction is
 * the whole point: an unreadable shape is never treated as proof there is no
 * working directory.
 */
function namesAWorkingDirectory(site: GitSpawnSite): boolean {
  if (site.options === null || site.resolvedArgv === null) return true;
  if (/["'`]-C["'`]/.test(site.resolvedArgv)) return true;
  return site.options !== undefined && /\bcwd\b/.test(site.options);
}

describe("git spawn coverage: hooks guard", () => {
  it("every orchestrator-side `git` process spawn goes through gitArgsWithHooksDisabled", () => {
    const sites = gitSpawnSites();
    const unguarded = sites
      .filter((s) => !s.argv.includes("gitArgsWithHooksDisabled"))
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

describe("git spawn coverage: tree-uid drop (docs/266 E2)", () => {
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
      "socket and the credential store (docs/266 req 1).",
      "Spread the overrides into the options: { cwd, ...gitSpawnOverridesForTree(cwd) }.",
      "It resolves to {} for a root-owned tree, so it is correct to add unconditionally.",
    ].join("\n")).toEqual([]);
  });

  it("recognizes both working-directory carriers and an unreadable options argument", () => {
    // The scanner's own predicate, exercised directly: a rule that silently
    // stopped seeing `-C` or an opaque options variable would leave the suite
    // green while covering less, which is the failure this pins.
    const site = (argv: string, options: string | null | undefined): GitSpawnSite =>
      ({ file: "x.ts", line: 1, source: "", text: "", argv, resolvedArgv: argv, options });

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

    // An argv the scanner could not resolve is treated as carrying one.
    expect(namesAWorkingDirectory(
      { file: "x.ts", line: 1, source: "", text: "", argv: "args", resolvedArgv: null, options: undefined },
    )).toBe(true);
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
 * docs/266 E2 / planning#410 — a bare `safeSimpleGit()` has no tree to stat, so
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
describe("git spawn coverage: bare safeSimpleGit() is a census (docs/266 E2)", () => {
  /** `safeSimpleGit()` — no `baseDir`, therefore no ownership predicate. */
  const BARE_SIMPLE_GIT = /\bsafeSimpleGit\s*\(\s*\)/g;

  /**
   * Every bare site that exists on purpose, with what owns the tree its git
   * touches. Keyed by file and COUNT, not by line, so ordinary edits above a
   * site don't churn the list while a new site still fails.
   */
  const ALLOWED: Record<string, { count: number; why: string }> = {
    "server/orchestrator/repo-git.ts": {
      count: 1,
      why: "cloneFromCache: source is the root-owned shared bare cache. The destination is "
        + "handed to the session uid (handWorkspaceBackToWorker) before the next git call.",
    },
    "server/orchestrator/plugin-generations.ts": {
      count: 1,
      why: "checkoutCommit: source is the root-owned plugin bare cache. Same handback before "
        + "the dropped git that follows (planning#410).",
    },
    "server/orchestrator/services/marketplace.ts": {
      count: 1,
      why: "clone from a URL into a fresh cache dir — no local source tree to own, and the "
        + "cache is ShipIt's own rather than a session's.",
    },
  };

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
      "drops to that path's session uid and meets a tree it does not own: EACCES today,",
      "`fatal: detected dubious ownership` once SHIPIT_GIT_STRICT_OWNERSHIP is armed.",
      "Both known instances of this bug had exactly that shape (repo-git.ts's",
      "cloneFromCache, plugin-generations.ts's checkoutCommit) and neither was visible",
      "at runtime: the drop is inert unless the process is root, so tests pass either way.",
      "",
      "If you added one: hand the destination over (handWorkspaceBackToWorker — the",
      "object-aware one, because `clone --local` hardlinks the source's objects) before",
      "the next git call, then add the site here with what owns the tree.",
    ].join("\n")).toEqual(expected);
  });

  it("the bare-site pattern reads the argument list, not the name", () => {
    // Safe because of the SHAPE: a call WITH a directory carries the predicate —
    // `resolveGitTreeUid(baseDir)` decides the uid — so it is not this rule's
    // subject at all. True of any argument, not of the ones written today.
    expect(BARE_SIMPLE_GIT.test("safeSimpleGit(workspaceDir)")).toBe(false);
    BARE_SIMPLE_GIT.lastIndex = 0;
    expect(BARE_SIMPLE_GIT.test("safeSimpleGit(dir, opts)")).toBe(false);
    BARE_SIMPLE_GIT.lastIndex = 0;
    expect(BARE_SIMPLE_GIT.test("await safeSimpleGit().raw([...])")).toBe(true);
    BARE_SIMPLE_GIT.lastIndex = 0;
    expect(BARE_SIMPLE_GIT.test("const git = safeSimpleGit( );")).toBe(true);
    BARE_SIMPLE_GIT.lastIndex = 0;
  });
});

/**
 * docs/266 E2 — nobody may hand git a `safe.directory` except the one place that
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
describe("git spawn coverage: nobody re-grants safe.directory (docs/266 E2)", () => {
  /** The one module that owns the policy — {@link applySafeDirectoryPolicy}. */
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

  it("only git-config.ts names safe.directory, and nothing passes it on a command line", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of ROOTS.flatMap(sourceFiles)) {
      const rel = path.relative(REPO_SRC, file);
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      scanned++;
      if (rel.endsWith(POLICY_OWNER)) {
        // Even here, only the `git config --global` form is allowed: the point
        // of the policy living in the global config is that it is the scope the
        // untrusted side cannot reach, and a `-c` would defeat its own purpose.
        for (const line of src.split("\n")) {
          if (PASSES_SAFE_DIRECTORY.test(line) && !line.includes('"config", "--global"')) {
            offenders.push(`${rel} — safe.directory outside the \`config --global\` write: ${line.trim()}`);
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
      "`detected dubious ownership` refusal docs/266 E2 exists to arm (req 7).",
      "The refusal is the signal that a git call site failed to drop to the tree's",
      "owner. Fix the call site with gitSpawnOverridesForTree — never the refusal.",
      `Only ${POLICY_OWNER}'s \`git config --global\` write may name the key.`,
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

    // Safe because of the SHAPE: text after `//` is a comment, and a comment
    // cannot pass an argument to a git process — true of every comment, not a
    // carve-out for the `// GHA safe.directory` annotation in `github-ci-fix.ts`
    // that made a bare-name match fail. The key only reaches git quoted or
    // `=`-joined, which is what the two assertions above cover.
    expect(PASSES_SAFE_DIRECTORY.test("/^Adding repository/,  // GHA safe.directory")).toBe(false);
  });
});
