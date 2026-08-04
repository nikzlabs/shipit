/**
 * Node runtime provisioning (docs/248, nikzlabs/shipit#1728) — the worker-side
 * half of honoring a repo's Node version pin.
 *
 * The session-worker image bakes one Node major (`node:24-slim`). A repo that
 * pins another one via `.nvmrc` or `engines.node` used to get the baked major
 * silently: `node -v` disagreed with the project, native addons compiled
 * against the wrong ABI, and the Node that installed `node_modules` disagreed
 * with the Node a Compose preview service pinned for the same workspace.
 *
 * What this module does, once per worker boot:
 *   1. Read the pin (`shared/node-pin.ts` — pure, unit-tested there).
 *   2. If the running Node already satisfies it, do nothing. This is the common
 *      case for range pins like `>=20`, and it keeps the feature invisible.
 *   3. Otherwise resolve a concrete version — from versions already extracted in
 *      the shared cache first (so a warm host never touches the network), then
 *      from `nodejs.org/dist/index.json`.
 *   4. Download + SHA256-verify + extract it into the shared dependency cache,
 *      then prepend its `bin/` to the worker's own `process.env.PATH`.
 *
 * Step 4's PATH mutation is the whole mechanism. The terminal, the agent CLI,
 * and `agent.install` are all spawned by this worker and inherit its
 * environment, so one assignment covers every place requirement 4 cares about.
 * Deliberately NOT covered: the worker process itself (already running, and its
 * `/app/node_modules` native addons are compiled for the image's ABI) and the
 * `gh`/`shipit`/`shipit-git-credential` shims, which the Dockerfile pins to the
 * image's `node` for exactly that reason.
 *
 * Every failure path is non-fatal and *reported*: the session keeps running on
 * the image's Node and the mismatch surfaces in session diagnostics
 * (requirement 6). Provisioning must never be able to fail a session start,
 * which is also why it does not block the worker's `listen()` — the three
 * places that must not run before it lands (`install`, terminal spawn, agent
 * spawn) await {@link whenNodeRuntimeReady} individually.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  formatVersion,
  parseVersion,
  pickBest,
  readNodePin,
  satisfies,
  type NodeVersion,
} from "../shared/node-pin.js";
import type { NodeRuntimeState, NodeRuntimeStatus } from "../shared/types/node-runtime-types.js";
import { getErrorMessage } from "../shared/utils.js";

/**
 * Majors below this are resolved and *reported* but never activated.
 *
 * The pinned Node leads PATH for every process the worker spawns, and that
 * includes the `claude` and `codex` CLIs, whose shebangs resolve `node` the
 * same way. Both require Node 20+. Honoring a Node 14 pin would therefore
 * trade a wrong-ABI warning for a session with no working agent — a strictly
 * worse outcome, so the pin falls back to the reporting path (requirement 6).
 */
export const MIN_ACTIVATABLE_MAJOR = 20;

/** Total budget for resolve + download + extract. */
const PROVISION_TIMEOUT_MS = 180_000;
/** Budget for the small metadata fetches (dist index, SHASUMS). */
const METADATA_TIMEOUT_MS = 20_000;

const DIST_BASE_URL = "https://nodejs.org/dist";

export type { NodeRuntimeState, NodeRuntimeStatus };

export interface ProvisionOptions {
  workspaceDir: string;
  /**
   * Where extracted toolchains live. `/dep-cache/node-versions` in a real
   * session (shared across every session of the repo on that host, and swept
   * with the rest of that repo's dep cache); a temp dir in tests.
   */
  cacheDir: string;
  /** Injected in tests. Defaults to the module-level HTTP/tar implementations. */
  deps?: Partial<ProvisionDeps>;
}

export interface ProvisionDeps {
  /** All Node versions published for this platform, newest-first order irrelevant. */
  listRemoteVersions: () => Promise<NodeVersion[]>;
  /** Download + verify + extract `version` into `destDir`. */
  install: (version: NodeVersion, cacheDir: string) => Promise<string>;
  /** The Node currently executing (`process.version`). */
  currentVersion: () => string;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** Node's dist naming for this container's architecture, or null if unsupported. */
export function distArch(arch: string = process.arch): string | null {
  switch (arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "arm":
      return "armv7l";
    case "ppc64":
      return "ppc64le";
    case "s390x":
      return "s390x";
    default:
      return null;
  }
}

function tarballName(version: NodeVersion, arch: string): string {
  return `node-v${formatVersion(version)}-linux-${arch}.tar.gz`;
}

/** Directory name an extracted toolchain lands in — the tarball's own root dir. */
export function installDirName(version: NodeVersion, arch: string): string {
  return `node-v${formatVersion(version)}-linux-${arch}`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Versions already extracted under `cacheDir`. Checked before any network call
 * so a host that has seen the pin before provisions offline, and so a
 * network-off sandbox still gets the right Node once the cache is warm.
 */
export function listCachedVersions(cacheDir: string, arch: string): NodeVersion[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }
  const suffix = `-linux-${arch}`;
  const out: NodeVersion[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("node-v") || !entry.endsWith(suffix)) continue;
    const version = parseVersion(entry.slice("node-".length));
    if (!version) continue;
    // A directory without `bin/node` is a half-extracted casualty of a crash;
    // ignore it rather than PATH-prepending something that can't execute.
    if (!fs.existsSync(path.join(cacheDir, entry, "bin", "node"))) continue;
    out.push(version);
  }
  return out;
}

/**
 * Where provisioned toolchains live.
 *
 * `/dep-cache` (docs/075) is the right home: it is already the per-repo,
 * host-shared, writable cache mount, so the second session on a host reuses the
 * first one's download, and the existing steady-state reclaim of unreferenced
 * repo dep caches sweeps these with it — no new disk surface that grows on its
 * own clock. Falls back to the session state dir when the mount is absent
 * (local mode, tests), where it is merely per-session rather than broken.
 */
export function resolveNodeCacheDir(depCacheDir: string, stateDir: string): string {
  try {
    if (fs.statSync(depCacheDir).isDirectory()) return path.join(depCacheDir, "node-versions");
  } catch {
    // Not mounted.
  }
  return path.join(stateDir, "node-versions");
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

interface DistIndexEntry {
  version?: unknown;
  files?: unknown;
}

/**
 * Every Node release with a linux tarball for this architecture.
 * `nodejs.org` is already on the default egress allowlist (`egress-allowlist.ts`).
 */
async function fetchRemoteVersions(arch: string): Promise<NodeVersion[]> {
  const body = await fetchJson(`${DIST_BASE_URL}/index.json`);
  if (!Array.isArray(body)) throw new Error("dist index was not an array");
  const wanted = `linux-${arch}`;
  const out: NodeVersion[] = [];
  for (const raw of body as DistIndexEntry[]) {
    if (typeof raw?.version !== "string") continue;
    const version = parseVersion(raw.version);
    if (!version) continue;
    // Old releases predate some architectures; skip anything with no tarball.
    if (Array.isArray(raw.files) && !raw.files.includes(wanted)) continue;
    out.push(version);
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** The published SHA256 for one tarball, from the release's SHASUMS256.txt. */
async function fetchExpectedSha(version: NodeVersion, fileName: string): Promise<string> {
  const url = `${DIST_BASE_URL}/v${formatVersion(version)}/SHASUMS256.txt`;
  const res = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const text = await res.text();
  for (const line of text.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === fileName && sha) return sha;
  }
  throw new Error(`no SHA256 entry for ${fileName}`);
}

/**
 * Download, verify, and extract one Node release into `cacheDir`.
 *
 * The tarball is hashed while it streams to disk and compared against the
 * release's published `SHASUMS256.txt` before anything is extracted — this
 * fetches an executable toolchain over the network, so an unverified download
 * would be a code-execution path. Extraction goes to a unique temp dir and is
 * moved into place with a single rename: `/dep-cache` is shared across every
 * session of the repo on the host, so two containers can provision the same
 * version concurrently, and the loser of that race finds the directory already
 * present rather than a half-written one.
 */
async function installVersion(version: NodeVersion, cacheDir: string): Promise<string> {
  const arch = distArch();
  if (!arch) throw new Error(`unsupported architecture ${process.arch}`);

  const dirName = installDirName(version, arch);
  const finalDir = path.join(cacheDir, dirName);
  if (fs.existsSync(path.join(finalDir, "bin", "node"))) return finalDir;

  await fsp.mkdir(cacheDir, { recursive: true });
  const fileName = tarballName(version, arch);
  const scratch = await fsp.mkdtemp(path.join(cacheDir, ".provision-"));
  const tarPath = path.join(scratch, fileName);

  try {
    const expectedSha = await fetchExpectedSha(version, fileName);
    const actualSha = await downloadToFile(`${DIST_BASE_URL}/v${formatVersion(version)}/${fileName}`, tarPath);
    if (actualSha !== expectedSha) {
      throw new Error(`checksum mismatch for ${fileName} (expected ${expectedSha}, got ${actualSha})`);
    }

    const extractDir = path.join(scratch, "x");
    await fsp.mkdir(extractDir, { recursive: true });
    await runTar(tarPath, extractDir);

    const extracted = path.join(extractDir, dirName);
    if (!fs.existsSync(path.join(extracted, "bin", "node"))) {
      throw new Error(`extracted tree has no bin/node at ${dirName}`);
    }
    try {
      await fsp.rename(extracted, finalDir);
    } catch (err) {
      // Another container won the race — its tree is as good as ours.
      if (!fs.existsSync(path.join(finalDir, "bin", "node"))) throw err;
    }
    return finalDir;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Stream a URL to disk, returning the hex SHA256 of what was written. */
async function downloadToFile(url: string, destPath: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  const hash = crypto.createHash("sha256");
  const handle = await fsp.open(destPath, "w");
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function runTar(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-xzf", tarPath, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const DEFAULT_DEPS: ProvisionDeps = {
  listRemoteVersions: async () => {
    const arch = distArch();
    if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
    return fetchRemoteVersions(arch);
  },
  install: installVersion,
  currentVersion: () => process.version,
};

/**
 * Resolve the repo's pin and, when it isn't already satisfied, install the
 * matching Node and put it first on PATH.
 *
 * Returns a status for every outcome instead of throwing: the caller reports
 * it, and a session whose pin can't be honored is a session with a diagnostic,
 * not a session that failed to start.
 */
export async function provisionNodeRuntime(opts: ProvisionOptions): Promise<NodeRuntimeStatus> {
  const deps: ProvisionDeps = { ...DEFAULT_DEPS, ...opts.deps };
  const imageVersionRaw = deps.currentVersion();
  const imageVersion = imageVersionRaw.replace(/^v/, "");
  const base: NodeRuntimeStatus = {
    state: "no-pin",
    pinSource: null,
    pinRaw: null,
    resolvedVersion: null,
    activeVersion: imageVersion,
    imageVersion,
    reason: null,
    mismatch: false,
  };

  const pin = readNodePin(opts.workspaceDir);
  if (!pin) return base;

  const withPin = { ...base, pinSource: pin.source, pinRaw: pin.raw };

  if (!pin.spec) {
    return {
      ...withPin,
      state: "unsupported",
      reason: `\`${pin.raw}\` in ${pin.source} is not a version or range this resolver understands (aliases like \`lts/*\` and \`node\` are not supported).`,
      mismatch: true,
    };
  }

  const current = parseVersion(imageVersionRaw);
  if (current && satisfies(current, pin.spec)) {
    return { ...withPin, state: "satisfied", resolvedVersion: imageVersion };
  }

  const arch = distArch();
  if (!arch) {
    return {
      ...withPin,
      state: "failed",
      reason: `no Node distribution for architecture ${process.arch}`,
      mismatch: true,
    };
  }

  try {
    // Cache first: a host that has already provisioned this pin needs no
    // network at all, which is also what makes a network-off sandbox work on
    // its second session.
    let target = pickBest(listCachedVersions(opts.cacheDir, arch), pin.spec);
    target ??= pickBest(await deps.listRemoteVersions(), pin.spec);

    if (!target) {
      return {
        ...withPin,
        state: "failed",
        reason: `no released Node version satisfies \`${pin.raw}\``,
        mismatch: true,
      };
    }

    if (target.major < MIN_ACTIVATABLE_MAJOR) {
      return {
        ...withPin,
        state: "below-floor",
        resolvedVersion: formatVersion(target),
        reason: `Node ${formatVersion(target)} is below the minimum this container can run (${MIN_ACTIVATABLE_MAJOR}) — the agent CLIs resolve \`node\` through the same PATH and require ${MIN_ACTIVATABLE_MAJOR}+. Running on ${imageVersion} instead.`,
        mismatch: true,
      };
    }

    const installDir = await deps.install(target, opts.cacheDir);
    activateNodeDir(path.join(installDir, "bin"), target);

    return {
      ...withPin,
      state: "provisioned",
      resolvedVersion: formatVersion(target),
      activeVersion: formatVersion(target),
    };
  } catch (err) {
    return {
      ...withPin,
      state: "failed",
      reason: `could not provision Node for \`${pin.raw}\`: ${getErrorMessage(err)}`,
      mismatch: true,
    };
  }
}

/**
 * Put a provisioned toolchain first on PATH for everything this worker spawns.
 *
 * `SHIPIT_PINNED_NODE` is read back by `install-runtime.ts:runtimeKey()`, which
 * scopes the overlay dep store and the install marker. Without it, a tree of
 * native addons compiled under a pinned Node would be reused after the pin
 * changed — the exact ABI mismatch this feature exists to prevent. It is set
 * ONLY when a pin is active, so unpinned repos keep their existing key and
 * don't all take one cold reinstall on deploy.
 */
function activateNodeDir(binDir: string, version: NodeVersion): void {
  const existing = process.env.PATH ?? "";
  const segments = existing.split(path.delimiter).filter((s) => s !== binDir);
  process.env.PATH = [binDir, ...segments].join(path.delimiter);
  process.env.SHIPIT_PINNED_NODE = formatVersion(version);
}

// ---------------------------------------------------------------------------
// Worker-lifetime singleton
// ---------------------------------------------------------------------------

let inFlight: Promise<NodeRuntimeStatus> | null = null;
let current: NodeRuntimeStatus | null = null;

/**
 * Kick off provisioning for this worker. Called once at boot, before
 * `listen()`, but deliberately not awaited there: a slow or unreachable
 * `nodejs.org` must not eat into the orchestrator's 30s worker-readiness
 * budget and fail container creation.
 */
export function startNodeRuntimeProvisioning(opts: ProvisionOptions): void {
  if (inFlight) return;
  inFlight = (async (): Promise<NodeRuntimeStatus> => {
    // `provisionNodeRuntime` folds every expected failure into a reported
    // status; this catch is the backstop for the unexpected, so that a throw
    // can never leave the three await points hanging forever.
    let status: NodeRuntimeStatus;
    try {
      status = await provisionNodeRuntime(opts);
    } catch (err: unknown) {
      const v = process.version.replace(/^v/, "");
      status = {
        state: "failed",
        pinSource: null,
        pinRaw: null,
        resolvedVersion: null,
        activeVersion: v,
        imageVersion: v,
        reason: getErrorMessage(err),
        mismatch: true,
      };
    }
    current = status;
    return status;
  })();
}

/**
 * Await the boot-time provisioning. The three spawn paths that must not run on
 * the wrong Node — `agent.install`, the terminal shell, and the agent CLI —
 * call this first. Resolves immediately once provisioning has landed, and
 * resolves to a `no-pin` status when provisioning was never started (local mode
 * and in-process tests).
 */
export async function whenNodeRuntimeReady(): Promise<NodeRuntimeStatus> {
  if (current) return current;
  if (!inFlight) return unstartedStatus();
  return inFlight;
}

/**
 * The last resolved status — read by the `/node-runtime` endpoint the
 * orchestrator polls for diagnostics. Never awaits: a provisioning download can
 * take minutes, and a diagnostics panel that hangs on it would be worse than
 * one that says "pending".
 */
export function getNodeRuntimeStatus(): NodeRuntimeStatus {
  if (current) return current;
  return inFlight ? { ...unstartedStatus(), state: "pending" } : unstartedStatus();
}

function unstartedStatus(): NodeRuntimeStatus {
  const v = process.version.replace(/^v/, "");
  return {
    state: "no-pin",
    pinSource: null,
    pinRaw: null,
    resolvedVersion: null,
    activeVersion: v,
    imageVersion: v,
    reason: null,
    mismatch: false,
  };
}

/** Test-only: drop the singleton so each test starts from a clean worker. */
export function resetNodeRuntimeForTests(): void {
  inFlight = null;
  current = null;
  delete process.env.SHIPIT_PINNED_NODE;
}
