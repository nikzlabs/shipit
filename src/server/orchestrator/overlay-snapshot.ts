/**
 * Orchestrator-side consumer of the worker dep-dir snapshot (docs/183 Phase 4).
 *
 * The worker exports a dep dir's merged contents as a tar stream over
 * `GET /workspace/dep-snapshot?path=<dep-dir>` (`dep-snapshot.ts`). This module
 * pulls that stream and extracts it into an orchestrator-visible temp dir whose
 * contents become `PublishCandidate.snapshotDir` for `publishBase`.
 *
 * Split in two so the extraction is unit-testable without HTTP: `extractTarStream`
 * takes any `Readable` (the producer's tar stdout in tests, the HTTP body in prod),
 * and `fetchDepSnapshotStream` is the thin fetch wrapper the publish flow composes
 * with it. Nothing here is wired into a live publish until the Phase-4b caller.
 *
 * ## Crash safety (SHI — prod orchestrator crash, 2026-07-30)
 *
 * The producer is a container that can be SIGKILLed at any moment (archive →
 * `dispose(force)` → `destroyContainer`), so the snapshot stream dying mid-transfer
 * is a NORMAL event, not an exceptional one. Every failure here must surface as a
 * **rejected promise** the publish caller can log — never as an unhandled `'error'`
 * event, which is a process-level `uncaughtException` and (there being deliberately
 * no `uncaughtException` handler, `app-lifecycle.ts`) kills the orchestrator.
 *
 * Three places leaked an unhandled `'error'`, all fixed below:
 *   1. the fetched body between `fetchDepSnapshotStream` returning and the caller
 *      attaching its own handler (an `await` tick the socket close fits inside) —
 *      fixed by latching a listener on the stream before it is ever returned;
 *   2. `tar`'s stdin, destroyed with an error on a source failure: `pipe()`'s own
 *      `onerror` removes itself and re-emits on a listener-less stream — fixed by
 *      an explicit swallow listener, with the real cause carried out via `done`;
 *   3. a source that had ALREADY errored before `pipe()` — the `'error'` event had
 *      fired, so nothing ever ended tar's stdin and `done` hung — fixed by
 *      replaying `tarStream.errored` after attaching.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import { workerAuthHeaders } from "./worker-auth.js";

/**
 * Extract a tar stream into `destDir` (created if absent) via `tar -x`. Rejects on
 * a non-zero tar exit or a source-stream error, so a truncated archive (the worker's
 * tar failed mid-export and destroyed the stream, or its container was killed
 * mid-transfer) never silently yields a partial base — and never escapes as an
 * unhandled `'error'` event. See the module docstring for the three leaks this
 * guards.
 */
export async function extractTarStream(tarStream: Readable, destDir: string): Promise<void> {
  // Synchronous mkdir so we never yield the event loop between receiving
  // `tarStream` and attaching the pipe below — an `await` here would let a small,
  // already-buffered producer stream reach EOF before we start consuming it.
  fs.mkdirSync(destDir, { recursive: true });

  const proc = spawn("tar", ["-x", "-f", "-", "-C", destDir], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString();
  });

  if (!proc.stdin) {
    throw new Error("tar -x did not provide a stdin stream");
  }
  const stdin = proc.stdin;

  // Swallow errors on tar's stdin. We destroy it ourselves on a source failure,
  // and `pipe()` installs an `onerror` that removes itself and then re-emits on a
  // listener-less destination — which would throw ERR_UNHANDLED_ERROR out of the
  // event loop. The real cause is carried out through `done` (`sourceError`), so
  // nothing is lost by ignoring the pipe-teardown noise (EPIPE/ERR_STREAM_DESTROYED).
  stdin.on("error", () => {});

  // First source-stream failure, if any. Preferred over tar's exit status when
  // reporting, since "tar exited 2" is a symptom and this is the cause.
  let sourceError: Error | null = null;

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (sourceError) {
        reject(sourceError);
      } else if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`tar -x exited with code ${code ?? "null"}${detail}`));
      }
    });
  });

  // A source error (the worker destroyed a truncated stream, or its container was
  // SIGKILLed mid-transfer) records the cause and closes tar's stdin, so the child
  // hits EOF, exits, and `done` rejects rather than producing a partial tree.
  // `destroy()` without an argument: we already hold the error, and passing it would
  // only re-emit it on stdin.
  const onSourceError = (err: unknown): void => {
    sourceError ??= err instanceof Error ? err : new Error(String(err));
    if (!stdin.destroyed) stdin.destroy();
  };
  tarStream.on("error", onSourceError);
  tarStream.pipe(stdin);

  // The source may have already failed before we got here — the fetched body can
  // terminate during the `await` tick between the pull and this call. Its `'error'`
  // event has therefore already fired, so `onSourceError` would never run and
  // `pipe()` would never end tar's stdin: `done` would hang forever. Replay it.
  if (tarStream.errored) {
    onSourceError(tarStream.errored);
  } else if (tarStream.destroyed && !tarStream.readableEnded) {
    onSourceError(new Error("snapshot stream was destroyed before extraction started"));
  }

  await done;
}

/**
 * Fetch a dep dir's snapshot from the session worker as a Node `Readable`. Thin
 * glue over `fetch` so `extractTarStream` stays HTTP-free and testable.
 *
 * `signal` aborts the request AND the in-flight body — the publish flow passes the
 * session runner's disposal signal so a pull from a container that is being
 * destroyed stops immediately instead of streaming into a socket that is about to
 * be killed.
 *
 * The returned stream carries a latched no-op `'error'` listener: a container
 * SIGKILLed mid-transfer surfaces as `TypeError: terminated` (undici
 * `UND_ERR_SOCKET`) on this stream, and until the consumer attaches its own
 * handler that would be an unhandled `'error'` — i.e. an orchestrator crash.
 * The error is still observable to the consumer via `stream.errored` and via any
 * listener it attaches later.
 */
export async function fetchDepSnapshotStream(
  workerUrl: string,
  depDir: string,
  signal?: AbortSignal,
): Promise<Readable> {
  const url = `${workerUrl}/workspace/dep-snapshot?path=${encodeURIComponent(depDir)}`;
  // SHI-311 — orchestrator-facing worker route; carry the per-session token.
  const res = await fetch(url, {
    headers: workerAuthHeaders(workerUrl),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    // Drain so the socket is released rather than left half-read.
    await res.body?.cancel().catch(() => {});
    throw new Error(`dep-snapshot fetch failed (${res.status}) for ${depDir}`);
  }
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("error", () => {});
  return stream;
}

/** The worker's merged-workspace HEAD plus its runtime fingerprint. */
export interface WorkspaceHeadInfo {
  commit: string;
  /**
   * The worker-side `install-runtime.ts:runtimeKey()` — recorded on the base
   * pointer at publish so the marker pre-stamp can write a stamp the worker's
   * `/install` gate accepts. Null when the worker predates the field (older
   * image): the publish still proceeds, only the pre-stamp is forgone.
   */
  runtimeKey: string | null;
}

/**
 * Fetch the merged-workspace HEAD commit (and the worker's runtime fingerprint)
 * from the session worker (`GET /workspace/head-commit`) — the source commit the
 * install ran against, which stamps a publish candidate and decides publish
 * eligibility (source == remote default). The orchestrator can't read it from
 * the host upperdir (`.git` lives in the merged tree), so it asks the worker.
 * Returns null on any failure so the publish path conservatively declines
 * rather than stamping a candidate with a guessed commit.
 */
export async function fetchWorkspaceHeadInfo(
  workerUrl: string,
  signal?: AbortSignal,
): Promise<WorkspaceHeadInfo | null> {
  try {
    // SHI-311 — orchestrator-facing worker route; carry the per-session token.
    const res = await fetch(`${workerUrl}/workspace/head-commit`, {
      headers: workerAuthHeaders(workerUrl),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: string | null; runtimeKey?: string | null };
    if (typeof body.commit !== "string" || body.commit.length === 0) return null;
    return {
      commit: body.commit,
      runtimeKey: typeof body.runtimeKey === "string" && body.runtimeKey.length > 0 ? body.runtimeKey : null,
    };
  } catch {
    return null;
  }
}
