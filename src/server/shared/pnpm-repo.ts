import fs from "node:fs";
import path from "node:path";

import { resolveShipitConfig } from "./shipit-config.js";

/**
 * Which package manager a checkout uses, decided from the checkout alone. It lives in `shared/`
 * because both sides need the same answer from the same inputs: the orchestrator routes a pnpm
 * session to the verified base namespace (docs/276-shared-package-cache-integrity section 5) and
 * the worker requires the content hash in its install marker for the same repos.
 *
 * It reads the MUTABLE checkout, so it is a routing hint and never a trust boundary.
 */
export const PNPM_LOCKFILE = "pnpm-lock.yaml";
export const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

function readManifest(workspaceDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readPackageManagerField(workspaceDir: string): string | null {
  const pkg = asRecord(readManifest(workspaceDir));
  const field = pkg?.packageManager;
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function pnpmSignalFromInstall(install: string[]): boolean | null {
  let sawNonPnpm = false;
  for (const cmd of install) {
    if (/(?:^|[\s;&|(])pnpm(?:[\s;&|)]|$)/.test(cmd)) return true;
    if (/(?:^|[\s;&|(])(?:npm|yarn|bun)(?:[\s;&|)]|$)/.test(cmd)) sawNonPnpm = true;
  }
  return sawNonPnpm ? false : null;
}

export function isPnpmRepo(workspaceDir: string): boolean {
  const pm = readPackageManagerField(workspaceDir);
  if (pm !== null) return pm.startsWith("pnpm");
  let install: string[];
  try {
    install = resolveShipitConfig(workspaceDir).agent.install;
  } catch {
    install = [];
  }
  const installSignal = pnpmSignalFromInstall(install);
  if (installSignal !== null) return installSignal;
  return fs.existsSync(path.join(workspaceDir, PNPM_LOCKFILE));
}

/**
 * Whether the checkout has a pnpm lockfile right now — committed or written by the session's own
 * pnpm. A pnpm session without one gets no verified base lowerdir: pnpm would otherwise
 * synthesize the wanted graph from the base's carried `.pnpm/lock.yaml`, adopting the
 * orchestrator's version selection instead of resolving the session's own (measured, FINDINGS.md).
 */
export function hasPnpmLockfile(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, PNPM_LOCKFILE));
}

/**
 * pnpm resolves its store as `<storeDir>/v<N>` and records that resolved path in
 * `node_modules/.modules.yaml`. A consumer whose `N` differs from the one the base was built with
 * does not fail — it **recreates the whole `node_modules`** and re-downloads, which over an overlay
 * means whiteouting the entire base and installing privately on top, the opposite of reqs 7 and 10.
 *
 * Measured 2026-09-21 against the pinned builder (pnpm 12.4.1, store `v11`), one scriptless
 * dependency, empty consumer store at the recorded path: pnpm **10.28.2** (store `v10`) printed
 * "Recreating node_modules" and downloaded; pnpm **11.22.0** and **12.5.1** (store `v11`) hit the
 * base with no recreate and no download. pnpm 12 also accepts a pnpm-10 `lockfileVersion: '9.0'`
 * under `--frozen-lockfile`, so such a repo IS otherwise eligible — which is why this gate exists.
 */
export const MIN_VERIFIED_BASE_PNPM_MAJOR = 11;

export interface DeclaredPnpm {
  major: number;
  /** How the manifest says it, for the outcome that reports the refusal. */
  declaration: string;
}

/**
 * The pnpm corepack will select for a manifest, which is **two** fields, not one. Measured
 * 2026-09-21 on corepack 0.34.6: with no top-level `packageManager`, a
 * `devEngines.packageManager` of `{name: "pnpm", version: "10.28.2"}` selects pnpm 10.28.2 — so
 * reading `packageManager` alone misses a repo the gate exists for. Two more measured shapes need
 * no handling: the two fields disagreeing makes corepack refuse to run any pnpm at all, and a
 * `devEngines` semver RANGE is refused as "expected a semver version", so only an exact version
 * ever selects anything.
 */
export function declaredPnpmFromManifest(manifest: unknown): DeclaredPnpm | null {
  const pkg = asRecord(manifest);
  if (!pkg) return null;
  const pinned = typeof pkg.packageManager === "string" ? pkg.packageManager.trim() : "";
  const fromField = /^pnpm@(\d+)\./.exec(pinned);
  if (fromField) return { major: Number(fromField[1]), declaration: pinned };
  if (pinned) return null;

  const dev = asRecord(asRecord(pkg.devEngines)?.packageManager);
  if (dev?.name !== "pnpm" || typeof dev.version !== "string") return null;
  const fromDev = /^(\d+)\./.exec(dev.version.trim());
  return fromDev
    ? { major: Number(fromDev[1]), declaration: `devEngines.packageManager pnpm@${dev.version.trim()}` }
    : null;
}

/**
 * Whether a checkout's pnpm can consume a base the pinned builder produced.
 *
 * A checkout declaring nothing takes the image's corepack default, whose major is the builder's.
 * That is the only inference made here: an `agent.install` command naming a version explicitly
 * (`npx pnpm@10 install`) is a command string, not a declaration, and is not parsed — such a
 * session recreates the base tree, at rc=0, which is its own doing.
 */
export function usesVerifiedBaseCompatiblePnpm(workspaceDir: string): boolean {
  const declared = declaredPnpmFromManifest(readManifest(workspaceDir));
  return declared === null || declared.major >= MIN_VERIFIED_BASE_PNPM_MAJOR;
}
