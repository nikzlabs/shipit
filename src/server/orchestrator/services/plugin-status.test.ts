import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPluginStatus, type PluginStatusSnapshot } from "./plugin-status.js";
import { writeInstallRecord } from "../plugin-install-record.js";
import { pluginsRoot } from "../plugin-generations.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";

let sessionDir: string;
let workspaceDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-status-"));
  workspaceDir = path.join(sessionDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function recordFor(repo: string, outcome: Parameters<typeof writeInstallRecord>[2]["outcome"], detail?: string): void {
  writeInstallRecord(pluginsRoot(sessionStateDirForWorkspace(workspaceDir)), repo, {
    commit: "a".repeat(40),
    at: "2026-08-16T10:00:00.000Z",
    outcome,
    ...(detail ? { detail } : {}),
  });
}

const ACTIVE: PluginStatusSnapshot = {
  warnings: [],
  repos: [{
    name: "tools",
    source: "acme/dev-tools",
    ref: "branch main",
    commit: "a".repeat(40),
    status: "active",
    issues: [],
  }],
};

describe("buildPluginStatus", () => {
  it("calls an active repository whose install NEVER RAN unusable", async () => {
    recordFor("tools", "not-run", "`web` declares an install command, which this runtime cannot run.");
    const result = buildPluginStatus(workspaceDir, ACTIVE);

    expect(result.repos[0]!.usable).toBe(false);
    expect(result.repos[0]!.installSummary).toContain("NOT RUN");
  });

  it("calls an active repository whose install FAILED unusable, and quotes the output", async () => {
    recordFor("tools", "failed", "install for `web` exited 1\nnpm ERR! missing script: build");
    const result = buildPluginStatus(workspaceDir, ACTIVE);

    expect(result.repos[0]!.usable).toBe(false);
    expect(result.repos[0]!.install?.detail).toContain("npm ERR!");
  });

  it("does not condemn the live version for a FAILED attempt on another commit", async () => {
    writeInstallRecord(pluginsRoot(sessionStateDirForWorkspace(workspaceDir)), "tools", {
      commit: "b".repeat(40),
      at: "2026-08-16T11:00:00.000Z",
      outcome: "failed",
      detail: "install for `web` exited 1",
    });
    const result = buildPluginStatus(workspaceDir, ACTIVE);

    expect(result.repos[0]!.usable).toBe(true);
    expect(result.repos[0]!.installSummary).toContain("different version");
  });

  it("carries a successful install's OUTPUT through to the caller", async () => {
    writeInstallRecord(pluginsRoot(sessionStateDirForWorkspace(workspaceDir)), "tools", {
      commit: "a".repeat(40),
      at: "2026-08-16T10:00:00.000Z",
      outcome: "succeeded",
      output: "added 41 packages\nbuilt dist/index.js",
    });
    const repo = buildPluginStatus(workspaceDir, ACTIVE).repos[0]!;

    expect(repo.install?.output).toContain("built dist/index.js");
    expect(repo.installSummary).toContain("--json");
  });

  it("says an absent record has two causes rather than reading as fine", async () => {
    const summary = buildPluginStatus(workspaceDir, ACTIVE).repos[0]!.installSummary;
    expect(summary).toContain("either this repository declares no install");
  });

  it("does NOT call a skipped install a failure", async () => {
    recordFor("tools", "skipped-store");
    expect(buildPluginStatus(workspaceDir, ACTIVE).repos[0]!.usable).toBe(true);
  });

  it("treats an active repository that has never installed anything as usable", async () => {
    expect(buildPluginStatus(workspaceDir, ACTIVE).repos[0]!.usable).toBe(true);
    expect(buildPluginStatus(workspaceDir, ACTIVE).repos[0]!.install).toBeNull();
  });

  it("carries every reason the card would show, unchanged (req 10)", async () => {
    const withIssues: PluginStatusSnapshot = {
      warnings: ["`plugins.use[0]` has an unknown key `setting`"],
      repos: [{
        ...ACTIVE.repos[0]!,
        status: "degraded",
        issues: ["command `reqs` withheld: two plugins claim the name", "its service fragment was refused"],
      }],
    };
    const result = buildPluginStatus(workspaceDir, withIssues);

    expect(result.repos[0]!.issues).toHaveLength(2);
    expect(result.repos[0]!.usable).toBe(false);
    expect(result.warnings).toEqual(["`plugins.use[0]` has an unknown key `setting`"]);
  });

  it("reports `repo: self` as usable and says no install runs there", async () => {
    recordFor("dev", "failed", "this should not be read");
    const result = buildPluginStatus(workspaceDir, {
      warnings: [],
      repos: [{ name: "dev", source: "self", ref: null, commit: null, status: "self", issues: [] }],
    });

    expect(result.repos[0]!.usable).toBe(true);
    expect(result.repos[0]!.install).toBeNull();
    expect(result.repos[0]!.installSummary).toContain("agent.install");
  });

  it("filters to a named repository, and names the declared ones for a typo", async () => {
    const two: PluginStatusSnapshot = {
      warnings: [],
      repos: [ACTIVE.repos[0]!, { ...ACTIVE.repos[0]!, name: "other" }],
    };
    expect(buildPluginStatus(workspaceDir, two, "other").repos.map((r) => r.repo)).toEqual(["other"]);

    const missing = buildPluginStatus(workspaceDir, two, "ghost");
    expect(missing.repos).toEqual([]);
    expect(missing.error).toContain("`tools`");
    expect(missing.error).toContain("`other`");
  });

  it("still describes the declaration when there is no resolvable state dir", async () => {
    const result = buildPluginStatus(path.join(sessionDir, "gone", "workspace"), ACTIVE);
    expect(result.repos[0]!.repo).toBe("tools");
    expect(result.repos[0]!.install).toBeNull();
  });
});
