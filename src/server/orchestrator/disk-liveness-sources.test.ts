import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { repoUrlToHash } from "./git-utils.js";
import { overlayScopeHash } from "./overlay-volume.js";
import { overlayRuntimeKey } from "./overlay-session.js";
import { overlayLiveScopeSource, pluginLiveArtifactSource } from "./disk-liveness-sources.js";

describe("disk liveness sources", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager | null = null;

  function setup(): SessionManager {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-liveness-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    return new SessionManager(dbManager);
  }

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertWarmSession(remoteUrl: string, workspaceDir?: string): void {
    dbManager!.db.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, workspace_dir, archived, warm)"
      + " VALUES (?, ?, ?, ?, ?, ?, 0, 1)",
    ).run(
      "dc4a9d74-a9b4-4741-8e20-9381a991b4f7", "Warm", "2026-08-18", "2026-08-18",
      remoteUrl, workspaceDir ?? null,
    );
  }

  it("counts a warm session's overlay base as live", () => {
    const sessionManager = setup();
    const remoteUrl = "https://github.com/nicolasalt/tanks.git";
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    insertWarmSession(remoteUrl, workspaceDir);

    const expected = overlayScopeHash(remoteUrl, overlayRuntimeKey(), "node_modules");

    expect(sessionManager.listAll()).toHaveLength(0);
    expect(overlayLiveScopeSource(sessionManager)()).toEqual(new Set([expected]));
  });

  it("counts a warm session's declared plugin repositories as live", async () => {
    const sessionManager = setup();
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "plugins:\n  repos:\n    - repo: acme/dev-tools\n      name: tools\n      branch: main\n",
    );
    insertWarmSession("https://github.com/nicolasalt/tanks.git", workspaceDir);

    const live = await pluginLiveArtifactSource(sessionManager)();

    expect(live.cacheHashes.has(repoUrlToHash("https://github.com/acme/dev-tools.git"))).toBe(true);
  });
});
