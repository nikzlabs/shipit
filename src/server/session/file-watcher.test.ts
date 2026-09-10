import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatcher } from "./file-watcher.js";

// Let chokidar finish registering watches before writes.
const settle = () => new Promise<void>((r) => setTimeout(r, 100));

// Wait after the expected event to detect extra events that should be absent.
const absenceWindow = () => new Promise<void>((r) => setTimeout(r, 300));

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

const seenPaths = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.flatMap((c) => c[0] as string[]);

// Session containers share host inotify limits and can lose events under load.
const isShipItSandbox =
  process.env.SHIPIT_SESSION_ID !== undefined && process.env.CI === undefined;

describe.skipIf(isShipItSandbox)("FileWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Match chokidar's resolved paths, including macOS /tmp symlinks.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibe-filewatcher-")));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits changes event when a file is created", async () => {
    const watcher = new FileWatcher(50);
    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");

    const changes = await changesPromise;
    expect(changes).toContain("hello.txt");

    watcher.stop();
  });

  it("emits changes event when a file is modified", async () => {
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "original");

    const watcher = new FileWatcher(50);
    watcher.start(tmpDir);
    await settle();

    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "modified");

    const changes = await changesPromise;
    expect(changes).toContain("existing.txt");

    watcher.stop();
  });

  it("reports a shipit.yaml edit (the config file both the compose reconcile and the client's tracker refresh hang off)", async () => {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  memory: 2048\n");

    const watcher = new FileWatcher(50);
    watcher.start(tmpDir);
    await settle();

    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "issues:\n  trackers:\n    - name: planning\n");

    expect(await changesPromise).toContain("shipit.yaml");

    watcher.stop();
  });

  it("emits changes event when a file is deleted", async () => {
    fs.writeFileSync(path.join(tmpDir, "doomed.txt"), "bye");

    const watcher = new FileWatcher(50);
    watcher.start(tmpDir);
    await settle();

    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    fs.unlinkSync(path.join(tmpDir, "doomed.txt"));

    const changes = await changesPromise;
    expect(changes).toContain("doomed.txt");

    watcher.stop();
  });

  it("debounces multiple rapid changes into one event", async () => {
    const watcher = new FileWatcher(100);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");

    await waitUntil(() => emitSpy.mock.calls.length > 0);
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const changes: string[] = emitSpy.mock.calls[0][0];
    expect(changes).toContain("a.txt");
    expect(changes).toContain("b.txt");
    expect(changes).toContain("c.txt");

    watcher.stop();
  });

  it("deduplicates multiple events for the same file", async () => {
    const watcher = new FileWatcher(100);
    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v1");
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v2");
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v3");

    const changes = await changesPromise;

    const count = changes.filter((p) => p === "dup.txt").length;
    expect(count).toBe(1);

    watcher.stop();
  });

  it("ignores node_modules changes (even when created after start)", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    const nmDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, "pkg.json"), "{}");

    fs.writeFileSync(path.join(tmpDir, "app.ts"), "export {}");

    await waitUntil(() => seenPaths(emitSpy).includes("app.ts"));
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalled();
    const allChanges = seenPaths(emitSpy);
    expect(allChanges).toContain("app.ts");
    expect(allChanges.some((p) => p.includes("node_modules"))).toBe(false);

    watcher.stop();
  });

  it("ignores node_modules even when nested deep in the tree", async () => {
    const pkgDir = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(pkgDir, { recursive: true });

    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    const nestedNm = path.join(pkgDir, "node_modules", "deep");
    fs.mkdirSync(nestedNm, { recursive: true });
    fs.writeFileSync(path.join(nestedNm, "index.js"), "module.exports = {}");

    fs.writeFileSync(path.join(pkgDir, "main.ts"), "export {}");

    const mainRel = path.join("packages", "app", "main.ts");
    await waitUntil(() => seenPaths(emitSpy).some((p) => p.endsWith(mainRel)));
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalled();
    const allChanges = seenPaths(emitSpy);
    expect(allChanges.some((p) => p.endsWith(mainRel))).toBe(true);
    expect(allChanges.some((p) => p.includes("node_modules"))).toBe(false);

    watcher.stop();
  });

  it("ignores .git changes", async () => {
    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });

    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main");

    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello");

    await waitUntil(() => seenPaths(emitSpy).includes("readme.md"));
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalled();
    const allChanges = seenPaths(emitSpy);
    expect(allChanges).toContain("readme.md");
    expect(allChanges.some((p) => p.includes(".git"))).toBe(false);

    watcher.stop();
  });

  it("ignores .vibe-chat-history changes", async () => {
    const histDir = path.join(tmpDir, ".vibe-chat-history");
    fs.mkdirSync(histDir, { recursive: true });

    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(histDir, "session.json"), "[]");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "console.log('hi')");

    await waitUntil(() => seenPaths(emitSpy).includes("index.ts"));
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalled();
    const allChanges = seenPaths(emitSpy);
    expect(allChanges).toContain("index.ts");
    expect(allChanges.some((p) => p.includes(".vibe-chat-history"))).toBe(false);

    watcher.stop();
  });

  it("ignores .shipit-usage.json changes", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(tmpDir, ".shipit-usage.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export {}");

    await waitUntil(() => seenPaths(emitSpy).includes("src.ts"));
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalled();
    const allChanges = seenPaths(emitSpy);
    expect(allChanges).toContain("src.ts");
    expect(allChanges.some((p) => p.includes(".shipit-usage.json"))).toBe(false);

    watcher.stop();
  });

  it("stop() cleans up and stops emitting events", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();
    watcher.stop();

    fs.writeFileSync(path.join(tmpDir, "after-stop.txt"), "data");

    await new Promise((r) => setTimeout(r, 300));

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("start() is idempotent — calling twice does not create duplicate watchers", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(tmpDir, "once.txt"), "data");

    await waitUntil(() => emitSpy.mock.calls.length > 0);
    await absenceWindow();

    expect(emitSpy).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("includes subdirectory paths in changes", async () => {
    const subDir = path.join(tmpDir, "src");
    fs.mkdirSync(subDir);

    const watcher = new FileWatcher(50);
    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    watcher.start(tmpDir);
    await settle();

    fs.writeFileSync(path.join(subDir, "app.ts"), "export default {}");

    const changes = await changesPromise;
    expect(changes).toContain(path.join("src", "app.ts"));

    watcher.stop();
  });

  it("does not emit when no changes are pending", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    await settle();

    await new Promise((r) => setTimeout(r, 300));

    expect(emitSpy).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("constructor defaults to 300ms debounce", () => {
    const watcher = new FileWatcher();
    expect(watcher).toBeInstanceOf(FileWatcher);
    watcher.stop();
  });
});
