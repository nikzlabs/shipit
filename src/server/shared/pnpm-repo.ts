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

function readPackageManagerField(workspaceDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf-8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.trim()) {
      return pkg.packageManager.trim();
    }
  } catch {
    /* No package-manager signal. */
  }
  return null;
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
