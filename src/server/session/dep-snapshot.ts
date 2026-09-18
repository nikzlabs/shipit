// Export the container's merged dep-dir contents; host upperdirs contain only deltas.

import { spawn } from "node:child_process";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";

export function safeDepDirRelpath(depDir: string): string | null {
  if (!depDir || path.isAbsolute(depDir)) return null;
  const norm = path.normalize(depDir);
  if (norm === "." || norm === "..") return null;
  if (norm.split(/[\\/]/).includes("..")) return null;
  return norm;
}

export function depSnapshotTarArgs(workspaceRoot: string, depDir: string): string[] {
  return ["-c", "-f", "-", "-C", path.join(workspaceRoot, depDir), "."];
}

export interface DepSnapshotStream {
  stream: Readable;
  done: Promise<void>;
}

// Live services may mutate the tree. Reject every nonzero exit, even if extraction would succeed.
export function createDepSnapshotTar(workspaceRoot: string, depDir: string): DepSnapshotStream {
  // Inherited tar flags could silently exclude files from the shared base.
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

  // stdout ends before process close; withhold EOF until the exit code confirms success.
  const out = new PassThrough();
  // Prevent uncaught stream errors before a consumer attaches; done still rejects.
  out.on("error", () => {});
  proc.stdout.on("error", (err: Error) => out.destroy(err));
  proc.stdout.pipe(out, { end: false });
  // The caller observes rejection through done as well as the stream.
  // eslint-disable-next-line no-restricted-syntax
  done.then(
    () => out.end(),
    (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
  );

  return { stream: out, done };
}
