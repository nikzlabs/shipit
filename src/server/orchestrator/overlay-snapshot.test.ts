import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { extractTarStream, fetchDepSnapshotStream } from "./overlay-snapshot.js";

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
    const bad = Readable.from([Buffer.from("not a tar archive at all")]);
    await expect(extractTarStream(bad, tmp())).rejects.toThrow();
  });

  it("rejects (never emits an unhandled error) when the source dies mid-stream", async () => {
    const src = new Readable({ read() {} });
    src.push(Buffer.alloc(4096));
    setTimeout(() => src.destroy(new Error("worker container killed")), 10);

    await expect(extractTarStream(src, tmp())).rejects.toThrow(/worker container killed/);
  });

  it("rejects (never hangs) when the source already errored before extraction starts", async () => {
    const src = new Readable({ read() {} });
    src.on("error", () => {});
    src.destroy(new Error("terminated"));
    await delay(10);

    await expect(extractTarStream(src, tmp())).rejects.toThrow(/terminated/);
  });
});

describe("fetchDepSnapshotStream: worker dies mid-stream", () => {
  let server: http.Server;
  let workerUrl: string;
  let tarBytes: Buffer;
  let dest: string;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown): void => { uncaught.push(err); };

  beforeEach(async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-kill-src-"));
    fs.writeFileSync(path.join(src, "big.js"), "x".repeat(512 * 1024));
    tarBytes = execFileSync("tar", ["-c", "-f", "-", "-C", src, "."], { maxBuffer: 8 << 20 });
    fs.rmSync(src, { recursive: true, force: true });
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-kill-dest-"));

    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-tar" });
      res.write(tarBytes.subarray(0, 8192), () => res.socket?.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    workerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Keep the test worker alive so an escaped error fails an assertion.
    uncaught.length = 0;
    process.on("uncaughtException", onUncaught);
  });

  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    fs.rmSync(dest, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("surfaces the mid-stream kill as a rejection from extractTarStream", async () => {
    const stream = await fetchDepSnapshotStream(workerUrl, "node_modules");

    await expect(extractTarStream(stream, dest)).rejects.toThrow();
    await delay(50);
    expect(uncaught).toEqual([]);
  });

  it("stays crash-free when the socket dies before the consumer attaches", async () => {
    const stream = await fetchDepSnapshotStream(workerUrl, "node_modules");
    await delay(150);

    await expect(extractTarStream(stream, dest)).rejects.toThrow();
    expect(uncaught).toEqual([]);
  });

  it("aborts the in-flight pull when the signal fires (session disposed)", async () => {
    const controller = new AbortController();
    const stream = await fetchDepSnapshotStream(workerUrl, "node_modules", controller.signal);
    const extracting = extractTarStream(stream, dest);
    controller.abort(new Error("session runner disposed"));

    await expect(extracting).rejects.toThrow();
    await delay(50);
    expect(uncaught).toEqual([]);
  });

  it("aborts before the request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("session runner disposed"));

    await expect(fetchDepSnapshotStream(workerUrl, "node_modules", controller.signal)).rejects.toThrow();
    expect(uncaught).toEqual([]);
  });
});
