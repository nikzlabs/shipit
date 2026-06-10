/**
 * Worker-exported per-dependency-directory snapshot (docs/183 Phase 4).
 *
 * When the orchestrator publishes a new rolling overlay base for a dep dir it must
 * capture the **merged** contents of that dep dir as the agent sees it at
 * `/workspace/<dep-dir>` — lowerdir (the previous base) + upperdir (this session's
 * install delta). For an overlay session that merged view exists only inside the
 * session container (the host-side `upperdir` holds just this session's delta), so
 * the orchestrator pulls it over HTTP — the same HTTP-only containment model as
 * every other orchestrator↔container call (no `docker exec`, no shared mount).
 *
 * Unlike the (removed) whole-workspace snapshot, this exports a **single dep dir's
 * contents**:
 *   - We tar the dep dir's CONTENTS (`-C <root>/<depDir> .`), not a `node_modules/`
 *     member, so extraction lands them directly as the base contents — matching the
 *     overlay `lowerdir = overlay-base/<scopeHash>` that mounts merged at the dep
 *     dir's path.
 *   - Tarring the **merged** mount means overlay whiteouts are already resolved
 *     (deletions applied), and symlinks are stored verbatim (a pnpm store / `.pnp`
 *     cache round-trips faithfully).
 *   - No `.git` exclusion: a dependency directory has no top-level repo `.git`, and
 *     a vendored package's nested `.git` is part of that dependency.
 *
 * The Phase-4b consumer extracts this stream into a temp dir on the state volume
 * and passes it as `PublishCandidate.snapshotDir` to `publishBase`. This module owns
 * only the producer side; nothing here is wired into a live publish until that
 * consumer exists.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

/**
 * Validate a dep-dir relpath is a safe subpath of the workspace — relative, no
 * `..` escape, not the root. Defense-in-depth: the value already passed Phase-1
 * config validation, but the endpoint must never tar an attacker-influenced
 * absolute/escaping path. Returns the normalized relpath, or null if unsafe.
 */
export function safeDepDirRelpath(depDir: string): string | null {
  if (!depDir || path.isAbsolute(depDir)) return null;
  const norm = path.normalize(depDir);
  if (norm === "." || norm === "..") return null;
  if (norm.split(/[\\/]/).includes("..")) return null;
  return norm;
}

/**
 * `tar` argv to stream the dep dir's contents at `<workspaceRoot>/<depDir>` to
 * stdout. Pure (no spawn) so the layout contract is unit-testable without running
 * tar. Flags restricted to the GNU/BSD-common set so the same args run on the Linux
 * session image and a dev machine's tar.
 */
export function depSnapshotTarArgs(workspaceRoot: string, depDir: string): string[] {
  return ["-c", "-f", "-", "-C", path.join(workspaceRoot, depDir), "."];
}

/** A running snapshot export: its tar stdout stream plus a completion promise. */
export interface DepSnapshotStream {
  /** tar's stdout — pipe this to the HTTP response (or any sink). */
  stream: Readable;
  /**
   * Resolves when tar exits 0; rejects on non-zero exit / spawn error (with
   * captured stderr). A rejected `done` means the piped tar is truncated and must
   * not be trusted as a base.
   */
  done: Promise<void>;
}

/**
 * Spawn `tar` to stream the dep dir's contents as a tar archive on stdout. The
 * post-install / pre-agent workspace is quiescent, so tar's "file changed as we
 * read it" race does not apply; a non-zero exit is a real failure and rejects `done`.
 */
export function createDepSnapshotTar(workspaceRoot: string, depDir: string): DepSnapshotStream {
  const proc = spawn("tar", depSnapshotTarArgs(workspaceRoot, depDir), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString();
  });

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(
          new Error(`tar exited with code ${code ?? "null"} while snapshotting ${path.join(workspaceRoot, depDir)}${detail}`),
        );
      }
    });
  });

  if (!proc.stdout) {
    throw new Error("tar did not provide a stdout stream");
  }

  return { stream: proc.stdout, done };
}
