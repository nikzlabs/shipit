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
const GIT_SPAWN = /\b(?:spawn|execFile|execFileSync|execFileAsync)\s*\(\s*\n?\s*"git"\s*,/g;

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
  if (arg.startsWith("{")) return arg;
  if (!IDENTIFIER.test(arg)) return null;
  const decl = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*\\{`).exec(fileSrc);
  if (!decl) return null;
  return balancedSpan(fileSrc, fileSrc.indexOf("{", decl.index));
}

interface GitSpawnSite {
  file: string;
  line: number;
  /** Whole call text, as written. */
  source: string;
  /** The same, collapsed and clipped for the failure message. */
  text: string;
  /** The argv argument (`gitArgsWithHooksDisabled([…])` or a variable). */
  argv: string;
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
 * Two carriers, because a `cwd`-only reading would miss the second:
 * a `cwd` option, and a `-C <dir>` argument (`services/shipit-source.ts`).
 * An options argument the scanner could not read counts too — an unreadable
 * shape is treated as carrying one, never as proof it does not.
 */
function namesAWorkingDirectory(site: GitSpawnSite): boolean {
  if (site.options === null) return true;
  if (site.argv.includes('"-C"')) return true;
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
      ({ file: "x.ts", line: 1, source: "", text: "", argv, options });

    expect(namesAWorkingDirectory(site('["status"]', "{ encoding: \"utf8\" }"))).toBe(false);
    expect(namesAWorkingDirectory(site('["status"]', undefined))).toBe(false);
    expect(namesAWorkingDirectory(site('["status"]', "{ cwd: dir }"))).toBe(true);
    expect(namesAWorkingDirectory(site('["-C", dir, "status"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', null))).toBe(true);
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
 * docs/266 E2 — nobody may hand git a `safe.directory` except the one place that
 * owns the policy.
 *
 * This is the rule the correction earned. `safe.directory` is honoured from
 * git's **protected configuration** scope, which is system + global + **command
 * line** — measured against git 2.39.5 with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`,
 * correcting a claim this repo carried in four places that `-c` was never
 * honoured. A repo-local `safe.directory` is genuinely NOT honoured, which is
 * the half the boundary rests on: the untrusted side owns `.git/config` and
 * still cannot grant itself trust.
 *
 * So this is not a hole — a `-c` and the `GIT_CONFIG_*` env protocol come from
 * ShipIt's own argv and environment, never from the repository. It is a
 * maintenance rule: the fail-closed refusal E2 arms can be silenced by ShipIt's
 * OWN code, one `-c safe.directory=*` at a time, by someone fixing a "git
 * suddenly refuses this path" bug the fastest way rather than the right way.
 * That is a lint, not a sentence in a doc.
 *
 * The env half is covered elsewhere and only partly: simple-git's
 * `blockUnsafeOperationsPlugin` refuses to spawn when it sees
 * `GIT_CONFIG_COUNT`, and `RepoGit.sanitizeGitEnv` strips it. Neither reaches a
 * raw `spawn` that sets it deliberately, so this scans for that shape too.
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
  const CONFIG_ENV_SET = /\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)"?\s*[:=][^=]/;

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
      "`safe.directory` is honoured from git's protected configuration scope —",
      "system, global AND the command line (measured, git 2.39.5). So a `-c",
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
    // Pins the predicate itself: an argv form must be caught, and the strip
    // list in `sanitizeGitEnv` must not be.
    expect(CONFIG_ENV_SET.test('GIT_CONFIG_COUNT: "1",')).toBe(true);
    expect(CONFIG_ENV_SET.test("env.GIT_CONFIG_KEY_0 = key;")).toBe(true);
    expect(CONFIG_ENV_SET.test('  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",')).toBe(false);

    // The argv form is caught; a prose mention of the key is not. Both matter:
    // the first is the hazard, and the second is what made a bare name match
    // fail on a CI-log noise pattern annotated `// GHA safe.directory`.
    expect(PASSES_SAFE_DIRECTORY.test('["-c", "safe.directory=*", "status"]')).toBe(true);
    expect(PASSES_SAFE_DIRECTORY.test('["config", "--global", "safe.directory", "*"]')).toBe(true);
    expect(PASSES_SAFE_DIRECTORY.test("/^Adding repository/,  // GHA safe.directory")).toBe(false);
  });
});
