import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LogStore } from "./log-store.js";

describe("LogStore", () => {
  let root: string;
  let store: LogStore;

  function flush(): Promise<void> {
    return store.drain();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "logstore-"));
    store = new LogStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips agent entries through snapshotEntries", async () => {
    store.appendEntry("s1", "agent", { ts: "2026-01-01T00:00:00.000Z", source: "stdout", text: "hello" });
    store.appendEntry("s1", "agent", { ts: "2026-01-01T00:00:01.000Z", source: "stderr", text: "oops" });
    await flush();

    const entries = store.snapshotEntries("s1", "agent");
    expect(entries).toEqual([
      { ts: "2026-01-01T00:00:00.000Z", source: "stdout", text: "hello" },
      { ts: "2026-01-01T00:00:01.000Z", source: "stderr", text: "oops" },
    ]);
  });

  it("round-trips raw service text through snapshotText", async () => {
    store.append("s1", "service:web", "line one\n");
    store.append("s1", "service:web", "line two\n");
    await flush();

    expect(store.snapshotText("s1", "service:web")).toBe("line one\nline two\n");
  });

  it("isolates channels and sessions", async () => {
    store.appendEntry("s1", "agent", { ts: "t", source: "server", text: "a-agent" });
    store.append("s1", "service:web", "a-web\n");
    store.appendEntry("s2", "agent", { ts: "t", source: "server", text: "b-agent" });
    await flush();

    expect(store.snapshotEntries("s1", "agent").map((e) => e.text)).toEqual(["a-agent"]);
    expect(store.snapshotText("s1", "service:web")).toBe("a-web\n");
    expect(store.snapshotEntries("s2", "agent").map((e) => e.text)).toEqual(["b-agent"]);
    expect(store.snapshotEntries("s1", "agent").map((e) => e.text)).not.toContain("b-agent");
  });

  it("rotates at the cap and a snapshot spans rotated + active", async () => {
    const chunk = `${"x".repeat(100_000)}\n`;
    for (let i = 0; i < 15; i++) store.append("s1", "service:big", chunk);
    await flush();

    const active = path.join(root, "s1", "logs", "service-big.log");
    const rotated = `${active}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.statSync(active).size).toBeLessThanOrEqual(1_000_000);
    const snap = store.snapshotText("s1", "service:big");
    expect(snap.length).toBeLessThanOrEqual(1_000_000);
    expect(snap.length).toBeGreaterThan(0);
  });

  it("clear() empties a channel; remove() drops the whole logs dir", async () => {
    store.appendEntry("s1", "agent", { ts: "t", source: "server", text: "keep?" });
    store.append("s1", "service:web", "svc\n");
    await flush();

    store.clear("s1", "agent");
    await flush();
    expect(store.snapshotEntries("s1", "agent")).toEqual([]);
    expect(store.snapshotText("s1", "service:web")).toBe("svc\n");

    store.remove("s1");
    expect(fs.existsSync(path.join(root, "s1", "logs"))).toBe(false);
  });

  it("tolerates a torn last line", async () => {
    const dir = path.join(root, "s1", "logs");
    await fsp.mkdir(dir, { recursive: true });
    const good = JSON.stringify({ ts: "t", source: "stdout", text: "intact" });
    await fsp.writeFile(path.join(dir, "agent.jsonl"), `${good}\n{"ts":"t","source":"std`);

    const entries = store.snapshotEntries("s1", "agent");
    expect(entries.map((e) => e.text)).toEqual(["intact"]);
  });

  it("survives a fresh LogStore over the same dir (durability)", async () => {
    store.appendEntry("s1", "agent", { ts: "t", source: "server", text: "before restart" });
    await flush();

    const reopened = new LogStore(root);
    expect(reopened.snapshotEntries("s1", "agent").map((e) => e.text)).toEqual(["before restart"]);
  });
});
