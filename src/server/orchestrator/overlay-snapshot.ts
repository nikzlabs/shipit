import { spawn } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import { workerAuthHeaders } from "./worker-auth.js";

export async function extractTarStream(tarStream: Readable, destDir: string): Promise<void> {
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

  // Prevent pipe teardown errors from escaping; report the source failure through done.
  stdin.on("error", () => {});

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

  const onSourceError = (err: unknown): void => {
    sourceError ??= err instanceof Error ? err : new Error(String(err));
    if (!stdin.destroyed) stdin.destroy();
  };
  tarStream.on("error", onSourceError);
  tarStream.pipe(stdin);

  // A failure before attachment must also close tar's stdin, or done never settles.
  if (tarStream.errored) {
    onSourceError(tarStream.errored);
  } else if (tarStream.destroyed && !tarStream.readableEnded) {
    onSourceError(new Error("snapshot stream was destroyed before extraction started"));
  }

  await done;
}

export async function fetchDepSnapshotStream(
  workerUrl: string,
  depDir: string,
  signal?: AbortSignal,
): Promise<Readable> {
  const url = `${workerUrl}/workspace/dep-snapshot?path=${encodeURIComponent(depDir)}`;
  const res = await fetch(url, {
    headers: workerAuthHeaders(workerUrl),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`dep-snapshot fetch failed (${res.status}) for ${depDir}`);
  }
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  // Cover the await gap before the consumer attaches; failures remain in stream.errored.
  stream.on("error", () => {});
  return stream;
}

export interface WorkspaceHeadInfo {
  commit: string;
  runtimeKey: string | null;
}

export async function fetchWorkspaceHeadInfo(
  workerUrl: string,
  signal?: AbortSignal,
): Promise<WorkspaceHeadInfo | null> {
  try {
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
