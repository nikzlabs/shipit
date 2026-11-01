import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileWithinRoot, resolvePersistPath } from "./session-file-open.js";
import { ServiceError } from "./services/types.js";

describe("readFileWithinRoot", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "within-root-"));
    root = path.join(tmp, "workspace");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.txt"), "inside");
    fs.mkdirSync(path.join(tmp, "outside"));
    fs.writeFileSync(path.join(tmp, "outside", "secret.txt"), "secret");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function refusal(relPath: string): Promise<unknown> {
    try {
      await readFileWithinRoot(root, relPath);
      return null;
    } catch (err) {
      return err;
    }
  }

  it("reads a file inside the root, also through a symlink that stays inside", async () => {
    fs.symlinkSync(path.join(root, "src", "a.txt"), path.join(root, "link.txt"));
    fs.symlinkSync("src", path.join(root, "src-link"));

    expect((await readFileWithinRoot(root, "src/a.txt")).toString()).toBe("inside");
    expect((await readFileWithinRoot(root, "link.txt")).toString()).toBe("inside");
    expect((await readFileWithinRoot(root, "src-link/a.txt")).toString()).toBe("inside");
  });

  it("refuses a symlink to a file outside the root", async () => {
    fs.symlinkSync(path.join(tmp, "outside", "secret.txt"), path.join(root, "leak.txt"));
    expect(await refusal("leak.txt")).toMatchObject({ statusCode: 400 });
  });

  it("refuses a file reached through a symlinked parent directory outside the root", async () => {
    fs.symlinkSync(path.join(tmp, "outside"), path.join(root, "out"));
    expect(await refusal("out/secret.txt")).toMatchObject({ statusCode: 400 });
  });

  it("refuses a symlink swapped in after any path check, because it judges the opened file", async () => {
    const target = path.join(root, "src", "a.txt");
    const realOpen = fsPromises.open.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (p, ...rest) => {
      if (p === target) {
        fs.rmSync(target);
        fs.symlinkSync(path.join(tmp, "outside", "secret.txt"), target);
      }
      return realOpen(p, ...rest);
    });
    try {
      expect(await refusal("src/a.txt")).toMatchObject({ statusCode: 400 });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a path that climbs out of the root", async () => {
    const err = await refusal("../outside/secret.txt");
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ statusCode: 400 });
  });

  it("refuses a FIFO or a directory without blocking", async () => {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(await refusal("pipe")).toMatchObject({ statusCode: 400, message: "Path is not a file" });
    expect(await refusal("src")).toMatchObject({ statusCode: 400, message: "Path is not a file" });
  });

  it("lets a missing file fail as ENOENT, not as a refusal", async () => {
    expect(await refusal("missing.txt")).toMatchObject({ code: "ENOENT" });
  });
});

describe("resolvePersistPath", () => {
  it("maps /persist paths to the scratch dir beside the workspace, and nothing else", () => {
    expect(resolvePersistPath("/s/abc/workspace", "/persist/notes/a.md"))
      .toEqual({ dir: "/s/abc/scratch", relPath: "notes/a.md" });
    expect(resolvePersistPath("/s/abc/workspace", "persist/a.md")).toBeNull();
    expect(resolvePersistPath("/s/abc/workspace", "src/a.ts")).toBeNull();
  });
});
