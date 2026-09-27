import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import type { SessionIdentity } from "../shared/session-identity.js";
import {
  mkdirAsSession,
  preparePersistDir,
  workspaceVolumeDaemonPath,
  type PersistPrepDeps,
  type RunAs,
} from "./compose-persist.js";

describe("preparePersistDir (docs/317)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function scratch(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-prep-"));
    return path.join(tmpDir, "scratch");
  }

  const self: SessionIdentity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  function deps(overrides: Partial<PersistPrepDeps> = {}): PersistPrepDeps & { acl: string[][] } {
    const acl: string[][] = [];
    return {
      acl,
      identity: () => self,
      mkdirAs: (dir) => fs.mkdirSync(dir, { recursive: true }),
      defaultAcl: (dirs) => acl.push([...dirs]),
      handsOff: () => true,
      ...overrides,
    };
  }

  it("creates /persist and every mounted subdirectory, which a volume subpath requires", () => {
    const dir = scratch();
    preparePersistDir(dir, ["", "verseshot", "media/clips", "verseshot"], deps());
    expect(fs.statSync(path.join(dir, "verseshot")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dir, "media", "clips")).isDirectory()).toBe(true);
  });

  it("makes the root group-writable and setgid, with a default ACL, like the workspace", () => {
    const dir = scratch();
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const d = deps();
    preparePersistDir(dir, [], d);
    expect(fs.statSync(dir).mode & 0o2070).toBe(0o2070);
    expect(d.acl).toEqual([[dir]]);
  });

  it("creates subdirectories as the session's own identity, never as ShipIt's", () => {
    const dir = scratch();
    const mkdirAs = vi.fn((target: string) => fs.mkdirSync(target, { recursive: true }));
    preparePersistDir(dir, ["verseshot"], deps({ mkdirAs }));
    expect(mkdirAs).toHaveBeenCalledWith(path.join(dir, "verseshot"), self);
  });

  it("leaves ownership alone where ShipIt runs without session identities", () => {
    const dir = scratch();
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const mkdirAs = vi.fn((target: string) => fs.mkdirSync(target, { recursive: true }));
    const d = deps({ handsOff: () => false, mkdirAs });
    preparePersistDir(dir, ["a"], d);
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o755);
    expect(d.acl).toEqual([]);
    expect(mkdirAs).toHaveBeenCalledWith(path.join(dir, "a"), null);
  });

  it("refuses a scratch root that is a symlink", () => {
    const dir = scratch();
    const elsewhere = path.join(tmpDir!, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, dir);
    expect(() => preparePersistDir(dir, [], deps())).toThrow(/not a directory/);
  });

  it("names the directory it could not create", () => {
    const dir = scratch();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "verseshot"), "a file, not a directory");
    expect(() => preparePersistDir(dir, ["verseshot/renders"], deps()))
      .toThrow(/Could not create \/persist\/verseshot\/renders/);
  });
});

describe("mkdirAsSession (docs/317)", () => {
  const owner: SessionIdentity = { uid: 2000042, gid: 1000 };

  function recorder(fail: Record<string, Error> = {}) {
    const calls: { command: string; args: string[]; owner: SessionIdentity }[] = [];
    const run: RunAs = (command, args, as) => {
      calls.push({ command, args, owner: as });
      if (fail[command]) throw fail[command];
    };
    return { calls, run };
  }

  it("as root, creates the directory and grants the session group write, all as the session", () => {
    const { calls, run } = recorder();
    mkdirAsSession("/s/scratch/verseshot", owner, { isRoot: () => true, run });
    expect(calls).toEqual([
      { command: "mkdir", args: ["-p", "--", "/s/scratch/verseshot"], owner },
      { command: "chmod", args: ["g+rwxs", "--", "/s/scratch/verseshot"], owner },
      { command: "setfacl", args: ["-d", "-m", "g::rwx", "--", "/s/scratch/verseshot"], owner },
    ]);
  });

  it("still mounts when only the group grant fails", () => {
    const { calls, run } = recorder({ setfacl: new Error("setfacl: not found") });
    expect(() => mkdirAsSession("/s/scratch/a", owner, { isRoot: () => true, run })).not.toThrow();
    expect(calls.map((c) => c.command)).toEqual(["mkdir", "chmod", "setfacl"]);
  });

  it("fails when the directory cannot be created", () => {
    const { run } = recorder({ mkdir: new Error("Not a directory") });
    expect(() => mkdirAsSession("/s/scratch/a", owner, { isRoot: () => true, run })).toThrow("Not a directory");
  });

  it("creates the directory directly when ShipIt cannot switch identity", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persist-mkdir-"));
    try {
      const { calls, run } = recorder();
      mkdirAsSession(path.join(tmp, "a", "b"), owner, { isRoot: () => false, run });
      expect(fs.statSync(path.join(tmp, "a", "b")).isDirectory()).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("workspaceVolumeDaemonPath (docs/317)", () => {
  function docker(inspect: () => Promise<{ Mountpoint?: string }>): Docker {
    return { getVolume: () => ({ inspect }) } as unknown as Docker;
  }

  it("maps a path inside the workspace volume onto the daemon's mountpoint", async () => {
    const inspect = vi.fn(() => Promise.resolve({ Mountpoint: "/var/lib/docker/volumes/ws/_data" }));
    const resolve = workspaceVolumeDaemonPath(docker(inspect), "ws");
    await expect(resolve("/workspace/sessions/s1/scratch"))
      .resolves.toBe("/var/lib/docker/volumes/ws/_data/sessions/s1/scratch");
    await resolve("/workspace/sessions/s2/scratch");
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("asks Docker again after a failed lookup", async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error("daemon busy"))
      .mockResolvedValue({ Mountpoint: "/data" });
    const resolve = workspaceVolumeDaemonPath(docker(inspect), "ws");
    await expect(resolve("/workspace/sessions/s1/scratch")).rejects.toThrow("daemon busy");
    await expect(resolve("/workspace/sessions/s1/scratch")).resolves.toBe("/data/sessions/s1/scratch");
  });

  it("refuses a path outside the workspace volume", async () => {
    const resolve = workspaceVolumeDaemonPath(docker(() => Promise.resolve({ Mountpoint: "/data" })), "ws");
    await expect(resolve("/etc/passwd")).rejects.toThrow(/not inside the workspace volume/);
    await expect(resolve("/workspace")).rejects.toThrow(/not inside the workspace volume/);
  });
});
