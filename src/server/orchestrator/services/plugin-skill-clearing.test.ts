import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { PLUGIN_SKILL_MARKER, PLUGIN_SKILL_MARKER_ID } from "../../shared/plugin-skill-marker.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import {
  pluginSkillCopiesGone,
  presentPluginSkillCopies,
  restorePluginSkills,
  retryClearingPluginSkills,
} from "./plugin-skill-clearing.js";

const COPY = "plugins--tools--probe-0123456789ab";
const STAGING = `.${COPY}.staging-1a2b3c4d`;
const REFUSAL = "error: Updating the following directories would lose untracked files in them:\n"
  + "\t.claude/skills\n\nAborting\n";

let tmpDir: string;
let workDir: string;
let git: GitManager;
let origGitConfigGlobal: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-skill-clearing-"));
  workDir = path.join(tmpDir, "work");
  fs.mkdirSync(path.join(workDir, ".claude/skills"), { recursive: true });
  origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  initGlobalGitConfig(path.join(tmpDir, "credentials"));
  setGitIdentity("Test User", "test@test.com");
  execSync("git init -q", { cwd: workDir, stdio: "pipe" });
  git = new GitManager(workDir);
});

afterEach(() => {
  if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
  else delete process.env.GIT_CONFIG_GLOBAL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeOwnedDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, PLUGIN_SKILL_MARKER),
    JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID, source: "/checkout/skills/probe", name: path.basename(dir) }),
  );
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# copy\n");
  return dir;
}

const inRoot = (name: string) => path.join(workDir, ".claude/skills", name);

// Refuses the way git 2.39 does, for as long as `blocked` says so.
function refusingStep(blocked: () => boolean) {
  return vi.fn(() => (blocked() ? Promise.reject(new Error(REFUSAL)) : Promise.resolve("done")));
}

describe("retryClearingPluginSkills", () => {
  it("leaves the copies alone when git does not refuse", async () => {
    writeOwnedDir(inRoot(COPY));
    const step = refusingStep(() => false);

    await expect(retryClearingPluginSkills(git, workDir, step)).resolves.toBe("done");

    expect(step).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(inRoot(COPY))).toBe(true);
  });

  it("after a refusal, removes the copies and staging dirs and runs the step again", async () => {
    writeOwnedDir(inRoot(COPY));
    writeOwnedDir(inRoot(STAGING));
    const step = refusingStep(() => fs.existsSync(inRoot(COPY)) || fs.existsSync(inRoot(STAGING)));

    await expect(retryClearingPluginSkills(git, workDir, step)).resolves.toBe("done");

    expect(step).toHaveBeenCalledTimes(2);
  });

  it("does not sweep for a failure that is not an untracked-files refusal", async () => {
    writeOwnedDir(inRoot(COPY));
    const step = vi.fn(() => Promise.reject(new Error("fatal: Unable to create '/w/.git/index.lock': File exists.")));

    await expect(retryClearingPluginSkills(git, workDir, step)).rejects.toThrow(/index\.lock/);

    expect(step).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(inRoot(COPY))).toBe(true);
  });

  it("rethrows the refusal when it has no copy to remove", async () => {
    const step = refusingStep(() => true);

    await expect(retryClearingPluginSkills(git, workDir, step)).rejects.toThrow(/would lose untracked files/);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("stops after two sweeps when a prepare pass keeps putting a copy back", async () => {
    const step = vi.fn(() => {
      writeOwnedDir(inRoot(COPY));
      return Promise.reject(new Error(REFUSAL));
    });

    await expect(retryClearingPluginSkills(git, workDir, step)).rejects.toThrow(/would lose untracked files/);

    expect(step).toHaveBeenCalledTimes(3);
  });

  it("never removes a tracked copy, a directory without the marker, or one that resolves outside the workspace", async () => {
    const tracked = writeOwnedDir(inRoot("plugins--tracked--probe-ba9876543210"));
    execSync("git add -A && git commit -q -m 'Commit a copy by hand'", { cwd: workDir, stdio: "pipe" });
    const foreign = inRoot("plugins--mine--notes-0123456789ab");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "todo.md"), "mine\n");
    // A second harness root that is a symlink out of the workspace.
    const outside = writeOwnedDir(path.join(tmpDir, "outside", "plugins--far--probe-0123456789ab"));
    fs.mkdirSync(path.join(workDir, ".codex"));
    fs.symlinkSync(path.dirname(outside), path.join(workDir, ".codex/skills"));
    writeOwnedDir(inRoot(COPY));
    const step = refusingStep(() => true);

    await expect(retryClearingPluginSkills(git, workDir, step)).rejects.toThrow(/would lose untracked files/);

    expect(fs.existsSync(inRoot(COPY))).toBe(false);
    expect(fs.existsSync(path.join(tracked, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(foreign, "todo.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(outside, "SKILL.md"))).toBe(true);
  });
});

describe("restoring the copies", () => {
  it("reports a copy gone only when one recorded before is missing, and ignores staging dirs", () => {
    writeOwnedDir(inRoot(COPY));
    writeOwnedDir(inRoot(STAGING));
    const before = presentPluginSkillCopies(workDir);

    expect(before).toEqual([inRoot(COPY)]);
    expect(pluginSkillCopiesGone(before)).toBe(false);
    fs.rmSync(inRoot(COPY), { recursive: true });
    expect(pluginSkillCopiesGone(before)).toBe(true);
  });

  it("waits for the worker's prepare pass, and survives one that fails or a session without a runner", async () => {
    let finish: () => void = () => {};
    const prepare = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;

    const restore = (async () => {
      await restorePluginSkills({ preparePlugins: prepare });
      settled = true;
    })();
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    finish();
    await restore;

    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restorePluginSkills({ preparePlugins: () => Promise.reject(new Error("worker gone")) }))
      .resolves.toBeUndefined();
    await expect(restorePluginSkills(undefined)).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
