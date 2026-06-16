/**
 * docs/172 Gap 5 (SHI-97) — kernel-tier hardening for session containers.
 *
 * The container-escape surface left after the Docker-proxy allowlist, child
 * sanitization, and `CapDrop: ["ALL"]` (see docs/172 "What's already solid") is
 * the *shared host kernel*. This module resolves three independently-shippable,
 * env-gated, default-OFF controls that shrink that surface; they are wired into
 * `createContainer`'s HostConfig (container-lifecycle.ts):
 *
 *   1. **gVisor (`runsc`) runtime** — `SESSION_RUNTIME`. A user-space kernel that
 *      intercepts syscalls before they reach the host kernel. gVisor must be
 *      *registered on the Docker host* (a daemon `runtimes` entry); it cannot be
 *      enabled from orchestrator code alone, and it has a real cost on the
 *      IO/syscall-heavy `npm install` workload. So it ships as operator opt-in:
 *      set `SESSION_RUNTIME=runsc` (or any registered runtime) on hosts that have
 *      it. Unset → Docker's default `runc`, byte-for-byte unchanged.
 *
 *   2. **Custom seccomp profile** — `SESSION_SECCOMP=1` applies the committed
 *      `docker/seccomp/session-worker.json` (a default-deny allowlist derived
 *      from Docker's default profile and tightened). `SESSION_SECCOMP_PROFILE`
 *      overrides the path. Unset → Docker's default seccomp profile still
 *      applies (we never run unconfined).
 *
 *   3. **Read-only root filesystem** — `SESSION_READONLY_ROOTFS=1` sets
 *      `ReadonlyRootfs: true` and supplies the minimal writable set as tmpfs
 *      mounts (the persistent writable paths — /workspace, /credentials,
 *      /uploads, /dep-cache — are already bind/volume mounts and stay writable).
 *      Requires the non-root runtime (`SHIPIT_SESSION_WORKER_UID`); see
 *      {@link readonlyRootfsTmpfs} for why and the home-dir handling.
 *
 * Each is gated so merging this is inert until an operator opts in — the same
 * default-OFF, verify-on-a-live-host-first pattern the egress work (SHI-90) used.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 1. gVisor / alternate OCI runtime
// ---------------------------------------------------------------------------

/**
 * The container runtime to request via `HostConfig.Runtime`, or undefined for
 * Docker's default (`runc`). Set `SESSION_RUNTIME=runsc` on a host where gVisor
 * is registered as a Docker runtime. Whitespace-trimmed; empty → undefined.
 */
export function kernelRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.SESSION_RUNTIME?.trim();
  return v ? v : undefined;
}

// ---------------------------------------------------------------------------
// 2. Custom seccomp profile
// ---------------------------------------------------------------------------

/** Path to the committed default seccomp profile, resolved relative to the repo. */
export const DEFAULT_SECCOMP_PROFILE_PATH = fileURLToPath(
  new URL("../../../docker/seccomp/session-worker.json", import.meta.url),
);

export function seccompEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_SECCOMP === "1";
}

/**
 * Resolve the `seccomp=<profile-json>` value for `HostConfig.SecurityOpt`, or
 * undefined when seccomp customization is off (Docker's default profile then
 * applies — we never go unconfined). The profile JSON is read from disk and
 * embedded inline (Docker accepts the full profile as the SecurityOpt value), so
 * the orchestrator does not depend on the file being present on the Docker host.
 *
 * Fail-closed: if `SESSION_SECCOMP=1` but the profile can't be read or isn't
 * valid JSON, throw — mirrors the egress installer's refusal to start a
 * container that can't be contained, rather than silently dropping the control.
 */
export function resolveSeccompSecurityOpt(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!seccompEnabled(env)) return undefined;
  const profilePath = env.SESSION_SECCOMP_PROFILE?.trim() || DEFAULT_SECCOMP_PROFILE_PATH;
  let raw: string;
  try {
    raw = fs.readFileSync(profilePath, "utf8");
  } catch (err) {
    throw new Error(
      `SESSION_SECCOMP=1 but seccomp profile is unreadable at ${profilePath}`,
      { cause: err },
    );
  }
  // Validate it parses and re-serialize to a compact form (drops `_comment`
  // fields' whitespace; Docker ignores unknown keys). A malformed profile must
  // not reach the daemon as a silent SecurityOpt no-op.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `SESSION_SECCOMP=1 but seccomp profile at ${profilePath} is not valid JSON`,
      { cause: err },
    );
  }
  return `seccomp=${JSON.stringify(parsed)}`;
}

// ---------------------------------------------------------------------------
// 3. Read-only root filesystem
// ---------------------------------------------------------------------------

export function readonlyRootfsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_READONLY_ROOTFS === "1";
}

/**
 * The minimal writable set supplied as **tmpfs** mounts when `ReadonlyRootfs` is
 * on (returned as `HostConfig.Tmpfs`). The *persistent* writable paths the
 * non-root worker established in docs/150 — `/workspace`, `/credentials`,
 * `/uploads`, `/dep-cache` — are already bind/volume mounts and remain writable
 * over a read-only rootfs, so they are NOT listed here. What's left are the
 * paths that live on the image rootfs and must become writable:
 *
 *   - `/tmp` — agent scratch, Playwright MCP profile (`/tmp/.playwright-mcp`),
 *     and npm/build lifecycle scripts. MUST stay `exec` (lifecycle scripts run
 *     executables from here) — `noexec` would break `npm install`. nosuid/nodev
 *     because nothing here is ever a setuid binary or device node.
 *   - `/run` — pid/lock scratch some tooling expects to be writable.
 *   - `/home/shipit` — the runtime user's HOME holds writable state: `.npm`
 *     (cache), `.npm-global` (global installs), `.cache`, and `~/.claude.json`.
 *     A tmpfs SHADOWS the image-baked credential symlinks (`.claude`→/credentials
 *     etc.), so the entrypoint re-creates them into the tmpfs when
 *     `SHIPIT_READONLY_HOME=1` (see {@link readonlyHomeEnv} and
 *     docker/session-worker/entrypoint.sh). MUST stay `exec`: npm-global installs
 *     drop executables under `~/.npm-global/bin`.
 *
 * These are RAM-backed and ephemeral, which is fine — the credential symlinks
 * point into the persistent `/credentials` mount, so auth survives; only caches
 * and per-container scratch are lost on restart, as they already are.
 */
export function readonlyRootfsTmpfs(): Record<string, string> {
  return {
    "/tmp": "rw,exec,nosuid,nodev",
    "/run": "rw,noexec,nosuid,nodev",
    "/home/shipit": "rw,exec,nosuid,nodev",
  };
}

/**
 * Extra env forwarded to the container when ReadonlyRootfs is on, so the
 * entrypoint knows to re-create the credential symlinks into the tmpfs HOME.
 * Returns `[]` when readonly-rootfs is off → no env change.
 */
export function readonlyHomeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return readonlyRootfsEnabled(env) ? ["SHIPIT_READONLY_HOME=1"] : [];
}
