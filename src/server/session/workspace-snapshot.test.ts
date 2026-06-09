import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SNAPSHOT_EXCLUDES,
  snapshotTarArgs,
  createWorkspaceSnapshotTar,
} from "./workspace-snapshot.js";

describe("snapshotTarArgs", () => {
  it("tars `.` from the workspace root and excludes top-level .git", () => {
    const args = snapshotTarArgs("/workspace");
    expect(args).toEqual([
      "-c",
      "-f",
      "-",
      "-C",
      "/workspace",
      "--exclude",
      "./.git",
      ".",
    ]);
  });

  it("anchors every exclude at the workspace root (./<name>)", () => {
    for (const name of SNAPSHOT_EXCLUDES) {
      expect(snapshotTarArgs("/ws")).toContain(`./${name}`);
    }
  });
});

describe("createWorkspaceSnapshotTar", () => {
  let workspace: string;
  let outDir: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "snap-ws-"));
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-out-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  /** Extract a tar stream into `dest`, resolving when tar exits 0. */
  async function extractInto(stream: NodeJS.ReadableStream, dest: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("tar", ["-x", "-f", "-", "-C", dest], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`extract tar exited ${code}: ${stderr}`)),
      );
      stream.pipe(proc.stdin!);
    });
  }

  it("captures the workspace tree but excludes top-level .git", async () => {
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/feature\n");
    await fs.writeFile(path.join(workspace, "package.json"), '{"name":"x"}');
    await fs.mkdir(path.join(workspace, "node_modules", "foo"), { recursive: true });
    await fs.writeFile(path.join(workspace, "node_modules", "foo", "index.js"), "module.exports={}");
    await fs.mkdir(path.join(workspace, ".shipit"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".shipit", ".install-done"), "{}");

    const { stream, done } = createWorkspaceSnapshotTar(workspace);
    await Promise.all([extractInto(stream, outDir), done]);

    // .git is gone; everything else (including .shipit, the install marker, and
    // the dep tree) round-trips.
    await expect(fs.access(path.join(outDir, ".git"))).rejects.toThrow();
    expect(await fs.readFile(path.join(outDir, "package.json"), "utf8")).toBe('{"name":"x"}');
    expect(
      await fs.readFile(path.join(outDir, "node_modules", "foo", "index.js"), "utf8"),
    ).toBe("module.exports={}");
    await expect(fs.access(path.join(outDir, ".shipit", ".install-done"))).resolves.toBeUndefined();
  });

  it("keeps a nested vendored .git (only the top-level repo is excluded)", async () => {
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".git", "HEAD"), "x");
    await fs.mkdir(path.join(workspace, "vendor", "lib", ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, "vendor", "lib", ".git", "config"), "nested");

    const { stream, done } = createWorkspaceSnapshotTar(workspace);
    await Promise.all([extractInto(stream, outDir), done]);

    await expect(fs.access(path.join(outDir, ".git"))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(outDir, "vendor", "lib", ".git", "config"), "utf8"),
    ).toBe("nested");
  });

  it("preserves symlinks verbatim (does not follow them)", async () => {
    await fs.writeFile(path.join(workspace, "real.txt"), "hello");
    await fs.symlink("real.txt", path.join(workspace, "link.txt"));

    const { stream, done } = createWorkspaceSnapshotTar(workspace);
    await Promise.all([extractInto(stream, outDir), done]);

    const st = await fs.lstat(path.join(outDir, "link.txt"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(outDir, "link.txt"))).toBe("real.txt");
  });

  it("rejects `done` when the workspace path does not exist", async () => {
    const { stream, done } = createWorkspaceSnapshotTar(path.join(workspace, "does-not-exist"));
    // Drain the (empty) stream so the process can exit.
    stream.resume();
    await expect(done).rejects.toThrow(/tar exited with code/);
  });
});
