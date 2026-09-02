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
    // Build a fake workspace with a node_modules tree (nested file + symlink).
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "module.exports = 1;");
    fs.symlinkSync("pkg/index.js", path.join(nm, "link.js"));
    const dest = tmp();

    // Spawn the consumer and pipe in the SAME synchronous tick as the producer —
    // no `await` between them. An async gap here would let this small producer
    // stream reach EOF before the pipe attaches, so `tar -x` would never receive
    // an end-of-stdin and would hang (the CI timeout that caught the old version).
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

    // The dep dir's CONTENTS landed directly at dest (no node_modules/ wrapper).
    expect(fs.readFileSync(path.join(dest, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;");
    expect(fs.readlinkSync(path.join(dest, "link.js"))).toBe("pkg/index.js"); // symlink verbatim
  });

  it("rejects `done` when the dep dir does not exist", async () => {
    const root = tmp();
    const { stream, done } = createDepSnapshotTar(root, "does-not-exist");
    stream.resume(); // drain so the process can close
    await expect(done).rejects.toThrow(/tar exited/);
  });

  /**
   * A dep dir whose only bulk member is `big.bin`, far larger than the 64 KiB OS
   * pipe buffer plus Node's 64 KiB stream buffer. Nothing drains the snapshot until
   * the test says so, so tar BLOCKS partway through that member — which is what
   * makes the concurrent-write tests below deterministic rather than timing
   * dependent: the tree is mutated while tar is provably still reading it.
   */
  function bigDepDir(): { root: string; nm: string; big: string } {
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    const big = path.join(nm, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 7));
    return { root, nm, big };
  }

  /**
   * Both races below are GNU tar's post-read stat check. libarchive's bsdtar
   * (macOS) has no equivalent on its write path, so it exits 0 and the race is
   * simply unobservable there — skip rather than assert a contract that tar does
   * not offer. Production and CI are Debian/GNU.
   */
  const gnuTar = (() => {
    try {
      return spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU tar");
    } catch {
      return false;
    }
  })();

  it.runIf(gnuTar)("rejects, and does NOT end the stream cleanly, when the dep-dir ROOT changes mid-read", async () => {
    // The production symptom (2026-09-02, 18 of 46 live containers): a compose dev
    // server creates a top-level entry inside the dep dir it is served from
    // (`node_modules/.vite`) while the snapshot streams, so tar's final stat of the
    // dep-dir root differs and it exits 1 with `tar: .: file changed as we read it`.
    //
    // The archive tar produced is structurally COMPLETE, so the consumer's `tar -x`
    // would succeed on it — the ONLY thing that stops it being published as a shared
    // base is this stream erroring instead of ending. It used to end cleanly first
    // (`'close'` fires after stdout's `'end'`), which is the hole the PassThrough
    // gate closes. The orchestrator retries the pull; see `overlay-publish.ts`.
    const { root, nm } = bigDepDir();
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    // First readable byte ⇒ tar has read the root's listing, written its headers and
    // is inside `big.bin` (the only member with any bulk), blocked on an undrained
    // stdout.
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
    // The other stderr variant observed in production (`./deep-eql/index.js`). This
    // one can genuinely tear a member — tar writes exactly the stat'd size, padding a
    // shrink and truncating a growth — and the archive is still complete, so the
    // rejection is the only thing between it and a repo-wide shared base.
    const { root, big } = bigDepDir();
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    await once(stream, "readable"); // tar is inside `big.bin`
    const fd = fs.openSync(big, "r+");
    fs.writeSync(fd, Buffer.from([9]), 0, 1, 0);
    fs.closeSync(fd);
    stream.resume();
    await expect(done).rejects.toThrow(/big\.bin: file changed as we read it/);
  });

  it("does not crash the worker when a failed tar's stream has no listener", async () => {
    // The stream is destroyed with the error on a failed tar, and an `'error'`
    // emitted on a listener-less stream is an `uncaughtException` — in the session
    // worker process. Same hazard `overlay-snapshot.ts` latches against.
    const root = tmp();
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    try {
      const { done } = createDepSnapshotTar(root, "does-not-exist"); // `stream` deliberately untouched
      await expect(done).rejects.toThrow(/tar exited/);
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("does not inherit TAR_OPTIONS, which could silently drop files from a shared base", async () => {
    // GNU tar reads TAR_OPTIONS from the environment and applies it as extra flags.
    // An `--exclude` there would remove members from a base every future session of
    // the repo mounts, with nothing in the archive to show for it.
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "module.exports = 1;");
    const dest = tmp();
    const prev = process.env.TAR_OPTIONS;
    process.env.TAR_OPTIONS = "--exclude=pkg";
    try {
      // The EXTRACTOR is spawned with TAR_OPTIONS stripped by hand, so the only
      // thing this asserts is whether the PRODUCER honoured it.
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
