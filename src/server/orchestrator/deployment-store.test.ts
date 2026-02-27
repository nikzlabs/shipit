import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DeploymentStore } from "./deployment-store.js";
import type { DeploymentRecord } from "../shared/types.js";

describe("DeploymentStore", () => {
  let tmpDir: string;
  let store: DeploymentStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-store-"));
    store = new DeploymentStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Credentials
  // ------------------------------------------------------------------

  it("saves and loads config", () => {
    store.saveConfig("session-1", {
      targetId: "vercel",
      credentials: { token: "tok_abc" },
      projectName: "my-app",
    });

    const loaded = store.loadConfig("session-1", "vercel");
    expect(loaded).toMatchObject({
      targetId: "vercel",
      credentials: { token: "tok_abc" },
      projectName: "my-app",
    });
  });

  it("returns null for unconfigured target", () => {
    expect(store.loadConfig("session-1", "vercel")).toBeNull();
  });

  it("overwrites existing config", () => {
    store.saveConfig("s1", { targetId: "v", credentials: { token: "old" } });
    store.saveConfig("s1", { targetId: "v", credentials: { token: "new" } });

    const loaded = store.loadConfig("s1", "v");
    expect(loaded?.credentials.token).toBe("new");
  });

  it("deletes config", () => {
    store.saveConfig("s1", { targetId: "v", credentials: { token: "x" } });
    store.deleteConfig("s1", "v");
    expect(store.loadConfig("s1", "v")).toBeNull();
  });

  it("deleteConfig is idempotent (no throw if already deleted)", () => {
    expect(() => store.deleteConfig("nope", "nope")).not.toThrow();
  });

  it("lists configured targets", () => {
    store.saveConfig("s1", { targetId: "vercel", credentials: { token: "a" } });
    store.saveConfig("s1", { targetId: "cloudflare", credentials: { token: "b" } });

    const targets = store.listConfiguredTargets("s1");
    expect(targets).toHaveLength(2);
    expect(targets.sort()).toEqual(["cloudflare", "vercel"]);
  });

  it("lists empty for unconfigured session", () => {
    expect(store.listConfiguredTargets("no-such-session")).toEqual([]);
  });

  // ------------------------------------------------------------------
  // History
  // ------------------------------------------------------------------

  it("records and retrieves deployment history", () => {
    const record: DeploymentRecord = {
      id: "d1",
      targetId: "vercel",
      environment: "production",
      url: "https://my-app.vercel.app",
      commitHash: "abc123",
      commitMessage: "Initial",
      timestamp: "2025-01-01T00:00:00Z",
      durationMs: 5000,
      status: "success",
    };

    store.recordDeployment("s1", record);
    const history = store.getHistory("s1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "d1",
      url: "https://my-app.vercel.app",
      status: "success",
    });
  });

  it("appends to existing history", () => {
    const r1: DeploymentRecord = {
      id: "d1", targetId: "v", environment: "production", url: "u1",
      timestamp: "2025-01-01T00:00:00Z", durationMs: 100, status: "success",
    };
    const r2: DeploymentRecord = {
      id: "d2", targetId: "v", environment: "preview", url: "u2",
      timestamp: "2025-01-02T00:00:00Z", durationMs: 200, status: "success",
    };

    store.recordDeployment("s1", r1);
    store.recordDeployment("s1", r2);

    const history = store.getHistory("s1");
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("d1");
    expect(history[1].id).toBe("d2");
  });

  it("returns empty array for no history", () => {
    expect(store.getHistory("no-session")).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Session cleanup
  // ------------------------------------------------------------------

  it("deleteSession removes configs and history", () => {
    store.saveConfig("s1", { targetId: "v", credentials: { token: "x" } });
    store.recordDeployment("s1", {
      id: "d1", targetId: "v", environment: "production", url: "u",
      timestamp: "2025-01-01T00:00:00Z", durationMs: 100, status: "success",
    });

    store.deleteSession("s1");

    expect(store.loadConfig("s1", "v")).toBeNull();
    expect(store.listConfiguredTargets("s1")).toEqual([]);
    expect(store.getHistory("s1")).toEqual([]);
  });

  it("deleteSession is idempotent", () => {
    expect(() => store.deleteSession("nonexistent")).not.toThrow();
  });

  // ------------------------------------------------------------------
  // Isolation between sessions
  // ------------------------------------------------------------------

  it("keeps sessions isolated", () => {
    store.saveConfig("s1", { targetId: "v", credentials: { token: "a" } });
    store.saveConfig("s2", { targetId: "v", credentials: { token: "b" } });

    expect(store.loadConfig("s1", "v")?.credentials.token).toBe("a");
    expect(store.loadConfig("s2", "v")?.credentials.token).toBe("b");

    store.deleteSession("s1");
    // s2 should be unaffected
    expect(store.loadConfig("s2", "v")?.credentials.token).toBe("b");
  });
});
