import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import { StubAuthManager, FakeClaudeProcess, createTestDatabaseManager } from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { CredentialStore } from "../credential-store.js";
import { versionAnchor } from "../services/update-notice.js";
import type { SystemInfo, UpdateNotice } from "../../shared/types.js";

/**
 * docs/304 — the server half of the update banner: the dismiss endpoint, that a
 * dismissal actually reaches disk, and the connect-time replay including the
 * `null` that tells a reconnecting viewer to drop a banner it should no longer
 * show. The component tests mock all of this away.
 */

/** Reads one SSE connection's opening burst and returns the events in it. */
function openEvents(port: number): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/api/events`, (res) => {
      let buffer = "";
      const done = (): void => {
        const events = new Map<string, unknown>();
        for (const chunk of buffer.split("\n\n")) {
          const name = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (name && data !== undefined) events.set(name, JSON.parse(data));
        }
        res.destroy();
        resolve(events);
      };
      res.on("data", (c: Buffer) => {
        buffer += c.toString();
        // The replay is written synchronously on connect; system_info is last.
        if (buffer.includes("event: update_notice")) done();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Holds a connection open past its replay and resolves with the NEXT event of
 * that name — the one a live broadcast has to deliver.
 */
function nextEventAfterOpen(
  port: number,
  eventName: string,
): { opened: Promise<void>; next: Promise<unknown> } {
  let markOpened: () => void = () => {};
  let deliver: (value: unknown) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const opened = new Promise<void>((resolve) => { markOpened = resolve; });
  const next = new Promise<unknown>((resolve, reject) => { deliver = resolve; fail = reject; });

  const req = http.request(`http://127.0.0.1:${port}/api/events`, (res) => {
    let buffer = "";
    let replayed = false;
    res.on("data", (c: Buffer) => {
      buffer += c.toString();
      // Each chunk is consumed once: re-scanning the whole buffer would read the
      // replay again and report it as the live event.
      const cut = buffer.lastIndexOf("\n\n");
      if (cut < 0) return;
      const complete = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const chunk of complete.split("\n\n")) {
        if (!new RegExp(`^event: ${eventName}$`, "m").test(chunk)) continue;
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (data === undefined) continue;
        if (!replayed) { replayed = true; markOpened(); continue; }
        res.destroy();
        deliver(JSON.parse(data));
        return;
      }
    });
    res.on("error", fail);
  });
  req.on("error", fail);
  req.end();
  return { opened, next };
}

describe("Integration: the update notice's server half", () => {
  let app: FastifyInstance;
  let dbManager: DatabaseManager;
  let tmpDir: string;
  let port: number;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-update-notice-"));
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // best effort
    }
  });

  /** The anchor the running orchestrator is using, taken from what it tells viewers. */
  async function runningAnchor(): Promise<string> {
    const events = await openEvents(port);
    return versionAnchor((events.get("system_info") as SystemInfo).version);
  }

  it("tells a connecting viewer there is nothing to show, rather than saying nothing", async () => {
    const events = await openEvents(port);
    expect(events.has("update_notice")).toBe(true);
    expect(events.get("update_notice")).toBeNull();
  });

  it("replays what the last check found", async () => {
    credentialStore.setUpdateNotice({
      anchor: await runningAnchor(),
      lastCheckedAt: new Date().toISOString(),
      result: { available: true, latestVersion: "v9.9.9" },
    });

    const notice = (await openEvents(port)).get("update_notice") as UpdateNotice;
    expect(notice).toEqual({ available: true, latestVersion: "v9.9.9", dismissed: false });
  });

  it("dismisses install-wide, writes it to disk, and replays the dismissal", async () => {
    const anchor = await runningAnchor();
    credentialStore.setUpdateNotice({
      anchor,
      lastCheckedAt: new Date().toISOString(),
      result: { available: true, latestVersion: "v9.9.9" },
    });

    const res = await app.inject({ method: "POST", url: "/api/updates/dismiss" });
    expect(res.statusCode).toBe(200);
    expect(res.json().notice).toEqual({ available: true, latestVersion: "v9.9.9", dismissed: true });

    // A second viewer — a different device, or this one after a reload.
    expect((await openEvents(port)).get("update_notice")).toEqual({
      available: true, latestVersion: "v9.9.9", dismissed: true,
    });
    // And a restart: the record is on disk, not only in this process.
    expect(new CredentialStore(tmpDir).getUpdateNotice(anchor)?.dismissed).toBe(true);
  });

  it("reaches a device that is already looking at the banner", async () => {
    credentialStore.setUpdateNotice({
      anchor: await runningAnchor(),
      lastCheckedAt: new Date().toISOString(),
      result: { available: true, latestVersion: "v9.9.9" },
    });

    // The other device: connected and watching before the dismissal happens, so
    // the replay cannot be what tells it. Only a live broadcast can.
    const watching = nextEventAfterOpen(port, "update_notice");
    await watching.opened;
    await app.inject({ method: "POST", url: "/api/updates/dismiss" });

    expect(await watching.next).toEqual({ available: true, latestVersion: "v9.9.9", dismissed: true });
  });

  it("stops replaying a notice once the install runs different code", async () => {
    credentialStore.setUpdateNotice({
      anchor: "a-build-nobody-is-running",
      dismissed: true,
      result: { available: true, latestVersion: "v9.9.9" },
    });

    expect((await openEvents(port)).get("update_notice")).toBeNull();
  });
});
