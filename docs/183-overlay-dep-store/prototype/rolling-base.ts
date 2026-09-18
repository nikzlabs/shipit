
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";


export interface RuntimeInputs {
  imageDigest: string;
  arch: string;
  libc: string;
  abiTags: string[];
}

export function runtimeFingerprint(r: RuntimeInputs): string {
  return [r.imageDigest, r.arch, r.libc, [...r.abiTags].sort().join(",")].join("|");
}

export interface Scope {
  repo: string;
  runtime: string;
}

export function scopeKey(s: Scope): string {
  return crypto
    .createHash("sha256")
    .update(s.repo)
    .update("\0")
    .update(s.runtime)
    .digest("hex")
    .slice(0, 16);
}


export interface InstallMarker {
  sourceCommit: string;
  runtime: string;
  installCommand: string;
}

export interface CheckoutState {
  sourceCommit: string;
  runtime: string;
  installCommand: string;
}

export function markerAllowsSkip(
  marker: InstallMarker | null,
  checkout: CheckoutState,
): boolean {
  if (!marker) return false;
  return (
    marker.sourceCommit === checkout.sourceCommit &&
    marker.runtime === checkout.runtime &&
    marker.installCommand === checkout.installCommand
  );
}


export interface BasePointer {
  scope: Scope;
  commit: string;
  depth: number;
  generation: number;
  baseDir: string;
}

export interface PublishCandidate {
  scope: Scope;
  commit: string;
  exitCode: number;
  preUserInstall: boolean;
  sourceIsDefaultBranch: boolean;
  mergedDir: string;
}

export type PublishOutcome =
  | "advanced"
  | "flattened"
  | "created"
  | "skipped-equal"
  | "skipped-not-forward"
  | "skipped-ineligible";

export interface PublishResult {
  outcome: PublishOutcome;
  pointer: BasePointer | null;
}

export const DEFAULT_DEPTH_CAP = 16;


export async function withScopeLock<T>(
  lockRoot: string,
  scope: Scope,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockDir = path.join(lockRoot, `${scopeKey(scope)}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`lock timeout for ${scopeKey(scope)}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}


export function isAncestor(gitDir: string, a: string, b: string): boolean {
  try {
    execFileSync("git", ["-C", gitDir, "merge-base", "--is-ancestor", a, b], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}


function pointerPath(stateRoot: string, scope: Scope): string {
  return path.join(stateRoot, `${scopeKey(scope)}.json`);
}

export function readPointer(stateRoot: string, scope: Scope): BasePointer | null {
  try {
    return JSON.parse(fs.readFileSync(pointerPath(stateRoot, scope), "utf8"));
  } catch {
    return null;
  }
}

function writePointer(stateRoot: string, p: BasePointer): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  const tmp = pointerPath(stateRoot, p.scope) + `.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, pointerPath(stateRoot, p.scope));
}


export async function publishBase(args: {
  stateRoot: string;
  lockRoot: string;
  gitDir: string;
  candidate: PublishCandidate;
  depthCap?: number;
  materializeBase: (srcDir: string, fromEmpty: boolean) => string;
}): Promise<PublishResult> {
  const { stateRoot, lockRoot, gitDir, candidate } = args;
  const depthCap = args.depthCap ?? DEFAULT_DEPTH_CAP;

  if (
    candidate.exitCode !== 0 ||
    !candidate.preUserInstall ||
    !candidate.sourceIsDefaultBranch
  ) {
    return { outcome: "skipped-ineligible", pointer: readPointer(stateRoot, candidate.scope) };
  }

  return withScopeLock(lockRoot, candidate.scope, () => {
    const current = readPointer(stateRoot, candidate.scope);

    if (!current) {
      const baseDir = args.materializeBase(candidate.mergedDir, true);
      const pointer: BasePointer = {
        scope: candidate.scope,
        commit: candidate.commit,
        depth: 1,
        generation: 1,
        baseDir,
      };
      writePointer(stateRoot, pointer);
      return { outcome: "created", pointer };
    }

    if (current.commit === candidate.commit) {
      return { outcome: "skipped-equal", pointer: current };
    }

    if (!isAncestor(gitDir, current.commit, candidate.commit)) {
      return { outcome: "skipped-not-forward", pointer: current };
    }

    const wouldBeDepth = current.depth + 1;
    if (wouldBeDepth >= depthCap) {
      const baseDir = args.materializeBase(candidate.mergedDir, true);
      const pointer: BasePointer = {
        scope: candidate.scope,
        commit: candidate.commit,
        depth: 1,
        generation: current.generation + 1,
        baseDir,
      };
      writePointer(stateRoot, pointer);
      return { outcome: "flattened", pointer };
    }

    const baseDir = args.materializeBase(candidate.mergedDir, false);
    const pointer: BasePointer = {
      scope: candidate.scope,
      commit: candidate.commit,
      depth: wouldBeDepth,
      generation: current.generation + 1,
      baseDir,
    };
    writePointer(stateRoot, pointer);
    return { outcome: "advanced", pointer };
  });
}
