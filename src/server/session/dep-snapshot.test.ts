import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeDepDirRelpath, depSnapshotTarArgs, createDepSnapshotTar } from "./dep-snapshot.js";

describe("safeDepDirRelpath", () => {
  it("accepts and normalizes safe relative subpaths", () => {
    expect(safeDepDirRelpath("node_modules")).toBe("node_modules");
    expect(safeDepDirRelpath("packages/app/node_modules")).toBe(path.normalize("packages/app/node_modules"));
    expect(safeDepDirRelpath("./node_modules")).toBe("node_modules");
  });

  it("rejects absolute, empty, root, and escaping paths", () => {
    expect(safeDepDirRelpath("")).toBeNull();
    expect(safeDepDirRelpath("/abs/node_modules")).toBeNull();
    expect(safeDepDirRelpath(".")).toBeNull();
    expect(safeDepDirRelpath("..")).toBeNull();
    expect(safeDepDirRelpath("../escape")).toBeNull();
    expect(safeDepDirRelpath("packages/../../etc")).toBeNull();
  });
});

describe("depSnapshotTarArgs", () => {
  it("tars the dep dir's CONTENTS (-C <root>/<depDir> .)", () => {
    expect(depSnapshotTarArgs("/workspace", "node_modules")).toEqual([
      "-c", "-f", "-", "-C", path.join("/workspace", "node_modules"), ".",
    ]);
  });
});

describe("createDepSnapshotTar", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dep-snap-"));
    tmpDirs.push(d);
    return d;
  }

  it("streams a tar of the dep dir's contents that extracts back faithfully", async () => {
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "module.exports = 1;");
    fs.symlinkSync("pkg/index.js", path.join(nm, "link.js"));
    const dest = tmp();

    const x = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "ignore"] });
    const xin = x.stdin;
    if (!xin) throw new Error("tar -x has no stdin");
    const extracted = new Promise<void>((resolve, reject) => {
      x.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extract exited ${code}`))));
      x.on("error", reject);
    });
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    stream.pipe(xin);

    await Promise.all([done, extracted]);

    expect(fs.readFileSync(path.join(dest, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;");
    expect(fs.readlinkSync(path.join(dest, "link.js"))).toBe("pkg/index.js");
  });

  it("rejects `done` when the dep dir does not exist", async () => {
    const root = tmp();
    const { stream, done } = createDepSnapshotTar(root, "does-not-exist");
    stream.resume();
    await expect(done).rejects.toThrow(/tar exited/);
  });

  // Exceed pipe/stream buffers so undrained tar blocks mid-file while the test mutates it.
  function bigDepDir(): { root: string; nm: string; big: string } {
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    const big = path.join(nm, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 7));
    return { root, nm, big };
  }

  // BSD tar lacks GNU tar's post-read stat check.
  const gnuTar = (() => {
    try {
      return spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU tar");
    } catch {
      return false;
    }
  })();

  it.runIf(gnuTar)("rejects, and does NOT end the stream cleanly, when the dep-dir ROOT changes mid-read", async () => {
    const { root, nm } = bigDepDir();
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    await once(stream, "readable");
    fs.mkdirSync(path.join(nm, ".vite"));

    let endedCleanly = false;
    stream.on("end", () => { endedCleanly = true; });
    const streamErr = once(stream, "error");
    stream.resume();

    await expect(done).rejects.toThrow(/file changed as we read it/);
    const [err] = await streamErr;
    expect(String(err)).toMatch(/file changed as we read it/);
    expect(endedCleanly).toBe(false);
  });

  it.runIf(gnuTar)("rejects when a MEMBER's own bytes change mid-read", async () => {
    const { root, big } = bigDepDir();
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    await once(stream, "readable");
    const fd = fs.openSync(big, "r+");
    fs.writeSync(fd, Buffer.from([9]), 0, 1, 0);
    fs.closeSync(fd);
    stream.resume();
    await expect(done).rejects.toThrow(/big\.bin: file changed as we read it/);
  });

  it("does not crash the worker when a failed tar's stream has no listener", async () => {
    const root = tmp();
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    try {
      const { done } = createDepSnapshotTar(root, "does-not-exist");
      await expect(done).rejects.toThrow(/tar exited/);
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("does not inherit TAR_OPTIONS, which could silently drop files from a shared base", async () => {
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "module.exports = 1;");
    const dest = tmp();
    const prev = process.env.TAR_OPTIONS;
    process.env.TAR_OPTIONS = "--exclude=pkg";
    try {
      // Isolate producer behavior from the extractor's environment.
      const { TAR_OPTIONS: _ignored, ...cleanEnv } = process.env;
      const x = spawn("tar", ["-x", "-f", "-", "-C", dest], {
        stdio: ["pipe", "ignore", "ignore"],
        env: cleanEnv,
      });
      const xin = x.stdin;
      if (!xin) throw new Error("tar -x has no stdin");
      const extracted = new Promise<void>((resolve, reject) => {
        x.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extract exited ${code}`))));
        x.on("error", reject);
      });
      const { stream, done } = createDepSnapshotTar(root, "node_modules");
      stream.pipe(xin);
      await Promise.all([done, extracted]);
      expect(fs.existsSync(path.join(dest, "pkg", "index.js"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TAR_OPTIONS;
      else process.env.TAR_OPTIONS = prev;
    }
  });
});
