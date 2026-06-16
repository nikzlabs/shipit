/**
 * docs/211 — sandbox-session creation service. Verifies that the
 * server-authoritative `kind = "sandbox"` and the (normalized) capability set
 * are stamped at creation and survive a DB round-trip through `fromRow`. Uses a
 * real SessionManager over a temp DB so the column wiring + migration are
 * exercised end to end (not just a fake).
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { createSandboxSession } from "./templates.js";
import { DEFAULT_SANDBOX_CAPABILITIES } from "../../shared/types.js";

describe("createSandboxSession", () => {
  const tmpDirs: string[] = [];
  let dbManager: DatabaseManager | null = null;

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function setup() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-sess-"));
    tmpDirs.push(tmpDir);
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sm = new SessionManager(dbManager);
    // createSessionDir stand-in: registers the session row (as the real one
    // does) and returns an empty workspace dir — NO git init (the sandbox
    // invariant: no root repo).
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const createSessionDir = async (title: string) => {
      const id = "sandbox-1";
      sm.track(id, title, workspaceDir);
      return { appSessionId: id, sessionDir: workspaceDir, workspaceDir };
    };
    return { sm, createSessionDir, workspaceDir };
  }

  it("stamps kind=sandbox and the chosen capabilities, with no remoteUrl and no root .git", async () => {
    const { sm, createSessionDir, workspaceDir } = setup();
    const result = await createSandboxSession(sm, createSessionDir, {
      git: true,
      docker: false,
      network: false,
    });

    expect(result.session.kind).toBe("sandbox");
    expect(result.session.capabilities).toEqual({ git: true, docker: false, network: false });
    // Repo-less: no cached remote.
    expect(result.session.remoteUrl).toBe("");
    // The invariant: the empty workspace was NOT git-init'd.
    expect(fs.existsSync(path.join(workspaceDir, ".git"))).toBe(false);

    // Survives a DB round-trip (fromRow reads kind + parses capabilities JSON).
    const reread = sm.get(result.session.id);
    expect(reread?.kind).toBe("sandbox");
    expect(reread?.capabilities).toEqual({ git: true, docker: false, network: false });
  });

  it("applies the default capability set (network on, git/docker off) when none are sent", async () => {
    const { sm, createSessionDir } = setup();
    const result = await createSandboxSession(sm, createSessionDir);
    expect(result.capabilities).toEqual(DEFAULT_SANDBOX_CAPABILITIES);
    expect(result.session.capabilities).toEqual({ git: false, docker: false, network: true });
  });

  it("normalizes a partial capability payload against the defaults", async () => {
    const { sm, createSessionDir } = setup();
    // Only `docker` supplied — git/network fall back to defaults (off/on).
    const result = await createSandboxSession(sm, createSessionDir, { docker: true });
    expect(result.session.capabilities).toEqual({ git: false, docker: true, network: true });
  });

  it("does NOT set kind/capabilities on an ordinary tracked session", () => {
    const { sm } = setup();
    sm.track("ordinary", "Some repo session", "/tmp/whatever");
    const s = sm.get("ordinary");
    expect(s?.kind).toBeUndefined();
    expect(s?.capabilities).toBeUndefined();
  });
});
