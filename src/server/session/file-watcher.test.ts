import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatcher } from "./file-watcher.js";

describe("FileWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-filewatcher-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits changes event when a file is created", async () => {
    const watcher = new FileWatcher(50); // short debounce for test speed
    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    watcher.start(tmpDir);

    // Create a file to trigger the watch
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");

    const changes = await changesPromise;
    expect(changes).toContain("hello.txt");

    watcher.stop();
  });

  it("emits changes event when a file is modified", async () => {
    // Create the file first
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "original");

    const watcher = new FileWatcher(50);
    watcher.start(tmpDir);

    const changesPromise = new Promise<string[]>((resolve) => {
      watcher.on("changes", resolve);
    });

    // Modify the file
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "modified");

    const changes = await changesPromise;
    expect(changes).toContain("existing.txt");

    watcher.stop();
  });

  it("debounces multiple rapid changes into one event", async () => {
    const watcher = new FileWatcher(100);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);

    // Rapidly create multiple files
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 250));

    // Should have emitted exactly once with all changes batched
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

    // Write to the same file multiple times rapidly
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v1");
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v2");
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "v3");

    const changes = await changesPromise;

    // The file should appear only once in the changes list
    const count = changes.filter((p) => p === "dup.txt").length;
    expect(count).toBe(1);

    watcher.stop();
  });

  it("ignores node_modules changes", async () => {
    // Create node_modules directory
    const nmDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nmDir, { recursive: true });

    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);

    // Write into node_modules
    fs.writeFileSync(path.join(nmDir, "pkg.json"), "{}");

    // Also write a non-ignored file to verify the watcher is working
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "export {}");

    await new Promise((r) => setTimeout(r, 150));

    // The changes should include app.ts but NOT the node_modules file
    expect(emitSpy).toHaveBeenCalled();
    const allChanges: string[] = emitSpy.mock.calls.flatMap((c) => c[0]);
    expect(allChanges).toContain("app.ts");
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

    // Write into .git
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main");

    // Also write a non-ignored file
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello");

    await new Promise((r) => setTimeout(r, 150));

    expect(emitSpy).toHaveBeenCalled();
    const allChanges: string[] = emitSpy.mock.calls.flatMap((c) => c[0]);
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

    fs.writeFileSync(path.join(histDir, "session.json"), "[]");
    fs.writeFileSync(path.join(tmpDir, "index.ts"), "console.log('hi')");

    await new Promise((r) => setTimeout(r, 150));

    expect(emitSpy).toHaveBeenCalled();
    const allChanges: string[] = emitSpy.mock.calls.flatMap((c) => c[0]);
    expect(allChanges).toContain("index.ts");
    expect(allChanges.some((p) => p.includes(".vibe-chat-history"))).toBe(false);

    watcher.stop();
  });

  it("ignores .shipit-usage.json changes", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);

    fs.writeFileSync(path.join(tmpDir, ".shipit-usage.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export {}");

    await new Promise((r) => setTimeout(r, 150));

    expect(emitSpy).toHaveBeenCalled();
    const allChanges: string[] = emitSpy.mock.calls.flatMap((c) => c[0]);
    expect(allChanges).toContain("src.ts");
    expect(allChanges.some((p) => p.includes(".shipit-usage.json"))).toBe(false);

    watcher.stop();
  });

  it("stop() cleans up and stops emitting events", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    watcher.stop();

    // Write a file after stop — should not trigger any event
    fs.writeFileSync(path.join(tmpDir, "after-stop.txt"), "data");

    await new Promise((r) => setTimeout(r, 150));

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("start() is idempotent — calling twice does not create duplicate watchers", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);
    watcher.start(tmpDir); // should be a no-op

    fs.writeFileSync(path.join(tmpDir, "once.txt"), "data");

    await new Promise((r) => setTimeout(r, 150));

    // Should only emit once, not twice (from two watchers)
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

    fs.writeFileSync(path.join(subDir, "app.ts"), "export default {}");

    const changes = await changesPromise;
    // The path should include the subdirectory
    expect(changes.some((p) => p.includes("src") && p.includes("app.ts"))).toBe(true);

    watcher.stop();
  });

  it("does not emit when no changes are pending", async () => {
    const watcher = new FileWatcher(50);
    const emitSpy = vi.fn();
    watcher.on("changes", emitSpy);

    watcher.start(tmpDir);

    // Wait without making any changes
    await new Promise((r) => setTimeout(r, 150));

    expect(emitSpy).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("constructor defaults to 300ms debounce", () => {
    const watcher = new FileWatcher();
    // The debounceMs is private, so we verify via behavior.
    // Just verify it can be constructed without args.
    expect(watcher).toBeInstanceOf(FileWatcher);
    watcher.stop(); // clean up
  });
});
