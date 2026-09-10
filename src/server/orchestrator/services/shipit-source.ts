import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError } from "./types.js";
import { resolveBuildId } from "../build-id.js";
import { stripUrlCredentials, canonicalRepoKey } from "../git-utils.js";
import { gitArgsWithHooksDisabled } from "../../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../../shared/git-tree-uid.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;

const DEFAULT_SOURCE_DIR = "/opt/shipit";

const MAX_TREE_ENTRIES = 1000;
const MAX_SEARCH_MATCHES = 200;
const MAX_CAT_BYTES = 1_000_000;
const MAX_LOG_COMMITS = 100;
const DEFAULT_LOG_COMMITS = 20;
const MAX_BLAME_LINES = 5000;
const MAX_SHOW_BYTES = 1_000_000;

export type SourceRefSource = "build-id" | "checkout-head";

export interface ShipitSourceStatus {
  available: boolean;
  ref?: string;
  shortRef?: string;
  exact: boolean;
  refSource?: SourceRefSource;
  remoteUrl?: string;
  reason?: string;
}

export interface ShipitSourceDeps {
  env?: NodeJS.ProcessEnv;
  runGit?: (dir: string, args: string[]) => Promise<string>;
}

async function defaultRunGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", gitArgsWithHooksDisabled(["-C", dir, ...args]), {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    ...gitSpawnOverridesForTree(dir),
  });
  return stdout;
}

function sourceDir(env: NodeJS.ProcessEnv): string {
  const override = env.SHIPIT_SOURCE_DIR?.trim();
  return override || DEFAULT_SOURCE_DIR;
}

const REDACTED_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.[^/]*)?$/,
  /(^|\/)\.(netrc|npmrc|pgpass)$/,
];

export function isRedactedSourcePath(path: string): boolean {
  return REDACTED_PATTERNS.some((re) => re.test(path));
}

function normalizeRepoPath(raw: string): string {
  const p = (raw ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  if (p.split("/").some((seg) => seg === "..")) {
    throw new ServiceError(400, "Path may not contain '..'");
  }
  return p;
}

export async function getShipitSourceStatus(
  deps: ShipitSourceDeps = {},
): Promise<ShipitSourceStatus> {
  const env = deps.env ?? process.env;
  const runGit = deps.runGit ?? defaultRunGit;
  const dir = sourceDir(env);

  try {
    await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      available: false,
      exact: false,
      reason: `ShipIt source is unavailable: no git checkout at ${dir}. Set SHIPIT_SOURCE_DIR if the host checkout lives elsewhere.`,
    };
  }

  // Checkout HEAD may have moved since deployment; prefer an available build commit.
  let ref: string | undefined;
  let refSource: SourceRefSource | undefined;
  let exact = false;

  const buildId = resolveBuildId(env);
  if (buildId) {
    try {
      await runGit(dir, ["cat-file", "-e", `${buildId}^{commit}`]);
      ref = buildId;
      refSource = "build-id";
      exact = true;
    } catch {
      // Build commit not present in this checkout — fall back to HEAD.
    }
  }

  if (!ref) {
    try {
      ref = (await runGit(dir, ["rev-parse", "HEAD"])).trim();
      refSource = "checkout-head";
      exact = false;
    } catch {
      return {
        available: false,
        exact: false,
        reason: `ShipIt source is unavailable: could not resolve HEAD in ${dir}.`,
      };
    }
  }

  let remoteUrl: string | undefined;
  const remoteOverride = env.SHIPIT_SOURCE_REPO_URL?.trim();
  if (remoteOverride) {
    remoteUrl = remoteOverride;
  } else {
    try {
      remoteUrl = (await runGit(dir, ["remote", "get-url", "origin"])).trim() || undefined;
    } catch {
      remoteUrl = undefined;
    }
  }
  if (remoteUrl) remoteUrl = stripUrlCredentials(remoteUrl);

  const status: ShipitSourceStatus = {
    available: true,
    ref,
    shortRef: ref?.slice(0, 12),
    exact,
    ...(refSource ? { refSource } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
  return status;
}

async function requireSnapshot(deps: ShipitSourceDeps): Promise<{
  dir: string;
  ref: string;
  runGit: (dir: string, args: string[]) => Promise<string>;
}> {
  const status = await getShipitSourceStatus(deps);
  if (!status.available || !status.ref) {
    throw new ServiceError(503, status.reason ?? "ShipIt source is unavailable.");
  }
  const env = deps.env ?? process.env;
  return { dir: sourceDir(env), ref: status.ref, runGit: deps.runGit ?? defaultRunGit };
}

export interface SourceTreeEntry {
  name: string;
  type: "file" | "dir";
}

export interface SourceTreeResult {
  ref: string;
  path: string;
  entries: SourceTreeEntry[];
  truncated: boolean;
}

export async function listShipitSourceTree(
  rawPath: string,
  deps: ShipitSourceDeps = {},
): Promise<SourceTreeResult> {
  const { dir, ref, runGit } = await requireSnapshot(deps);
  const path = normalizeRepoPath(rawPath);
  const args = ["ls-tree", "--full-tree", ref];
  if (path) args.push(`${path}/`);

  let stdout: string;
  try {
    stdout = await runGit(dir, args);
  } catch (err) {
    throw new ServiceError(400, `Could not list '${path || "."}': ${(err as Error).message}`);
  }

  const entries: SourceTreeEntry[] = [];
  let truncated = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // Format: "<mode> <type> <hash>\t<full/path>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const gitType = meta[1];
    const fullPath = line.slice(tab + 1);
    if (isRedactedSourcePath(fullPath)) continue;
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    const name = fullPath.split("/").pop() ?? fullPath;
    entries.push({ name, type: gitType === "tree" ? "dir" : "file" });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ref, path, entries, truncated };
}

export interface SourceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SourceSearchResult {
  ref: string;
  query: string;
  matches: SourceSearchMatch[];
  truncated: boolean;
}

export async function searchShipitSource(
  query: string,
  rawPath: string | undefined,
  deps: ShipitSourceDeps = {},
): Promise<SourceSearchResult> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) throw new ServiceError(400, "Search query is required.");
  const { dir, ref, runGit } = await requireSnapshot(deps);
  const path = rawPath ? normalizeRepoPath(rawPath) : "";

  // -e prevents a query starting with '-' from becoming a git option.
  const args = ["grep", "-n", "-I", "-e", trimmed, ref];
  if (path) args.push("--", path);

  let stdout: string;
  try {
    stdout = await runGit(dir, args);
  } catch (err) {
    // git grep exits 1 without stderr when there are no matches.
    const message = (err as { stderr?: string; message?: string }).stderr
      ?? (err as Error).message ?? "";
    const code = (err as { code?: number }).code;
    if (code === 1 && !message.trim()) {
      return { ref, query: trimmed, matches: [], truncated: false };
    }
    throw new ServiceError(400, `Search failed: ${message || "git grep error"}`);
  }

  const matches: SourceSearchMatch[] = [];
  let truncated = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // Format: "<ref>:<path>:<line>:<text>"
    const withoutRef = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
    const firstColon = withoutRef.indexOf(":");
    if (firstColon === -1) continue;
    const filePath = withoutRef.slice(0, firstColon);
    const rest = withoutRef.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (secondColon === -1) continue;
    const lineNo = Number(rest.slice(0, secondColon));
    const text = rest.slice(secondColon + 1);
    if (!Number.isFinite(lineNo)) continue;
    if (isRedactedSourcePath(filePath)) continue;
    if (matches.length >= MAX_SEARCH_MATCHES) {
      truncated = true;
      break;
    }
    matches.push({ path: filePath, line: lineNo, text: text.slice(0, 500) });
  }
  return { ref, query: trimmed, matches, truncated };
}

export interface SourceCatResult {
  ref: string;
  path: string;
  content: string;
  truncated: boolean;
}

export async function catShipitSource(
  rawPath: string,
  deps: ShipitSourceDeps = {},
): Promise<SourceCatResult> {
  const path = normalizeRepoPath(rawPath);
  if (!path) throw new ServiceError(400, "A file path is required.");
  if (isRedactedSourcePath(path)) {
    throw new ServiceError(403, `Reading '${path}' is not permitted (credentials, env, or git-internal path).`);
  }
  const { dir, ref, runGit } = await requireSnapshot(deps);

  let stdout: string;
  try {
    stdout = await runGit(dir, ["show", `${ref}:${path}`]);
  } catch (err) {
    const message = (err as { stderr?: string }).stderr ?? (err as Error).message;
    throw new ServiceError(404, `Could not read '${path}': ${message?.trim() || "not found at this ref"}`);
  }

  let truncated = false;
  let content = stdout;
  if (Buffer.byteLength(content, "utf8") > MAX_CAT_BYTES) {
    content = content.slice(0, MAX_CAT_BYTES);
    truncated = true;
  }
  return { ref, path, content, truncated };
}

function normalizeCommitish(raw: string): string {
  const c = (raw ?? "").trim();
  if (!c) throw new ServiceError(400, "A commit is required.");
  if (!/^[0-9a-zA-Z][0-9a-zA-Z._/~^@-]*$/.test(c)) {
    throw new ServiceError(400, `Invalid commit reference: ${c}`);
  }
  return c;
}

export interface SourceLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface SourceLogResult {
  ref: string;
  path: string;
  commits: SourceLogCommit[];
  truncated: boolean;
}

export async function logShipitSource(
  rawPath: string | undefined,
  opts: { limit?: number } = {},
  deps: ShipitSourceDeps = {},
): Promise<SourceLogResult> {
  const { dir, ref, runGit } = await requireSnapshot(deps);
  const path = rawPath ? normalizeRepoPath(rawPath) : "";
  if (path && isRedactedSourcePath(path)) {
    throw new ServiceError(403, `History for '${path}' is not available (credentials, env, or git-internal path).`);
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LOG_COMMITS)), MAX_LOG_COMMITS);

  // NUL separates fields; ASCII RS separates records.
  const fmt = "%H%x00%an%x00%aI%x00%s%x1e";
  const args = ["log", `--max-count=${limit + 1}`, `--format=${fmt}`, ref];
  if (path) args.push("--", path);

  let stdout: string;
  try {
    stdout = await runGit(dir, args);
  } catch (err) {
    throw new ServiceError(400, `Could not read history for '${path || "."}': ${(err as Error).message}`);
  }

  const commits: SourceLogCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    const rec = record.replace(/^\n/, "");
    if (!rec.trim()) continue;
    const [hash, author, date, subject] = rec.split("\x00");
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: hash.slice(0, 12),
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
    });
  }
  const truncated = commits.length > limit;
  return { ref, path, commits: commits.slice(0, limit), truncated };
}

export interface SourceBlameLine {
  line: number;
  shortHash: string;
  author: string;
  text: string;
}

export interface SourceBlameResult {
  ref: string;
  path: string;
  lines: SourceBlameLine[];
  truncated: boolean;
}

export async function blameShipitSource(
  rawPath: string,
  deps: ShipitSourceDeps = {},
): Promise<SourceBlameResult> {
  const path = normalizeRepoPath(rawPath);
  if (!path) throw new ServiceError(400, "A file path is required.");
  if (isRedactedSourcePath(path)) {
    throw new ServiceError(403, `Blaming '${path}' is not permitted (credentials, env, or git-internal path).`);
  }
  const { dir, ref, runGit } = await requireSnapshot(deps);

  let stdout: string;
  try {
    stdout = await runGit(dir, ["blame", "--line-porcelain", ref, "--", path]);
  } catch (err) {
    const message = (err as { stderr?: string }).stderr ?? (err as Error).message;
    throw new ServiceError(404, `Could not blame '${path}': ${message?.trim() || "not found at this ref"}`);
  }

  // Porcelain repeats metadata for each line; a TAB starts its content.
  const lines: SourceBlameLine[] = [];
  let truncated = false;
  let curHash = "";
  let curAuthor = "";
  let lineNo = 0;
  for (const raw of stdout.split("\n")) {
    if (/^[0-9a-f]{40}( |$)/.test(raw)) {
      const parts = raw.split(" ");
      curHash = parts[0];
      const finalLine = Number(parts[2]);
      if (Number.isFinite(finalLine)) lineNo = finalLine;
    } else if (raw.startsWith("author ")) {
      curAuthor = raw.slice("author ".length);
    } else if (raw.startsWith("\t")) {
      if (lines.length >= MAX_BLAME_LINES) {
        truncated = true;
        break;
      }
      lines.push({
        line: lineNo,
        shortHash: curHash.slice(0, 12),
        author: curAuthor,
        text: raw.slice(1).slice(0, 500),
      });
    }
  }
  return { ref, path, lines, truncated };
}

export interface SourceShowResult {
  ref: string;
  path: string;
  content: string;
  truncated: boolean;
}

export async function showShipitSource(
  rawCommit: string,
  rawPath: string | undefined,
  deps: ShipitSourceDeps = {},
): Promise<SourceShowResult> {
  const commit = normalizeCommitish(rawCommit);
  const path = rawPath ? normalizeRepoPath(rawPath) : "";
  if (path && isRedactedSourcePath(path)) {
    throw new ServiceError(403, `Showing '${path}' is not permitted (credentials, env, or git-internal path).`);
  }
  const { dir, runGit } = await requireSnapshot(deps);

  const args = ["show", "--no-color", commit];
  if (path) args.push("--", path);

  let stdout: string;
  try {
    stdout = await runGit(dir, args);
  } catch (err) {
    const message = (err as { stderr?: string }).stderr ?? (err as Error).message;
    throw new ServiceError(404, `Could not show '${commit}': ${message?.trim() || "unknown commit"}`);
  }

  let content = path ? stdout : filterRedactedDiff(stdout);
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > MAX_SHOW_BYTES) {
    content = content.slice(0, MAX_SHOW_BYTES);
    truncated = true;
  }
  return { ref: commit, path, content, truncated };
}

export function filterRedactedDiff(showOut: string): string {
  const firstDiff = showOut.indexOf("diff --git ");
  if (firstDiff === -1) return showOut;
  const header = showOut.slice(0, firstDiff);
  const body = showOut.slice(firstDiff);
  const chunks = body.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  let hidden = 0;
  for (const chunk of chunks) {
    // "diff --git a/<path> b/<path>" — use the b/ path (post-image).
    const m = /^diff --git a\/.+? b\/(.+?)\s*$/m.exec(chunk);
    const filePath = m ? m[1] : "";
    if (filePath && isRedactedSourcePath(filePath)) {
      hidden++;
      continue;
    }
    kept.push(chunk);
  }
  let out = header + kept.join("");
  if (hidden > 0) {
    if (!out.endsWith("\n")) out += "\n";
    out += `[${hidden} file diff(s) hidden: credentials/env/git-internal paths redacted]\n`;
  }
  return out;
}

export interface ShipitFixTarget {
  ref: string;
  exact: boolean;
  repoUrl: string;
  refSource?: SourceRefSource;
}

export async function resolveShipitFixTarget(
  approximate: boolean,
  deps: ShipitSourceDeps = {},
): Promise<ShipitFixTarget> {
  const status = await getShipitSourceStatus(deps);
  if (!status.available || !status.ref) {
    throw new ServiceError(400, status.reason ?? "ShipIt source is unavailable; cannot spawn a fix session.");
  }
  if (!status.exact && !approximate) {
    throw new ServiceError(
      400,
      "The inspected ShipIt source ref is approximate (the source checkout's HEAD, not the exact deployed build). " +
        "Confirm with `shipit source status`, then pass --approximate to spawn an explicitly-approximate fix session.",
    );
  }
  if (!status.remoteUrl) {
    throw new ServiceError(
      400,
      "Could not resolve the ShipIt source repository URL. Set SHIPIT_SOURCE_REPO_URL on the orchestrator.",
    );
  }
  return {
    ref: status.ref,
    exact: status.exact,
    repoUrl: status.remoteUrl,
    ...(status.refSource ? { refSource: status.refSource } : {}),
  };
}

export interface EnsureRepoReadyDeps {
  repoStore: {
    get(url: string): { status: string } | undefined;
    add(url: string): unknown;
    setReady(url: string): void;
    list(): { url: string }[];
  };
  getSharedRepoDir: (url: string) => string;
  ensureBareCache: (cacheDir: string, url: string) => Promise<unknown>;
}

export async function ensureShipitSourceRepoReady(
  url: string,
  deps: EnsureRepoReadyDeps,
): Promise<string> {
  const clean = stripUrlCredentials(url);
  const wanted = canonicalRepoKey(url);
  const existing = deps.repoStore.list().find((r) => canonicalRepoKey(r.url) === wanted);
  // Claims need the existing store key even when an equivalent URL has another spelling.
  const key = existing?.url ?? clean;
  if (deps.repoStore.get(key)?.status === "ready") return key;
  deps.repoStore.add(key);
  await deps.ensureBareCache(deps.getSharedRepoDir(key), key);
  deps.repoStore.setReady(key);
  return key;
}

export function buildShipitFixPrompt(opts: {
  ref: string;
  exact: boolean;
  parentSessionId: string;
  diagnosis: string;
}): string {
  const refLine = opts.exact
    ? `Source ref: ${opts.ref} (exact deployed commit)`
    : `Source ref: ${opts.ref} (APPROXIMATE — source checkout HEAD, not the exact deployed build)`;
  return [
    "# Ops remediation — ShipIt fix session",
    "",
    "You were spawned by a ShipIt Ops session to fix a production issue in ShipIt itself.",
    `Your workspace is branched from the exact commit the Ops agent inspected.`,
    "",
    "## Incident packet",
    refLine,
    `Spawned by Ops session: ${opts.parentSessionId}`,
    "",
    "## Diagnosis and requested fix",
    opts.diagnosis.trim(),
    "",
    "## Branch base — important",
    `Your branch starts at the inspected commit (${opts.ref.slice(0, 12)}), which is the code`,
    "running in production — NOT necessarily the repository's current default branch.",
    "Start here so you can reproduce the bug against the deployed code. Then, before you",
    "open the PR, bring your branch up to date with the default branch (`git fetch origin`",
    "then rebase onto `origin/<default-branch>`) and re-apply your fix so the PR is",
    "mergeable and reflects a fix against the latest code. Resolve any drift the rebase",
    "surfaces — if the root cause was already fixed upstream, say so instead of opening a PR.",
    "",
    "## Constraints",
    "- Make the smallest change that fixes the root cause; preserve existing behavior elsewhere.",
    "- Add or update tests, then run `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck`.",
    "- Open a PR when done (ShipIt does this automatically at end of turn if you edited files).",
    "- Do not touch unrelated subsystems or secrets/credentials.",
  ].join("\n");
}
