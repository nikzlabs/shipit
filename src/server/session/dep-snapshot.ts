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
   * Resolves when tar exits 0, or on the one tolerated exit-1 shape (see
   * {@link isTolerableTarRace}); rejects on any other non-zero exit / spawn error
   * (with captured stderr). A rejected `done` means the piped tar is truncated or
   * of unknown consistency and must not be trusted as a base.
   */
  done: Promise<void>;
}

/**
 * GNU tar's per-member warning, emitted when a member's stat differs between the
 * stat taken before the read and the one taken after. Capture group 1 is the
 * member path exactly as tar printed it, relative to `-C` (so the dep-dir root
 * itself is the literal `.`).
 */
const FILE_CHANGED_RE = /^tar: (.+): file changed as we read it$/;

/** Some tar builds append this after a warning that set the exit status. */
const TAR_FAILURE_STATUS_LINE = "tar: Exiting with failure status due to previous errors";

/**
 * Whether an exit-1 tar run is the ONE race we tolerate: every warning it printed
 * is `file changed as we read it` naming the dep-dir ROOT (`.`) and nothing else.
 *
 * The production workspace is NOT quiescent (see {@link createDepSnapshotTar}), and
 * GNU tar's exit 1 means "the archive is not an exact copy of the file set" — for a
 * base SHARED by every future session of the repo, that is normally a reason to
 * decline. The root-only case is the exception, and the distinction is what tar
 * itself reports:
 *
 *   - `tar: .: file changed as we read it` — the dep dir's own directory entry
 *     changed while tar read its listing: a top-level entry was created or removed
 *     (a dev server dropping `node_modules/.vite`, npm rewriting
 *     `node_modules/.package-lock.json`). tar stores no content for a directory, so
 *     no member's bytes are affected; at worst a transient top-level entry is
 *     absent from — or present in — the archive. Every stable member is intact.
 *   - `tar: ./pkg/index.js: file changed as we read it` — a member's own bytes moved
 *     under the read, so that member may be torn (tar writes exactly the stat'd
 *     size, zero-padding a shrink and truncating a growth). It also means something
 *     is structurally rewriting the tree — a concurrent install — which is precisely
 *     the state that must never become a shared base. Stays fatal.
 *
 * tar reports each changed member separately, so a stderr carrying only the root
 * warning is the evidence that no member's content was seen to change. The match is
 * deliberately whole-line and exact: an unrecognised line, a warning naming any path
 * inside the dep dir, or a stderr truncated mid-line by the 8 KiB cap all fail the
 * test and keep the run fatal.
 */
export function isTolerableTarRace(stderr: string): boolean {
  let sawRootRace = false;
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === TAR_FAILURE_STATUS_LINE) continue;
    const m = FILE_CHANGED_RE.exec(line);
    if (m?.[1] !== ".") return false;
    sawRootRace = true;
  }
  return sawRootRace;
}

/**
 * Spawn `tar` to stream the dep dir's contents as a tar archive on stdout.
 *
 * This used to assume the post-install / pre-agent workspace was quiescent, so that
 * tar's "file changed as we read it" race could not apply and any non-zero exit was
 * a real failure. **That assumption is false in production**: compose dev services
 * start in PARALLEL with `agent.install` (`service-manager-setup.ts` — the install
 * gate retries services that race it, it does not hold them back), and a running
 * Node dev server writes inside the dep dir it is served from — a Vite server keeps
 * its optimizer cache at `node_modules/.vite`. Measured on the production host
 * 2026-09-02, this failed the snapshot in 18 of 46 live containers (~39%), losing
 * the docs/183 rolling base for those dep dirs.
 *
 * So exit 1 is now decided on tar's own stderr: the dep-dir-root-only race resolves
 * (see {@link isTolerableTarRace}), everything else — any other warning, any exit
 * code other than 0 or 1 — still rejects.
 */
export function createDepSnapshotTar(workspaceRoot: string, depDir: string): DepSnapshotStream {
  const proc = spawn("tar", depSnapshotTarArgs(workspaceRoot, depDir), {
    stdio: ["ignore", "pipe", "pipe"],
    // The exit-1 decision below parses tar's stderr, and GNU tar translates its
    // diagnostics under a non-C locale. Nothing sets one in the session image
    // today, so this changes no behaviour — it pins the one input that decision
    // reads, so a session env var or an image change can't silently turn every
    // tolerable race back into a failed publish.
    env: { ...process.env, LC_ALL: "C" },
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
      } else if (code === 1 && isTolerableTarRace(stderr)) {
        // Kept as a log line rather than swallowed: a dep dir whose root churns on
        // every snapshot is still worth seeing, even though the archive is sound.
        console.warn(
          `[dep-snapshot] tolerated a dep-dir root race while snapshotting ${path.join(workspaceRoot, depDir)}: ${stderr.trim()}`,
        );
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
