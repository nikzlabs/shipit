/**
 * Worker-exported merged-workspace snapshot (docs/183 Phase 3).
 *
 * When the orchestrator publishes a new rolling overlay base it must capture the
 * **merged** workspace tree — lowerdir (the previous base) + upperdir (this
 * session's install delta) as the agent sees it at `/workspace`. For an overlay
 * session that merged view exists **only inside the session container**
 * (`session.workspaceDir` on the host is just the upperdir/storage subtree), so
 * the orchestrator cannot read it directly. Publishing from the host upperdir
 * alone would be wrong: after a no-op install whose delta is ~empty it would drop
 * every dependency and source file that lived only in the lowerdir (plan §4
 * "Publish/flatten from a worker-exported snapshot").
 *
 * So the worker exports the snapshot and the orchestrator pulls it over HTTP —
 * the same HTTP-only containment model as every other orchestrator↔container
 * call (no `docker exec`, no shared snapshot mount). The transfer is a **tar
 * stream of the merged `/workspace`**:
 *
 *   - Tarring the **merged** mount means overlay whiteouts are already resolved —
 *     a file deleted since the base simply isn't present in the merged view, so
 *     there are no `0:0` char-device whiteout markers to special-case. The stream
 *     is a clean, deletions-applied tree.
 *   - Symlinks are stored verbatim (tar does not follow them), so a venv, a pnpm
 *     store, or a `.pnp` cache inside the tree round-trips faithfully — matching
 *     the orchestrator's `fs.cp(..., { verbatimSymlinks: true })` materialize.
 *   - **`.git` is excluded** — the one capture-filter exclusion (plan §"Capture
 *     filter"). The base is captured on *some* session's branch, so its `.git`
 *     holds that session's branch ref / `HEAD` / reflog; carrying it forward would
 *     hand the next session a stale branch instead of its own. Each session brings
 *     its own `.git` via the normal repo-cache clone, landing in its upper layer.
 *     Only the **top-level** `.git` is excluded (the workspace's own repo); a
 *     nested `vendor/foo/.git` is ordinary source and is kept.
 *
 * The Phase-4 consumer extracts this stream into a temp directory on the state
 * volume and passes it as `PublishCandidate.snapshotDir` to `publishBase`
 * (`overlay-base.ts`). This module owns only the producer side; nothing here is
 * wired into a live publish until that Phase-4 caller exists.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Top-level workspace entries excluded from the captured base. Exactly `.git`
 * today (see the module header for why); kept as a list so the rationale lives in
 * one place if the capture filter ever grows.
 */
export const SNAPSHOT_EXCLUDES: readonly string[] = [".git"];

/**
 * `tar` argv to stream the workspace at `workspaceRoot` to stdout, excluding the
 * {@link SNAPSHOT_EXCLUDES} top-level entries. Pure (no spawn) so the exclusion
 * contract is unit-testable without running tar.
 *
 * Members are emitted relative to `workspaceRoot` as `./path` (we tar `.` from
 * `-C <root>`), so each exclude is anchored as `./<name>` — that matches the
 * top-level `./.git` and its contents but NOT a nested `./vendor/foo/.git`.
 * Flags are restricted to the GNU/BSD-common set (`-c -f - -C <dir> --exclude`)
 * so the same args run on the Linux session image and on a dev machine's tar.
 */
export function snapshotTarArgs(workspaceRoot: string): string[] {
  return [
    "-c",
    "-f",
    "-",
    "-C",
    workspaceRoot,
    ...SNAPSHOT_EXCLUDES.flatMap((name) => ["--exclude", `./${name}`]),
    ".",
  ];
}

/** A running snapshot export: its tar stdout stream plus a completion promise. */
export interface WorkspaceSnapshotStream {
  /** tar's stdout — pipe this to the HTTP response (or any sink). */
  stream: Readable;
  /**
   * Resolves when tar exits 0; rejects on a non-zero exit or spawn error (with
   * captured stderr). The caller pipes {@link stream} for the bytes and awaits
   * `done` to know whether the archive is complete — a rejected `done` means the
   * piped tar is truncated and must not be trusted as a base.
   */
  done: Promise<void>;
}

/**
 * Spawn `tar` to stream `workspaceRoot` (minus {@link SNAPSHOT_EXCLUDES}) as a
 * tar archive on stdout. The post-install / pre-agent workspace is quiescent, so
 * tar's "file changed as we read it" race does not apply; a non-zero exit is a
 * real failure and rejects `done`.
 */
export function createWorkspaceSnapshotTar(workspaceRoot: string): WorkspaceSnapshotStream {
  const proc = spawn("tar", snapshotTarArgs(workspaceRoot), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    // Bound the captured stderr so a pathological tar can't grow memory without
    // limit; the head is enough to diagnose.
    if (stderr.length < 8192) stderr += chunk.toString();
  });

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", (err) => {
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(
          new Error(
            `tar exited with code ${code ?? "null"} while snapshotting ${workspaceRoot}${detail}`,
          ),
        );
      }
    });
  });

  if (!proc.stdout) {
    // Should be unreachable given stdio:"pipe", but keep the type honest.
    throw new Error("tar did not provide a stdout stream");
  }

  return { stream: proc.stdout, done };
}
