import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
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
});
