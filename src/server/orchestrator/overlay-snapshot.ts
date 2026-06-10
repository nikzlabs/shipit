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
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";

/**
 * Extract a tar stream into `destDir` (created if absent) via `tar -x`. Rejects on
 * a non-zero tar exit or a source-stream error, so a truncated archive (the worker's
 * tar failed mid-export and destroyed the stream) never silently yields a partial base.
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

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`tar -x exited with code ${code ?? "null"}${detail}`));
      }
    });
  });

  // Pipe the source tar into tar's stdin (auto-ends stdin on source end). A source
  // error (e.g. the worker destroyed a truncated stream) is forwarded so the child
  // sees a broken pipe and `done` rejects rather than producing a partial tree.
  tarStream.on("error", (err) => stdin.destroy(err instanceof Error ? err : new Error(String(err))));
  tarStream.pipe(stdin);

  await done;
}

/**
 * Fetch a dep dir's snapshot from the session worker as a Node `Readable`. Thin
 * glue over `fetch` so `extractTarStream` stays HTTP-free and testable.
 */
export async function fetchDepSnapshotStream(workerUrl: string, depDir: string): Promise<Readable> {
  const url = `${workerUrl}/workspace/dep-snapshot?path=${encodeURIComponent(depDir)}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`dep-snapshot fetch failed (${res.status}) for ${depDir}`);
  }
  return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
}

/**
 * Fetch the merged-workspace HEAD commit from the session worker (`GET
 * /workspace/head-commit`) — the source commit the install ran against, which
 * stamps a publish candidate and decides publish eligibility (source == remote
 * default). The orchestrator can't read it from the host upperdir (`.git` lives
 * in the merged tree), so it asks the worker. Returns null on any failure so the
 * publish path conservatively declines rather than stamping a candidate with a
 * guessed commit.
 */
export async function fetchWorkspaceHeadCommit(workerUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${workerUrl}/workspace/head-commit`);
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: string | null };
    return typeof body.commit === "string" && body.commit.length > 0 ? body.commit : null;
  } catch {
    return null;
  }
}
