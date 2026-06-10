import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { extractTarStream } from "./overlay-snapshot.js";

/** Stream a directory's CONTENTS as a tar (mirrors the worker dep-snapshot producer). */
function tarContents(dir: string): Readable {
  const proc = spawn("tar", ["-c", "-f", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
  if (!proc.stdout) throw new Error("tar produced no stdout");
  return proc.stdout;
}

describe("extractTarStream", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-extract-"));
    tmpDirs.push(d);
    return d;
  }

  it("extracts a tar stream's contents directly into the destination (no wrapper dir)", async () => {
    const src = tmp();
    fs.mkdirSync(path.join(src, "a"), { recursive: true });
    fs.writeFileSync(path.join(src, "a", "x.js"), "X");
    fs.writeFileSync(path.join(src, "top.txt"), "TOP");

    const dest = tmp();
    await extractTarStream(tarContents(src), dest);

    expect(fs.readFileSync(path.join(dest, "a", "x.js"), "utf8")).toBe("X");
    expect(fs.readFileSync(path.join(dest, "top.txt"), "utf8")).toBe("TOP");
  });

  it("creates the destination directory if it does not exist", async () => {
    const src = tmp();
    fs.writeFileSync(path.join(src, "f"), "1");
    const dest = path.join(tmp(), "nested", "dest");

    await extractTarStream(tarContents(src), dest);

    expect(fs.existsSync(path.join(dest, "f"))).toBe(true);
  });

  it("rejects when the input stream is not a valid tar", async () => {
    const { Readable } = await import("node:stream");
    const bad = Readable.from([Buffer.from("not a tar archive at all")]);
    await expect(extractTarStream(bad, tmp())).rejects.toThrow();
  });
});
