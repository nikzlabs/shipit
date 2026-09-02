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
 *
 * **The dep dir is not quiescent while we read it** — see
 * {@link createDepSnapshotTar} for the production measurement that disproved the
 * original assumption, and for the two things that make a failed tar actually reach
 * the consumer.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";

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

/** A running snapshot export: its tar stream plus a completion promise. */
export interface DepSnapshotStream {
  /** The archive bytes — pipe this to the HTTP response (or any sink). */
  stream: Readable;
  /**
   * Resolves when tar exits 0; rejects on a non-zero exit / spawn error (with
   * captured stderr). A rejected `done` means the archive must not be trusted as a
   * base — and `stream` is destroyed with that error rather than ending cleanly,
   * so a consumer that only watches the stream cannot miss it.
   */
  done: Promise<void>;
}

/**
 * Spawn `tar` to stream the dep dir's contents as a tar archive.
 *
 * This used to assume the post-install / pre-agent workspace was quiescent, so that
 * tar's "file changed as we read it" race could not apply. **That assumption is
 * false in production**: compose services start in PARALLEL with `agent.install`
 * (`service-manager-setup.ts` — the install gate retries a service that races the
 * install, it never defers starting one), and a running Node dev server writes
 * inside the dep dir it is served from (a Vite server keeps its optimizer cache at
 * `node_modules/.vite`). Creating or removing a top-level entry moves the dep dir's
 * own mtime, so tar's final stat of `.` differs and it exits **1**. Measured on the
 * production host 2026-09-02, this failed the snapshot in 18 of 46 live containers
 * (~39%), losing the docs/183 rolling base for those dep dirs.
 *
 * The rule here is UNCHANGED by that — a non-zero exit still rejects, because GNU
 * tar's exit 1 means the archive is not an exact copy of the file set and this base
 * is shared by every future session of the repo. What changed is that the race is
 * now treated as **transient and retryable**: the orchestrator re-pulls once
 * (`overlay-publish.ts`), so a one-shot write during the read costs a second pull
 * instead of the whole optimization, and only an archive tar itself called clean is
 * ever published.
 *
 * Two things make that rejection actually reach the consumer:
 *
 *  - **The stream does not EOF before the exit code is known.** `'close'` fires
 *    AFTER stdout's `'end'` (verified), so piping tar's stdout straight to the HTTP
 *    reply let a FAILED tar complete the response successfully — and both exit-1
 *    shapes produce a structurally COMPLETE archive, so the orchestrator's `tar -x`
 *    succeeded and published it. The `PassThrough` below withholds end-of-stream
 *    until `done` settles, and destroys with the error when it rejects.
 *  - **tar's behavioural environment is sanitized.** `TAR_OPTIONS` is read from the
 *    environment by GNU tar and can add arbitrary flags — an `--exclude` there would
 *    silently drop files from a repo-wide shared base. `LC_ALL=C` keeps the captured
 *    stderr readable in logs whatever locale the image later grows.
 */
export function createDepSnapshotTar(workspaceRoot: string, depDir: string): DepSnapshotStream {
  const { TAR_OPTIONS: _dropped, ...env } = process.env;
  const proc = spawn("tar", depSnapshotTarArgs(workspaceRoot, depDir), {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, LC_ALL: "C" },
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

  // `{ end: false }` is the whole point: WE decide when the consumer sees EOF, and
  // that is only once tar's exit code is in. Errors on tar's own stdout are carried
  // through the same gate rather than emitted on a stream nobody may be listening to.
  const out = new PassThrough();
  // Latched no-op `'error'` listener, for the same reason `overlay-snapshot.ts`
  // latches one on the fetched body: we destroy this stream ourselves on a failed
  // tar, and an `'error'` emitted on a listener-less stream is an
  // `uncaughtException` — here, in the session worker. The consumer still sees the
  // error through its own listener and through `done`.
  out.on("error", () => {});
  proc.stdout.on("error", (err: Error) => out.destroy(err));
  proc.stdout.pipe(out, { end: false });
  // Two-arg `.then` on purpose: this is the fire-and-forget gate release from a
  // synchronous factory, and the rejection is ALSO reported through `done` itself.
  // eslint-disable-next-line no-restricted-syntax
  done.then(
    () => out.end(),
    (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
  );

  return { stream: out, done };
}
