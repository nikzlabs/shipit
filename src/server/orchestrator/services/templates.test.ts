/**
 * docs/128 — service-level applyTemplate tests focused on the ops session path:
 * the server-authoritative kind="ops" must be stamped before any container can
 * boot, and the privileged template can only ever create a *fresh* session.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTemplate } from "./templates.js";
import { ServiceError } from "./types.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo } from "../../shared/types.js";

function fakeGitManager(): GitManager {
  return {
    init: async () => {},
    autoCommit: async () => {},
  } as unknown as GitManager;
}

interface FakeSessionState {
  kinds: Record<string, string>;
  sessions: Record<string, Partial<SessionInfo>>;
}

function fakeSessionManager(state: FakeSessionState): SessionManager {
  return {
    get: (id: string) =>
      state.sessions[id]
        ? ({ id, kind: state.kinds[id], ...state.sessions[id] } as SessionInfo)
        : undefined,
    setKind: (id: string, kind: string) => {
      state.kinds[id] = kind;
    },
  } as unknown as SessionManager;
}

describe("applyTemplate (service) — ops session", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function freshSessionDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-tmpl-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("stamps kind=ops and writes the privileged workspace on a fresh session", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    const createSessionDir = async (title: string) => {
      expect(title).toContain("Ops —");
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
    );

    // The server-authoritative kind was set.
    expect(state.kinds["new-sess"]).toBe("ops");
    expect(result.session?.kind).toBe("ops");
    // Privileged workspace files landed on disk.
    expect(fs.existsSync(path.join(sessionDir, "shipit.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "docker-compose.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(sessionDir, "shipit.yaml"), "utf-8")).toContain(
      "x-shipit-host-mounts",
    );
  });

  it("SECURITY: refuses to retrofit an existing session into an ops session", async () => {
    const state: FakeSessionState = {
      kinds: {},
      sessions: { "existing-sess": { id: "existing-sess", workspaceDir: "/tmp/whatever" } },
    };
    await expect(
      applyTemplate(
        fakeSessionManager(state),
        () => fakeGitManager(),
        async () => {
          throw new Error("should not create a fresh dir");
        },
        "ops",
        "existing-sess",
      ),
    ).rejects.toBeInstanceOf(ServiceError);
    // kind must not have been set on the existing session.
    expect(state.kinds["existing-sess"]).toBeUndefined();
  });

  it("seeds an investigation prompt and target-named title when given a targetSessionId", async () => {
    const state: FakeSessionState = {
      kinds: {},
      sessions: {
        "target-sess": {
          id: "target-sess",
          title: "Flaky checkout flow",
          branch: "fix/checkout",
          remoteUrl: "https://github.com/owner/shop.git",
        },
      },
    };
    const sessionDir = freshSessionDir();
    let createdTitle = "";
    const createSessionDir = async (title: string) => {
      createdTitle = title;
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
      undefined,
      "target-sess",
    );

    // Fresh ops session is still created (target is a reference, not retrofit).
    expect(state.kinds["new-sess"]).toBe("ops");
    // Named after its quarry, and the seed bakes in the concrete target id.
    expect(createdTitle).toBe("Ops — debug: Flaky checkout flow");
    expect(result.seedPrompt).toBeDefined();
    expect(result.seedPrompt).toContain("Flaky checkout flow");
    expect(result.seedPrompt).toContain("target-sess");
    expect(result.seedPrompt).toContain('--filter "name=target-sess"');
  });

  it("ignores an unknown targetSessionId and falls back to a generic ops session", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    let createdTitle = "";
    const createSessionDir = async (title: string) => {
      createdTitle = title;
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
      undefined,
      "does-not-exist",
    );

    expect(state.kinds["new-sess"]).toBe("ops");
    expect(result.seedPrompt).toBeUndefined();
    expect(createdTitle).toContain("Ops —");
    expect(createdTitle).not.toContain("debug:");
  });

  it("does NOT set kind for an ordinary template", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    const createSessionDir = async (title: string) => {
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "static-html",
    );

    expect(state.kinds["new-sess"]).toBeUndefined();
  });
});
