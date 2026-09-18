// The pinned Node applies to child processes. The worker and baked shims keep
// the image's Node to match their native addons.

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
import type {
  ComposeNodeConflict,
  NodeRuntimeState,
  NodeRuntimeStatus,
} from "../shared/types/node-runtime-types.js";
import { parse as parseYaml } from "yaml";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "../shared/utils.js";

// Baked Playwright tooling requires Node 20 or later.
export const MIN_ACTIVATABLE_MAJOR = 20;

const PROVISION_TIMEOUT_MS = 180_000;
const METADATA_TIMEOUT_MS = 20_000;

const DIST_BASE_URL = "https://nodejs.org/dist";

export type { ComposeNodeConflict, NodeRuntimeState, NodeRuntimeStatus };

export interface ProvisionOptions {
  workspaceDir: string;
  stateDir?: string;
  cacheDir: string;
  deps?: Partial<ProvisionDeps>;
}

export interface ProvisionDeps {
  listRemoteVersions: () => Promise<NodeVersion[]>;
  install: (version: NodeVersion, cacheDir: string) => Promise<string>;
  currentVersion: () => string;
}

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

export function installDirName(version: NodeVersion, arch: string): string {
  return `node-v${formatVersion(version)}-linux-${arch}`;
}

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
    // Ignore incomplete extractions left by a crash.
    if (!fs.existsSync(path.join(cacheDir, entry, "bin", "node"))) continue;
    out.push(version);
  }
  return out;
}

export function resolveNodeCacheDir(
  depCacheDir: string,
  stateDir: string,
  isMount: (dir: string) => boolean = isMountPoint,
): string {
  // The entrypoint creates /dep-cache even without a mount; existence is insufficient.
  if (isMount(depCacheDir)) return path.join(depCacheDir, "node-versions");
  return path.join(stateDir, "node-versions");
}

export function isMountPoint(dir: string): boolean {
  try {
    return fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return false;
  }
}

interface DistIndexEntry {
  version?: unknown;
  files?: unknown;
}

async function fetchRemoteVersions(arch: string): Promise<NodeVersion[]> {
  const body = await fetchJson(`${DIST_BASE_URL}/index.json`);
  if (!Array.isArray(body)) throw new Error("dist index was not an array");
  const wanted = `linux-${arch}`;
  const out: NodeVersion[] = [];
  for (const raw of body as DistIndexEntry[]) {
    if (typeof raw?.version !== "string") continue;
    const version = parseVersion(raw.version);
    if (!version) continue;
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

// Verify before extraction, then rename atomically into the cache shared by sessions.
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

// Compose images are diagnostic only; they do not select the session's Node version.
export function findComposeNodeConflicts(workspaceDir: string, activeMajor: number): ComposeNodeConflict[] {
  let composeFile: string;
  try {
    composeFile = resolveShipitConfig(workspaceDir).compose?.file ?? "docker-compose.yml";
  } catch {
    composeFile = "docker-compose.yml";
  }

  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(path.join(workspaceDir, composeFile), "utf-8"));
  } catch {
    return [];
  }

  const services = (doc as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null) return [];

  const conflicts: ComposeNodeConflict[] = [];
  for (const [service, raw] of Object.entries(services as Record<string, unknown>)) {
    const image = (raw as { image?: unknown } | null)?.image;
    if (typeof image !== "string") continue;
    const match = /(?:^|\/)node:(\d+)(?:[.-]|$)/.exec(image.trim());
    if (!match) continue;
    const major = Number(match[1]);
    if (major === activeMajor) continue;
    conflicts.push({ service, image: image.trim(), major });
  }
  return conflicts;
}

const DEFAULT_DEPS: ProvisionDeps = {
  listRemoteVersions: async () => {
    const arch = distArch();
    if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
    return fetchRemoteVersions(arch);
  },
  install: installVersion,
  currentVersion: () => process.version,
};

export async function provisionNodeRuntime(opts: ProvisionOptions): Promise<NodeRuntimeStatus> {
  const status = await resolveAndActivate(opts);
  const activeMajor = parseVersion(status.activeVersion)?.major;
  return {
    ...status,
    composeNodeConflicts:
      activeMajor === undefined ? [] : findComposeNodeConflicts(opts.workspaceDir, activeMajor),
  };
}

async function resolveAndActivate(opts: ProvisionOptions): Promise<NodeRuntimeStatus> {
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
    composeNodeConflicts: [],
  };

  // Clear the previous container's handoff even when the new pin cannot be activated.
  writePathHandoff(opts.stateDir, null);

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
        reason: `Node ${formatVersion(target)} is below the minimum this container can run (${MIN_ACTIVATABLE_MAJOR}) — the baked Node tooling on PATH (Playwright) requires ${MIN_ACTIVATABLE_MAJOR}+. Running on ${imageVersion} instead.`,
        mismatch: true,
      };
    }

    const installDir = await deps.install(target, opts.cacheDir);
    activateNodeDir(path.join(installDir, "bin"), target, opts.stateDir);

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

// /etc/profile resets PATH. The baked 10-shipit-node.sh reads this file to restore the pin.
export const PATH_HANDOFF_FILE = "node-bin";

function writePathHandoff(stateDir: string | undefined, binDir: string | null): void {
  if (!stateDir) return;
  const file = path.join(stateDir, PATH_HANDOFF_FILE);
  try {
    if (binDir === null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, binDir, "utf-8");
  } catch (err) {
    console.warn(`[node-runtime] could not publish the login-shell PATH handoff: ${getErrorMessage(err)}`);
  }
}

// SHIPIT_PINNED_NODE keys cached native addons by the active ABI.
function activateNodeDir(binDir: string, version: NodeVersion, stateDir?: string): void {
  const existing = process.env.PATH ?? "";
  const segments = existing.split(path.delimiter).filter((s) => s !== binDir);
  process.env.PATH = [binDir, ...segments].join(path.delimiter);
  process.env.SHIPIT_PINNED_NODE = formatVersion(version);
  writePathHandoff(stateDir, binDir);
}

export function formatNodeRuntimeNotice(status: NodeRuntimeStatus): string | null {
  if (!status.mismatch) return null;

  const lines = [
    "<system>",
    "ShipIt could not run this session on the Node version the repository asks for.",
    "",
    `  running:  Node ${status.activeVersion}`,
  ];
  if (status.pinRaw && status.pinSource) {
    lines.push(`  repo pin: ${status.pinRaw} (${status.pinSource})`);
  }
  if (status.resolvedVersion && status.resolvedVersion !== status.activeVersion) {
    lines.push(`  wanted:   Node ${status.resolvedVersion}`);
  }
  if (status.reason) lines.push(`  reason:   ${status.reason}`);
  lines.push(
    "",
    "Take this into account before trusting anything version-sensitive: native",
    "addons you build here target the wrong ABI, tooling behaviour may differ from",
    "CI, and a failure you do or don't reproduce may not reflect the project's real",
    "target runtime. Say so if it turns out to matter for the task; don't silently",
    "work around it.",
    "</system>",
  );
  return lines.join("\n");
}

// Slash commands must remain first for CLI parsing. The transcript keeps the original text.
export function prefixPromptWithNotice(prompt: string, notice: string): string {
  const isSlashInvocation = /^\/[a-zA-Z0-9._-]+/.test(prompt.trimStart());
  return isSlashInvocation ? `${prompt}\n\n${notice}` : `${notice}\n\n${prompt}`;
}

let inFlight: Promise<NodeRuntimeStatus> | null = null;
let current: NodeRuntimeStatus | null = null;

// Start before listen(), but do not await here: downloads must not delay worker readiness.
export function startNodeRuntimeProvisioning(opts: ProvisionOptions): void {
  if (inFlight) return;
  inFlight = (async (): Promise<NodeRuntimeStatus> => {
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
        composeNodeConflicts: [],
      };
    }
    current = status;
    return status;
  })();
}

// Install, terminal and agent spawn paths must await provisioning before spawning.
export async function whenNodeRuntimeReady(): Promise<NodeRuntimeStatus> {
  if (current) return current;
  if (!inFlight) return unstartedStatus();
  return inFlight;
}

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
    composeNodeConflicts: [],
  };
}

export function resetNodeRuntimeForTests(): void {
  inFlight = null;
  current = null;
  delete process.env.SHIPIT_PINNED_NODE;
}
