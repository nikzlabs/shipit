/**
 * docs/162 — read-only ShipIt source surface for Ops remediation sessions.
 *
 * An Ops session can read the ShipIt source tree that corresponds to the
 * running host so the agent can connect production logs to code paths and
 * identify candidate fixes. This service owns:
 *
 *  - Resolving the running source *ref* (the deployed commit when known, the
 *    on-disk checkout HEAD otherwise) and whether that ref is exact.
 *  - Read-only access to that snapshot: `status`, `tree`, `search`, `cat`.
 *  - Redaction so credentials, `.env` files, and `.git` internals are never
 *    served through the CLI surface.
 *
 * Everything reads through `git` plumbing against a concrete ref (never the
 * working tree), so a tree/search/cat result always reflects the exact
 * snapshot reported by `status` — not whatever happens to be checked out or
 * dirty on disk. There are no write operations here by design (see the
 * "Rejected" list in docs/162): no edit, commit, push, checkout, or raw git.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError } from "./types.js";
import { resolveBuildId } from "../build-id.js";

const execFileAsync = promisify(execFile);

/** Timeout for the git plumbing calls this service makes (10s). */
const GIT_TIMEOUT_MS = 10_000;

/** Default host checkout, bind-mounted into the orchestrator (see deployment/vps). */
const DEFAULT_SOURCE_DIR = "/opt/shipit";

/** Hard caps so a single source read can't flood the agent's context. */
const MAX_TREE_ENTRIES = 1000;
const MAX_SEARCH_MATCHES = 200;
const MAX_CAT_BYTES = 1_000_000; // 1 MB

/**
 * Where the running ShipIt source ref came from.
 *  - `build-id`: the commit the running process was *built* from
 *    (`SHIPIT_BUILD_ID`), and that commit exists in the source checkout. This
 *    is the exact deployed commit.
 *  - `checkout-head`: a best-effort fallback to the source checkout's current
 *    HEAD. The running process may have been built from a different commit
 *    (e.g. the host repo was pulled after boot), so this ref is *approximate*.
 */
export type SourceRefSource = "build-id" | "checkout-head";

export interface ShipitSourceStatus {
  /** True when a usable source snapshot is available. */
  available: boolean;
  /** Resolved commit SHA the reads run against. Undefined when unavailable. */
  ref?: string;
  /** First 12 chars of `ref`, for display. */
  shortRef?: string;
  /** True only for an exact deployed commit (`build-id`). */
  exact: boolean;
  /** Where `ref` came from. Undefined when unavailable. */
  refSource?: SourceRefSource;
  /** The source repo's `origin` remote URL, when resolvable. */
  remoteUrl?: string;
  /** Human-readable reason when `available` is false. */
  reason?: string;
}

export interface ShipitSourceDeps {
  /** Process env. Defaults to `process.env`. Injected for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Run a git command in `dir` and return stdout. Injected so tests can stub
   * the source tree without a real checkout. Defaults to a real `execFile`.
   */
  runGit?: (dir: string, args: string[]) => Promise<string>;
}

async function defaultRunGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function sourceDir(env: NodeJS.ProcessEnv): string {
  const override = env.SHIPIT_SOURCE_DIR?.trim();
  return override || DEFAULT_SOURCE_DIR;
}

/**
 * Paths that must never be served through the source surface — credentials,
 * env files, key material, and `.git` internals. Matched against the
 * forward-slash path relative to the repo root. Deliberately narrow: it
 * targets secret *artifacts*, not source files that merely mention
 * "credential" in their name (e.g. `credential-store.ts` is fine to read).
 */
const REDACTED_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.[^/]*)?$/,
  /(^|\/)\.(netrc|npmrc|pgpass)$/,
];

/** True when `path` (repo-relative, forward slashes) must be redacted. */
export function isRedactedSourcePath(path: string): boolean {
  return REDACTED_PATTERNS.some((re) => re.test(path));
}

/**
 * Normalize an agent-supplied path: trim, strip leading `./` and `/`, collapse
 * `..` rejection. Returns the cleaned repo-relative path. Throws 400 on a path
 * that tries to escape the repo root.
 */
function normalizeRepoPath(raw: string): string {
  const p = (raw ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  if (p.split("/").some((seg) => seg === "..")) {
    throw new ServiceError(400, "Path may not contain '..'");
  }
  return p;
}

/**
 * Resolve the running source ref + remote. Never throws — returns
 * `{ available: false, reason }` when no usable snapshot exists so `status`
 * can report it and `tree`/`search`/`cat` can fail with the same reason.
 */
export async function getShipitSourceStatus(
  deps: ShipitSourceDeps = {},
): Promise<ShipitSourceStatus> {
  const env = deps.env ?? process.env;
  const runGit = deps.runGit ?? defaultRunGit;
  const dir = sourceDir(env);

  // Confirm the directory is a git work tree before anything else.
  try {
    await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      available: false,
      exact: false,
      reason: `ShipIt source is unavailable: no git checkout at ${dir}. Set SHIPIT_SOURCE_DIR if the host checkout lives elsewhere.`,
    };
  }

  // Prefer the exact build commit. resolveBuildId reads SHIPIT_BUILD_ID (set at
  // image build time from `git rev-parse HEAD`); we only trust it as "exact"
  // when that commit actually exists in the source checkout.
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

/** Resolve the snapshot, throwing a 503 ServiceError when unavailable. */
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

/** List the entries directly under `path` (repo root when empty) at the snapshot ref. */
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

/** Search file contents at the snapshot ref via `git grep`. Redacted paths are filtered out. */
export async function searchShipitSource(
  query: string,
  rawPath: string | undefined,
  deps: ShipitSourceDeps = {},
): Promise<SourceSearchResult> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) throw new ServiceError(400, "Search query is required.");
  const { dir, ref, runGit } = await requireSnapshot(deps);
  const path = rawPath ? normalizeRepoPath(rawPath) : "";

  // -n line numbers, -I skip binary, -e <pattern> so a pattern starting with
  // '-' isn't parsed as a flag. Search the tree at `ref`, not the work tree.
  const args = ["grep", "-n", "-I", "-e", trimmed, ref];
  if (path) args.push("--", path);

  let stdout = "";
  try {
    stdout = await runGit(dir, args);
  } catch (err) {
    // `git grep` exits 1 with no matches — surface that as an empty result,
    // not an error. Any other failure is a real error.
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

/** Read a single file at the snapshot ref. Rejects redacted paths and oversized files. */
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

// ---------------------------------------------------------------------------
// Write path: spawning a repo-backed ShipIt fix session (docs/162)
// ---------------------------------------------------------------------------

export interface ShipitFixTarget {
  /** Exact commit the fix child must branch from (the inspected source ref). */
  ref: string;
  /** True only when `ref` is the exact deployed build commit. */
  exact: boolean;
  /** ShipIt source repository URL the child will be claimed against. */
  repoUrl: string;
  refSource?: SourceRefSource;
}

/**
 * Validate that a ShipIt fix session can be spawned against the running
 * source, and resolve the exact ref + repo URL it must target. Throws a 400
 * ServiceError (with an actionable message) when the source is unavailable,
 * only approximately known without explicit opt-in, or has no resolvable
 * remote. Does NOT check GitHub write permission — that's the caller's job
 * (it needs the auth manager) and happens after this.
 */
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
  };
  getSharedRepoDir: (url: string) => string;
  /** Pre-bound `ensureBareCache(cacheDir, url, createRepoGit)`. */
  ensureBareCache: (cacheDir: string, url: string) => Promise<unknown>;
}

/**
 * Make `url` claimable: register it in the repo store and ensure its bare
 * cache exists, then flip it to `ready`. Idempotent — a no-op when the repo is
 * already ready. The Ops fix spawn needs this because the ShipIt source repo
 * is generally not a repo the user added through the home screen.
 */
export async function ensureShipitSourceRepoReady(
  url: string,
  deps: EnsureRepoReadyDeps,
): Promise<void> {
  if (deps.repoStore.get(url)?.status === "ready") return;
  deps.repoStore.add(url);
  await deps.ensureBareCache(deps.getSharedRepoDir(url), url);
  deps.repoStore.setReady(url);
}

/**
 * Build the incident-packet prompt seeded into the fix child. The agent's
 * diagnosis (`diagnosis`) is wrapped in a structured header that records the
 * exact source ref, whether it was exact, and the linkage back to the Ops
 * parent — so the child knows precisely what commit it started from and that a
 * human can trace it. Constraints are stated explicitly to keep the child
 * scoped to the fix.
 */
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
    "## Constraints",
    "- Make the smallest change that fixes the root cause; preserve existing behavior elsewhere.",
    "- Add or update tests, then run `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck`.",
    "- Open a PR when done (ShipIt does this automatically at end of turn if you edited files).",
    "- Do not touch unrelated subsystems or secrets/credentials.",
  ].join("\n");
}
