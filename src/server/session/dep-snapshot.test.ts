import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  safeDepDirRelpath,
  depSnapshotTarArgs,
  createDepSnapshotTar,
  isTolerableTarRace,
} from "./dep-snapshot.js";

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
   * Build a dep dir whose payload is far larger than the 64 KiB OS pipe buffer +
   * Node's 64 KiB stream buffer, so tar BLOCKS on stdout until the test drains it.
   * That is what makes the concurrent-write regression tests deterministic rather
   * than timing-dependent: we mutate the tree while tar is provably mid-read.
   */
  function bigDepDir(): { root: string; nm: string; big: string } {
    const root = tmp();
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "module.exports = 1;");
    const big = path.join(nm, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 7));
    return { root, nm, big };
  }

  it("resolves — with every stable member intact — when the dep-dir ROOT changes mid-read", async () => {
    // The production symptom (2026-09-02, 18 of 46 live containers): a compose dev
    // server creates/removes a top-level entry inside the dep dir it is served from
    // (`node_modules/.vite`) while the snapshot streams, so tar's final stat of the
    // dep-dir root differs and it exits 1 with `tar: .: file changed as we read it`.
    // Before the fix this rejected `done`, the endpoint destroyed the stream, and
    // the dep dir's shared rolling base was never advanced.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { root, nm } = bigDepDir();
      const dest = tmp();
      const x = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "ignore"] });
      const xin = x.stdin;
      if (!xin) throw new Error("tar -x has no stdin");
      const extracted = new Promise<void>((resolve, reject) => {
        x.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extract exited ${code}`))));
        x.on("error", reject);
      });

      const { stream, done } = createDepSnapshotTar(root, "node_modules");
      // First readable byte ⇒ tar has already read the root's directory listing and
      // is now streaming members, blocked on a stdout nobody is draining yet.
      await once(stream, "readable");
      fs.mkdirSync(path.join(nm, ".vite"));
      stream.pipe(xin);

      await Promise.all([done, extracted]); // `done` RESOLVES — this is the fix
      // The archive is sound: only the transient top-level entry is absent.
      expect(fs.readFileSync(path.join(dest, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;");
      expect(fs.statSync(path.join(dest, "big.bin")).size).toBe(4 * 1024 * 1024);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/tolerated a dep-dir root race/);
    } finally {
      warn.mockRestore();
    }
  });

  it("still rejects when a MEMBER's own bytes change mid-read", async () => {
    // The boundary of the tolerance: a member rewritten under the read may be torn
    // in the archive (tar writes exactly the stat'd size), and this base is SHARED
    // by every future session of the repo. Declining is the correct outcome.
    const { root, big } = bigDepDir();
    const { stream, done } = createDepSnapshotTar(root, "node_modules");
    await once(stream, "readable"); // tar is inside `big.bin` — it is the only bulk
    const fd = fs.openSync(big, "r+");
    fs.writeSync(fd, Buffer.from([9]), 0, 1, 0);
    fs.closeSync(fd);
    stream.resume();
    await expect(done).rejects.toThrow(/big\.bin: file changed as we read it/);
  });
});

describe("isTolerableTarRace", () => {
  it("tolerates the dep-dir root race — the dominant production stderr", () => {
    expect(isTolerableTarRace("tar: .: file changed as we read it\n")).toBe(true);
    expect(isTolerableTarRace(
      "tar: .: file changed as we read it\ntar: Exiting with failure status due to previous errors\n",
    )).toBe(true);
  });

  it("stays fatal for a warning naming a member INSIDE the dep dir", () => {
    // The other stderr variant observed in production. A package file rewritten
    // mid-read means a concurrent install is restructuring the tree — never a base.
    expect(isTolerableTarRace("tar: ./deep-eql/index.js: file changed as we read it\n")).toBe(false);
    expect(isTolerableTarRace("tar: ./.vite: file changed as we read it\n")).toBe(false);
    // One tolerable line does not launder an intolerable one beside it.
    expect(isTolerableTarRace(
      "tar: .: file changed as we read it\ntar: ./deep-eql/index.js: file changed as we read it\n",
    )).toBe(false);
  });

  it("stays fatal for anything that is not that warning", () => {
    expect(isTolerableTarRace("")).toBe(false);
    expect(isTolerableTarRace("tar: Exiting with failure status due to previous errors\n")).toBe(false);
    expect(isTolerableTarRace("tar: /workspace/node_modules: Cannot open: No such file or directory\n")).toBe(false);
    expect(isTolerableTarRace("tar: ./x: File removed before we read it\n")).toBe(false);
    // A stderr truncated mid-line by the 8 KiB cap must not squeak through.
    expect(isTolerableTarRace("tar: .: file changed as we re")).toBe(false);
  });
});
