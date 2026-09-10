import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The runtime must be registered on the Docker host. */
export function kernelRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.SESSION_RUNTIME?.trim();
  return v ? v : undefined;
}

export const DEFAULT_SECCOMP_PROFILE_PATH = fileURLToPath(
  new URL("../../../docker/seccomp/session-worker.json", import.meta.url),
);

export function seccompEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_SECCOMP === "1";
}

/** Inline JSON avoids requiring the profile file on the Docker host. */
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

export function readonlyRootfsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_READONLY_ROOTFS === "1";
}

// Exec is required for build scripts, global npm installs, and generated plugin wrappers.
// The entrypoint restores credential symlinks hidden by the home tmpfs.
export function readonlyRootfsTmpfs(): Record<string, string> {
  return {
    "/tmp": "rw,exec,nosuid,nodev",
    "/run": "rw,noexec,nosuid,nodev",
    "/home/shipit": "rw,exec,nosuid,nodev",
    "/plugins": "rw,exec,nosuid,nodev",
    "/plugin-bin": "rw,exec,nosuid,nodev",
  };
}

export function readonlyHomeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return readonlyRootfsEnabled(env) ? ["SHIPIT_READONLY_HOME=1"] : [];
}
