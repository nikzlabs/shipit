/**
 * Require hooks suppression and tree-owner identity for raw orchestrator git
 * calls. ESLint covers simple-git imports; session containers may run hooks.
 *
 * This source scanner follows one in-file const, not runtime values or imports.
 * Duplicate declarations and unreadable binaries require review. Inherited cwd
 * and launchers outside node:child_process are invisible to these checks.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.join(HERE, "..", "orchestrator"), HERE];
const REPO_SRC = path.join(HERE, "..", "..");

// `fork` starts a Node module, not an arbitrary binary.
const ARGV_LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
const SHELL_LAUNCHERS = new Set(["exec", "execSync"]);

interface Launcher {
  local: string;
  canonical: string;
}

// Resolve imported launchers to exclude unrelated RegExp and database `exec` calls.
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
  if (childProcessNamespaces(src).length > 0) {
    for (const canonical of [...ARGV_LAUNCHERS, ...SHELL_LAUNCHERS]) {
      if (!found.has(canonical)) found.set(canonical, canonical);
    }
  }
  return [...found].map(([local, canonical]) => ({ local, canonical }));
}

function childProcessNamespaces(src: string): string[] {
  const NAMESPACE = /import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s*from\s*["']node:child_process["']/g;
  return [...src.matchAll(NAMESPACE)].map((m) => m[1] ?? "").filter(Boolean);
}

// Preserve line numbers when blanking comments.
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
      if (entry.name === "integration_tests" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

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

function looksLikeCallback(arg: string): boolean {
  return arg.startsWith("(") || arg.startsWith("function") || arg.includes("=>");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function resolveOptions(arg: string | undefined, fileSrc: string): string | null | undefined {
  if (arg === undefined || looksLikeCallback(arg)) return undefined;
  if (arg.startsWith("{")) return resolveSpreads(arg, fileSrc);
  if (!IDENTIFIER.test(arg)) return null;
  const decl = soleDeclaration(arg, fileSrc, "\\{");
  if (!decl) return null;
  return resolveSpreads(balancedSpan(fileSrc, fileSrc.indexOf("{", decl.index)), fileSrc);
}

// This scanner has no scopes; duplicate declarations cannot be resolved safely.
function soleDeclaration(name: string, fileSrc: string, valuePattern: string): RegExpExecArray | null {
  const all = [...fileSrc.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=\\s*${valuePattern}`, "g"))];
  return all.length === 1 ? (all[0] as RegExpExecArray) : null;
}

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

// These helpers return identity/credential options, never a working directory.
// Other opaque spreads are unreadable because they could hide cwd.
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

function resolveArgv(arg: string | undefined, fileSrc: string): string | null {
  if (arg === undefined) return null;
  if (!IDENTIFIER.test(arg)) return arg;
  const decl = soleDeclaration(arg, fileSrc, "");
  return decl ? declarationValue(fileSrc, decl.index + decl[0].length) : null;
}

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

type Binary = { literal: string } | { unreadable: true };

// Interpolation may alter an argv binary; a shell prefix can settle its first word.
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

// git-lfs cannot accept the required git flags; `git lfs` is covered.
function isGitBinary(binary: string): boolean {
  return path.basename(binary.trim()) === "git";
}

// Splitting quotes catches nested shells, but also flags `echo "git is fine"`.
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
  source: string;
  /** Clipped display text; `source` remains complete. */
  text: string;
  launcher: string;
  takesArgv: boolean;
  binaryArg: string;
  binary: Binary;
  argv: string;
  resolvedArgv: string | null;
  /** Options source text, `null` when unreadable, `undefined` when absent. */
  options: string | null | undefined;
}

// Member exec calls require a child_process receiver; otherwise they may be RegExp/SQL.
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

function gitSpawnSites(): LauncherSite[] {
  return launcherSites().filter(
    (s) => s.takesArgv && "literal" in s.binary && isGitBinary(s.binary.literal),
  );
}

// A command can create a tree without setting cwd. Unreadable arguments also need the guard.
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
      .filter((s) => !(s.resolvedArgv ?? "").includes("gitArgsWithHooksDisabled"))
      .map((s) => `${s.file}:${s.line} — ${s.text}`);

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
      .filter((s) => !s.source.includes("gitSpawnOverridesForTree")
        && !(s.options ?? "").includes("gitSpawnOverridesForTree"))
      .map((s) => `${s.file}:${s.line} — ${s.text}`);

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
    const site = (argv: string, options: string | null | undefined): LauncherSite => ({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv, resolvedArgv: argv, options,
    });

    // Inherited process cwd is outside this scanner's scope, not proven safe.
    expect(namesAWorkingDirectory(site('["status"]', "{ encoding: \"utf8\" }"))).toBe(false);
    expect(namesAWorkingDirectory(site('["status"]', undefined))).toBe(false);

    expect(namesAWorkingDirectory(site('["status"]', "{ cwd: dir }"))).toBe(true);
    expect(namesAWorkingDirectory(site('["-C", dir, "status"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', null))).toBe(true);

    expect(namesAWorkingDirectory(site("['-C', dir, 'status']", undefined))).toBe(true);
    expect(namesAWorkingDirectory(site("[`-C`, dir]", undefined))).toBe(true);

    expect(namesAWorkingDirectory(site('["--git-dir", dir, "log"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["--work-tree=/srv/ws", "status"]', undefined))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', '{ env: { GIT_DIR: dir } }'))).toBe(true);
    expect(namesAWorkingDirectory(site('["status"]', '{ env: { GIT_WORK_TREE: ws } }'))).toBe(true);

    expect(namesAWorkingDirectory({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv: "args", resolvedArgv: null,
      options: undefined,
    })).toBe(true);
  });

  it("resolves a `-C` that travels in a variable", () => {
    const src = 'const args = gitArgsWithHooksDisabled(["-C", ws, "status"]);\nexecFileSync("git", args);';
    expect(resolveArgv("args", src)).toContain("-C");
    expect(resolveArgv("elsewhere", src)).toBeNull();
    expect(resolveArgv('["status"]', src)).toBe('["status"]');
  });

  it("follows an options literal's spreads, and fails closed on one it cannot read", () => {
    const declared = 'const shared = { cwd: dir, timeout: 5 };\nexecFile("git", a, { ...shared });';
    expect(resolveOptions("{ ...shared }", declared)).toContain("cwd");
    expect(resolveOptions("{ ...fromAnotherModule }", declared)).toBeNull();
    expect(resolveOptions("{ cwd, ...gitSpawnOverridesForTree(cwd) }", declared)).toContain("cwd");
  });

  it("reads a cwd through one level of in-file `const opts = {…}` indirection", () => {
    const src = 'const gitOpts = { cwd: HOST_REPO_DIR, timeout: 5 };\nexecFileSync("git", a, gitOpts);';
    expect(resolveOptions("gitOpts", src)).toContain("cwd");
    expect(resolveOptions("somethingElse", src)).toBeNull();
  });
});

// Without baseDir, safeSimpleGit cannot choose a tree owner. Inventory each exception.
describe("git spawn coverage: bare safeSimpleGit() is a census (docs/266-orchestrator-git-trust-boundary E2)", () => {
  // A variable that is undefined at runtime remains invisible to this literal scan.
  const BARE_SIMPLE_GIT = /\bsafeSimpleGit\s*\(\s*(?:undefined\s*|""\s*|''\s*|``\s*)?\)/g;

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

    // A directory argument supplies the tree used for uid resolution.
    expect(bare("safeSimpleGit(workspaceDir)")).toBe(false);
    expect(bare("safeSimpleGit(dir, opts)")).toBe(false);

    expect(bare("await safeSimpleGit().raw([...])")).toBe(true);
    expect(bare("const git = safeSimpleGit( );")).toBe(true);

    expect(bare("safeSimpleGit(undefined)")).toBe(true);
    expect(bare('safeSimpleGit("")')).toBe(true);
    expect(bare("safeSimpleGit('')")).toBe(true);

    expect(bare("safeSimpleGit(maybeDir)")).toBe(false);
  });
});

// This argv scan misses .clone() methods. The bare-call inventory covers cloneCatalog.
describe("git spawn coverage: every clone states both owners (planning#428)", () => {
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

describe("git spawn coverage: what counts as a git spawn (planning#409)", () => {
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

    // Keep duplicates: each new call needs its own inventory entry.
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

    expect(cp('import { spawnSync, execSync } from "node:child_process";'))
      .toEqual(["execSync:execSync", "spawnSync:spawnSync"]);

    expect(cp('import { execFile } from "node:child_process";\nconst execFileAsync = promisify(execFile);'))
      .toEqual(["execFile:execFile", "execFileAsync:execFile"]);

    expect(cp('import type { ChildProcess } from "node:child_process";')).toEqual([]);
    expect(cp('import { spawn } from "node:child_process";\nimport type { SpawnOptions } from "node:child_process";'))
      .toEqual(["spawn:spawn"]);

    expect(cp('import { promisify } from "node:util";')).toEqual([]);
    expect(cp('import { exec } from "./my-helpers.js";')).toEqual([]);

    expect(cp('import * as cp from "node:child_process";'))
      .toEqual(["exec:exec", "execFile:execFile", "execFileSync:execFileSync",
        "execSync:execSync", "spawn:spawn", "spawnSync:spawnSync"]);
    expect(childProcessNamespaces('import * as cp from "node:child_process";')).toEqual(["cp"]);
    expect(childProcessNamespaces('import { spawn } from "node:child_process";')).toEqual([]);
  });

  it("resolves a binary through a literal, a path, and one level of `const`", () => {
    const src = 'const GIT = "git";\nconst DOCKER = "docker";\nspawn(GIT, args);';
    expect(resolveBinary('"git"', src, true)).toEqual({ literal: "git" });
    expect(resolveBinary("GIT", src, true)).toEqual({ literal: "git" });
    expect(resolveBinary("DOCKER", src, true)).toEqual({ literal: "docker" });
    expect(resolveBinary("binary", src, true)).toEqual({ unreadable: true });
    expect(resolveBinary(undefined, src, true)).toEqual({ unreadable: true });

    expect(isGitBinary("git")).toBe(true);
    expect(isGitBinary("/usr/bin/git")).toBe(true);
    expect(isGitBinary("docker")).toBe(false);
    expect(isGitBinary("git-lfs")).toBe(false);
    expect(isGitBinary("/opt/gitless/bin/gitless")).toBe(false);
  });

  it("reads the binary out of a shell command string, past env assignments", () => {
    expect(shellCommandRunsGit("git status")).toBe(true);
    expect(shellCommandRunsGit("  /usr/bin/git fetch origin  ")).toBe(true);
    expect(shellCommandRunsGit("GIT_TERMINAL_PROMPT=0 git fetch")).toBe(true);

    expect(shellCommandRunsGit("docker ps")).toBe(false);
    expect(shellCommandRunsGit("npm run git")).toBe(false);

    expect(stringLiteralPrefix(`\`git clone \${url}\``)).toEqual({ text: "git clone ", complete: false });
    expect(stringLiteralPrefix(`\`\${bin} clone\``)).toEqual({ text: "", complete: false });
    expect(stringLiteralPrefix('"git status"')).toEqual({ text: "git status", complete: true });
    expect(stringLiteralPrefix("someVariable")).toBeNull();

    expect(resolveBinary(`\`\${GIT_BIN}\``, "", true)).toEqual({ unreadable: true });
    expect(resolveBinary(`\`/usr/bin/\${tool}\``, "", true)).toEqual({ unreadable: true });
    expect(resolveBinary(`\`git clone \${url}\``, "", false)).toEqual({ literal: "git clone " });
    expect(resolveBinary(`\`\${GIT_BIN} status\``, "", false)).toEqual({ unreadable: true });
  });

  it("splits a shell command into segments, so `cd X && git …` is not hidden by `cd`", () => {
    expect(shellCommandRunsGit("cd /srv/ws && git status")).toBe(true);
    expect(shellCommandRunsGit("mkdir -p x; git init x")).toBe(true);
    expect(shellCommandRunsGit('sh -c "git status"')).toBe(true);
    expect(shellCommandRunsGit("ls | git hash-object --stdin")).toBe(true);

    expect(shellCommandRunsGit("npm run git")).toBe(false);
    expect(shellCommandRunsGit("docker ps && docker rm x")).toBe(false);
  });

  it("treats a shadowed name as unreadable rather than resolving it to the first declaration", () => {
    const shadowed = 'const args = ["status"];\nfunction f() { const args = ["-C", ws, "status"]; }';
    expect(resolveArgv("args", shadowed)).toBeNull();
    expect(resolveArgv("args", 'const args = ["-C", ws];')).toContain("-C");

    const twoOpts = "const opts = { timeout: 5 };\nfunction f() { const opts = { cwd: dir }; }";
    expect(resolveOptions("opts", twoOpts)).toBeNull();
  });

  it("reads a `const` initializer that wraps across lines", () => {
    const wrapped = 'const args = gitArgsWithHooksDisabled([\n  "-C",\n  ws,\n  "status",\n]);';
    expect(resolveArgv("args", wrapped)).toContain("-C");
    expect(resolveArgv("args", wrapped)).toContain("gitArgsWithHooksDisabled");

    const wrappedBinary = 'const GIT =\n  "git";';
    expect(resolveBinary("GIT", wrappedBinary, true)).toEqual({ literal: "git" });
  });

  it("fails closed on a spread it cannot read, whatever shape the spread has", () => {
    const src = "const shared = { cwd: dir };";
    expect(resolveOptions("{ ...makeOpts(dir) }", src)).toBeNull();
    expect(resolveOptions("{ ...process.env }", src)).toBeNull();
    expect(resolveOptions("{ ...base.opts }", src)).toBeNull();
    expect(resolveOptions("{ ...shared }", src)).toContain("cwd");

    expect(resolveOptions("{ cwd, ...gitSpawnOverridesForTree(cwd) }", src)).toContain("cwd");
    expect(resolveOptions("{ ...gitCredentialSpawnOverrides(cred) }", src)).not.toBeNull();
  });

  it("counts a tree a git spawn CREATES, not only one it is given (planning#410)", () => {
    const site = (argv: string): LauncherSite => ({
      file: "x.ts", line: 1, source: "", text: "", launcher: "spawn", takesArgv: true,
      binaryArg: '"git"', binary: { literal: "git" }, argv, resolvedArgv: argv, options: undefined,
    });

    expect(namesAWorkingDirectory(site('["clone", "--local", src, dest]'))).toBe(true);
    expect(namesAWorkingDirectory(site('["init", dest]'))).toBe(true);
    expect(namesAWorkingDirectory(site('["worktree", "add", dest]'))).toBe(true);

    expect(namesAWorkingDirectory(site('["merge-base", "--is-ancestor", a, b]'))).toBe(false);
    expect(namesAWorkingDirectory(site('["rev-parse", "HEAD"]'))).toBe(false);
  });
});

// Both git config environment protocols can grant trust, as can command-line config.
describe("git spawn coverage: nobody re-grants safe.directory (docs/266-orchestrator-git-trust-boundary E2)", () => {
  // Boot must remove grants left in persistent config by older builds.
  const POLICY_OWNER = path.join("orchestrator", "git-config.ts");

  // Match assignments, not names in sanitizeGitEnv's removal list.
  const CONFIG_ENV_SET = /\bGIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)["'`]?\s*[:=][^=]/;

  const CONFIG_ENV_POLICY_OWNER = path.join("shared", "git-remote-credential.ts");

  // Only one http-prefixed key/value pair is allowed. PARAMETERS hides the key
  // inside an opaque string and is never exempt.
  const isBoundedExtraHeaderPair = (line: string): boolean => (
    /^\s*GIT_CONFIG_COUNT:\s*"1",?$/.test(line)
    || /^\s*GIT_CONFIG_KEY_\d+:\s*`http\./.test(line)
    || /^\s*GIT_CONFIG_VALUE_\d+:/.test(line)
  );

  // Runtime-assembled keys escape this literal scan.
  const PASSES_SAFE_DIRECTORY = /["'`]safe\.directory|safe\.directory\s*=/;

  // An indirect --unset-all is reported as a grant, requiring review.
  const isTheRemoval = (line: string): boolean => line.includes('"--unset-all"');

  it("nothing grants safe.directory, and only git-config.ts may even name it", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of ROOTS.flatMap(sourceFiles)) {
      const rel = path.relative(REPO_SRC, file);
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      scanned++;
      if (rel.endsWith(POLICY_OWNER)) {
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
      const rel = path.relative(REPO_SRC, file);
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      const exempt = rel.endsWith(CONFIG_ENV_POLICY_OWNER);
      for (const [i, line] of src.split("\n").entries()) {
        if (!CONFIG_ENV_SET.test(line)) continue;
        if (exempt && isBoundedExtraHeaderPair(line)) continue;
        offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
      }
    }

    expect(offenders, [
      "Git's GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n protocol carries the same",
      "protected-configuration weight as `-c`, so it can re-grant safe.directory",
      "the same way. simple-git refuses to spawn when it sees GIT_CONFIG_COUNT and",
      "RepoGit.sanitizeGitEnv strips it, but neither reaches a raw spawn that sets",
      "it on purpose — which is what this catches.",
      `Only ${CONFIG_ENV_POLICY_OWNER} may set the protocol, and only as the`,
      "docs/288-preemptive-github-auth `http.<origin>.extraHeader` pair, whose key",
      "has a literal `http.` prefix and so can never name safe.directory. Any",
      "other key, and GIT_CONFIG_PARAMETERS anywhere at all, is still a defect.",
    ].join("\n")).toEqual([]);
  });

  it("the safe.directory rule reads the key, not the whole line", () => {
    expect(CONFIG_ENV_SET.test('GIT_CONFIG_COUNT: "1",')).toBe(true);
    expect(CONFIG_ENV_SET.test("env.GIT_CONFIG_KEY_0 = key;")).toBe(true);

    expect(CONFIG_ENV_SET.test('  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",')).toBe(false);

    expect(CONFIG_ENV_SET.test('GIT_CONFIG_PARAMETERS: "\'safe.directory=*\'",')).toBe(true);
    expect(CONFIG_ENV_SET.test("env.GIT_CONFIG_PARAMETERS = injected;")).toBe(true);

    expect(isBoundedExtraHeaderPair('    GIT_CONFIG_COUNT: "1",')).toBe(true);
    // Build source fixtures without triggering no-template-curly-in-string.
    const D = "$";
    expect(isBoundedExtraHeaderPair(`    GIT_CONFIG_KEY_0: \`http.${D}{origin}.extraHeader\`,`)).toBe(true);
    expect(isBoundedExtraHeaderPair(`    GIT_CONFIG_VALUE_0: \`Authorization: Basic ${D}{basic}\`,`)).toBe(true);

    expect(isBoundedExtraHeaderPair('    GIT_CONFIG_KEY_0: "safe.directory",')).toBe(false);
    expect(isBoundedExtraHeaderPair(`    GIT_CONFIG_KEY_0: \`${D}{anything}\`,`)).toBe(false);
    expect(isBoundedExtraHeaderPair('    GIT_CONFIG_KEY_1: "credential.helper",')).toBe(false);
    expect(isBoundedExtraHeaderPair('    GIT_CONFIG_COUNT: "2",')).toBe(false);
    expect(isBoundedExtraHeaderPair("    GIT_CONFIG_COUNT: String(pairs.length),")).toBe(false);
    expect(isBoundedExtraHeaderPair('    GIT_CONFIG_PARAMETERS: "\'safe.directory=*\'",')).toBe(false);

    expect(PASSES_SAFE_DIRECTORY.test('["-c", "safe.directory=*", "status"]')).toBe(true);
    expect(PASSES_SAFE_DIRECTORY.test('["config", "--global", "safe.directory", "*"]')).toBe(true);

    expect(isTheRemoval('["config", "--global", "safe.directory", "*"]')).toBe(false);
    expect(isTheRemoval('["config", "--global", "--replace-all", "safe.directory", "*"]')).toBe(false);
    expect(isTheRemoval('["config", "--global", "--unset-all", "safe.directory"]')).toBe(true);

    expect(isTheRemoval('["config", "--global", UNSET_ALL, "safe.directory"]')).toBe(false);
    expect(PASSES_SAFE_DIRECTORY.test('["config", "--global", UNSET_ALL, KEY]')).toBe(false);

    expect(PASSES_SAFE_DIRECTORY.test("/^Adding repository/,  // GHA safe.directory")).toBe(false);
  });
});
