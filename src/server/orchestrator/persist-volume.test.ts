import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treeBytes } from "./data-retention-sweep.js";
import { withPersistLease } from "./persist-gate.js";
import {
  BOOT_ID,
  BOOT_LABEL,
  PERSIST_HELPER_LABEL,
  PERSIST_LAYOUT_FILE,
  PERSIST_SCRIPTS,
  PersistVolumes,
  persistLayout,
  persistVolumeLabels,
  persistVolumeName,
  restartKeptServices,
  type PersistScript,
} from "./persist-volume.js";
import { CLEANUP_CONTAINER_SESSION_ID } from "./shipit-own-sessions.js";
import { SESSION_VOLUME_RE } from "./startup-janitor.js";

const WS_VOLUME = "shipit_workspace";
const SID = "0b5e2a8c-1d2f-4c3b-9a8e-7f6d5c4b3a21";
const OTHER = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const VOLUME = `shipit-persist.${WS_VOLUME}.${SID}`;
const PROJECT = `shipit-${SID.slice(0, 12)}`;

interface HelperRun {
  script: PersistScript;
  opts: Docker.ContainerCreateOptions;
}

interface Outcome {
  code: number;
  stdout?: string;
  stderr?: string;
}

interface Listed {
  Id: string;
  Labels: Record<string, string>;
  State: string;
}

interface FakeVolume {
  Name: string;
  Driver: string;
  Options: Record<string, string> | null;
  Labels: Record<string, string>;
  CreatedAt: string;
}

/** Docker as far as persist-volume.ts uses it; a helper script answers through `onRun`. */
class FakeDocker {
  volumes = new Map<string, FakeVolume>();
  stuckContainers = new Set<string>();
  containers: Listed[] = [];
  runs: HelperRun[] = [];
  removedContainers: string[] = [];
  removedVolumes: string[] = [];
  failVolumeRemoval = new Set<string>();
  onRun: (run: HelperRun) => Outcome | Promise<Outcome> = () => ({ code: 0 });
  private next = 0;

  // Docker keeps an existing volume as it is, labels included.
  createVolume = vi.fn(async (opts: { Name: string; Labels: Record<string, string> }) => {
    if (!this.volumes.has(opts.Name)) {
      this.volumes.set(opts.Name, { Name: opts.Name, Driver: "local", Options: null, Labels: opts.Labels, CreatedAt: new Date().toISOString() });
    }
    return {};
  });

  addVolume(name: string, createdAt: string, labels: Record<string, string> = {}): void {
    this.volumes.set(name, { Name: name, Driver: "local", Options: null, Labels: labels, CreatedAt: createdAt });
  }

  getVolume(name: string) {
    return {
      inspect: async () => {
        if (!this.volumes.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        return this.volumes.get(name);
      },
      remove: async () => {
        if (this.failVolumeRemoval.has(name)) throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
        if (!this.volumes.delete(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        this.removedVolumes.push(name);
      },
    };
  }

  async listVolumes(opts: { filters: { name: string[] } }) {
    const [needle] = opts.filters.name;
    return { Volumes: [...this.volumes.values()].filter((v) => v.Name.includes(needle)) };
  }

  async listContainers(opts: { filters?: { label?: string[] } }) {
    const wanted = opts.filters?.label ?? [];
    return this.containers.filter((c) => wanted.every((w) => {
      const [k, v] = w.split("=");
      return v === undefined ? k in c.Labels : c.Labels[k] === v;
    }));
  }

  async listNetworks() {
    return [];
  }

  getContainer(id: string) {
    return {
      id,
      stop: async () => undefined,
      inspect: async () => {
        if (!this.containers.some((c) => c.Id === id)) throw Object.assign(new Error("gone"), { statusCode: 404 });
        return {};
      },
      remove: async () => {
        if (this.stuckContainers.has(id)) throw Object.assign(new Error("cannot kill"), { statusCode: 500 });
        const before = this.containers.length;
        this.containers = this.containers.filter((c) => c.Id !== id);
        if (this.containers.length === before) throw Object.assign(new Error("gone"), { statusCode: 404 });
        this.removedContainers.push(id);
      },
    };
  }

  async createContainer(opts: Docker.ContainerCreateOptions) {
    const id = `helper${++this.next}`;
    const script = (Object.keys(PERSIST_SCRIPTS) as PersistScript[])
      .find((name) => PERSIST_SCRIPTS[name].text === opts.Cmd?.[0]);
    if (!script) throw new Error("unknown helper script");
    const run: HelperRun = { script, opts };
    this.runs.push(run);
    this.containers.push({ Id: id, Labels: opts.Labels ?? {}, State: "running" });
    let outcome: Outcome = { code: 0 };
    return {
      id,
      start: async () => { outcome = await this.onRun(run); },
      wait: async () => ({ StatusCode: outcome.code }),
      kill: async () => undefined,
      logs: async (o: { stdout?: boolean }) => Buffer.from(o.stdout ? outcome.stdout ?? "" : outcome.stderr ?? ""),
      remove: async () => {
        this.containers = this.containers.filter((c) => c.Id !== id);
      },
    };
  }
}

let root: string;
let sessionDir: string;
let docker: FakeDocker;
let volumes: PersistVolumes;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-volume-"));
  sessionDir = path.join(root, "sessions", SID);
  fs.mkdirSync(sessionDir, { recursive: true });
  docker = new FakeDocker();
  volumes = new PersistVolumes({
    docker: docker as unknown as Docker,
    workspaceVolume: WS_VOLUME,
    image: "shipit-session-worker:test",
    stackName: "prod",
    workspaceRoot: root,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const recordFile = (): string => path.join(sessionDir, PERSIST_LAYOUT_FILE);
const scratch = (): string => path.join(sessionDir, "scratch");

function withScratchFiles(): void {
  fs.mkdirSync(scratch(), { recursive: true });
  fs.writeFileSync(path.join(scratch(), "notes.txt"), "kept");
}

const runsOf = (script: PersistScript): HelperRun[] => docker.runs.filter((r) => r.script === script);

describe("the volume name and labels (docs/331)", () => {
  it("names the install's workspace volume and the session", () => {
    expect(persistVolumeName(WS_VOLUME, SID)).toBe(VOLUME);
    expect(volumes.sessionIdOf(VOLUME)).toBe(SID);
    expect(volumes.sessionIdOf(`shipit-persist.other_workspace.${SID}`)).toBeNull();
    expect(volumes.sessionIdOf(`${PROJECT}_persist`)).toBeNull();
  });

  it.each(["shipit_workspace", "shipit-workspace", "shipit-abcdef123456_ws"])(
    "is never matched by the boot sweep of Compose volumes, with the workspace volume %s",
    (workspaceVolume) => {
      expect(SESSION_VOLUME_RE.test(`${PROJECT}_${workspaceVolume}`)).toBe(true);
      expect(SESSION_VOLUME_RE.test(persistVolumeName(workspaceVolume, SID))).toBe(false);
    },
  );

  it("carries no label that a removal path selects by", async () => {
    await volumes.ensureVolume(SID);
    const labels = docker.createVolume.mock.calls[0][0].Labels;
    expect(labels).toEqual(persistVolumeLabels("prod"));
    for (const forbidden of ["shipit-session", "shipit-parent-session", "com.docker.compose.project", "shipit-plugin-generation"]) {
      expect(labels).not.toHaveProperty(forbidden);
    }
    expect(labels).toEqual({ "shipit-managed": "true", "shipit-stack": "prod" });
  });
});

describe("persistLayout", () => {
  it("is the volume when the record says so", () => {
    fs.writeFileSync(recordFile(), "volume\n");
    expect(persistLayout(sessionDir)).toBe("volume");
  });

  it("is the volume when the record says so and scratch/ is still there", () => {
    fs.writeFileSync(recordFile(), "volume\n");
    fs.mkdirSync(scratch());
    expect(persistLayout(sessionDir)).toBe("volume");
  });

  it("gives a new session the volume and writes the record", () => {
    expect(persistLayout(sessionDir)).toBe("volume");
    expect(fs.readFileSync(recordFile(), "utf8")).toBe("volume\n");
  });

  it("keeps scratch/ authoritative until the record says volume", () => {
    fs.mkdirSync(scratch());
    expect(persistLayout(sessionDir)).toBe("scratch");
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it("does not guess when the record cannot be read", () => {
    fs.mkdirSync(recordFile());
    fs.mkdirSync(scratch());
    expect(() => persistLayout(sessionDir)).toThrow();
  });
});

describe("forAgent: the copy at the next start (req 5)", () => {
  it("gives a new session the volume and copies nothing", async () => {
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: VOLUME, restart: [] });
    expect(await volumes.forSession(SID, sessionDir).volume()).toBe(VOLUME);
    expect(docker.volumes.has(VOLUME)).toBe(true);
    expect(docker.runs).toEqual([]);
  });

  it("copies scratch/ from the workspace volume, and writes the record only after the flushed copy", async () => {
    withScratchFiles();
    let recordDuringCopy: boolean | undefined;
    docker.onRun = () => {
      recordDuringCopy = fs.existsSync(recordFile());
      return { code: 0, stdout: "8\t/new\n" };
    };
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: VOLUME, restart: [] });
    expect(runsOf("copy")).toHaveLength(1);
    expect(recordDuringCopy).toBe(false);
    expect(fs.readFileSync(recordFile(), "utf8")).toBe("volume\n");
    expect(fs.existsSync(scratch())).toBe(false);
    const text = PERSIST_SCRIPTS.copy.text;
    expect(text.indexOf("sync -f /new")).toBeGreaterThan(text.indexOf("cp -a /old/. /new/"));
  });

  it("stays on scratch/ when the copy fails, empties the volume, and copies again at the next start", async () => {
    withScratchFiles();
    docker.onRun = ({ script }) => (script === "copy" ? { code: 1, stderr: "No space left on device" } : { code: 0 });
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: null, restart: [] });
    expect(docker.runs.map((r) => r.script)).toEqual(["copy", "empty"]);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(fs.readFileSync(path.join(scratch(), "notes.txt"), "utf8")).toBe("kept");

    docker.onRun = () => ({ code: 0 });
    expect((await volumes.forAgent(SID, sessionDir)).volume).toBe(VOLUME);
    expect(runsOf("copy")).toHaveLength(2);
    // The second copy starts by wiping whatever the first one left.
    const text = PERSIST_SCRIPTS.copy.text;
    expect(text.indexOf("find /new -mindepth 1 -delete")).toBeLessThan(text.indexOf("cp -a"));
  });

  it("finishes the removal of scratch/ when the record already says volume, and never copies over the volume", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    withScratchFiles();
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: VOLUME, restart: [] });
    expect(docker.runs).toEqual([]);
    expect(fs.existsSync(scratch())).toBe(false);
  });

  it.each(["shipit-session-id", "shipit-parent-session", "shipit-compose-helper"])(
    "does not copy while a container labelled %s can still use /persist",
    async (label) => {
      withScratchFiles();
      docker.containers.push({ Id: "busy", Labels: { [label]: SID }, State: "exited" });
      expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: null, restart: [] });
      expect(docker.runs).toEqual([]);
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(fs.existsSync(scratch())).toBe(true);
    },
  );

  it("removes a persist helper that outlived its lease or its process before it copies", async () => {
    withScratchFiles();
    docker.containers.push({ Id: "stale", Labels: { [PERSIST_HELPER_LABEL]: SID, "shipit-stack": "prod" }, State: "running" });
    docker.onRun = () => {
      expect(docker.containers.some((c) => c.Id === "stale")).toBe(false);
      return { code: 0 };
    };
    expect((await volumes.forAgent(SID, sessionDir)).volume).toBe(VOLUME);
    expect(docker.removedContainers).toContain("stale");
  });

  it("does not copy while a leftover persist helper cannot be removed", async () => {
    withScratchFiles();
    docker.containers.push({ Id: "stuck", Labels: { [PERSIST_HELPER_LABEL]: SID, "shipit-stack": "prod" }, State: "running" });
    docker.stuckContainers.add("stuck");
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: null, restart: [] });
    expect(docker.runs).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it("keeps the record when only the flush of the directory fails, and mounts the volume", async () => {
    withScratchFiles();
    const real = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      calls += 1;
      // The record file is flushed first, then its directory.
      if (calls === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
      real(fd);
    });
    expect((await volumes.forAgent(SID, sessionDir)).volume).toBe(VOLUME);
    expect(persistLayout(sessionDir)).toBe("volume");
    expect(fs.existsSync(scratch())).toBe(false);
  });

  it("starts the removed services again when the copy fails after their removal", async () => {
    withScratchFiles();
    docker.containers.push({
      Id: "web1",
      Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": "web", "shipit-stack": "prod" },
      State: "running",
    });
    docker.createVolume.mockRejectedValueOnce(new Error("disk full"));
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: null, restart: ["web"] });
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it("leaves the Compose stack of another install alone", async () => {
    withScratchFiles();
    docker.containers.push(
      { Id: "ours", Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": "api", "shipit-stack": "prod" }, State: "running" },
      { Id: "theirs", Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": "web", "shipit-stack": "other" }, State: "running" },
    );
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: VOLUME, restart: ["api"] });
    expect(docker.removedContainers).toEqual(["ours"]);
  });

  it("removes a helper of an earlier process before a mount, and leaves this process's own", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    docker.containers.push(
      { Id: "earlier", Labels: { [PERSIST_HELPER_LABEL]: SID, [BOOT_LABEL]: "earlier", "shipit-stack": "prod" }, State: "running" },
      { Id: "mine", Labels: { [PERSIST_HELPER_LABEL]: SID, [BOOT_LABEL]: BOOT_ID, "shipit-stack": "prod" }, State: "running" },
    );
    expect(await volumes.forSession(SID, sessionDir).volume()).toBe(VOLUME);
    expect(docker.removedContainers).toEqual(["earlier"]);
  });

  it("refuses a mount while a helper that can still write cannot be removed", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    docker.containers.push({ Id: "earlier", Labels: { [PERSIST_HELPER_LABEL]: SID, "shipit-stack": "prod" }, State: "running" });
    docker.stuckContainers.add("earlier");
    await expect(volumes.forSession(SID, sessionDir).volume()).rejects.toThrow(/can still write could not be removed/);
  });

  it("checks for stale helpers one start at a time, so two starts do not refuse each other", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    docker.containers.push({ Id: "earlier", Labels: { [PERSIST_HELPER_LABEL]: SID, "shipit-stack": "prod" }, State: "exited" });
    const getContainer = docker.getContainer.bind(docker);
    let removals = 0;
    docker.getContainer = (id: string) => {
      const c = getContainer(id);
      return {
        ...c,
        remove: async () => {
          removals += 1;
          // Docker answers 409 to a second removal while the first is in progress.
          if (removals > 1) throw Object.assign(new Error("removal already in progress"), { statusCode: 409 });
          await new Promise((r) => setTimeout(r, 10));
          await c.remove();
        },
      };
    };
    const persist = volumes.forSession(SID, sessionDir);
    expect(await Promise.all([persist.volume(), persist.volume()])).toEqual([VOLUME, VOLUME]);
    expect(removals).toBe(1);
  });

  it("removes, in the same check, a helper that a run of this process fails to remove while the check runs", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    const persist = volumes.forSession(SID, sessionDir);
    await persist.volume();
    const realCreate = docker.createContainer.bind(docker);
    let failRemoval = true;
    docker.createContainer = async (opts) => {
      const c = await realCreate(opts);
      return { ...c, remove: async () => { if (failRemoval) throw new Error("daemon busy"); } };
    };
    await volumes.prepare(SID, VOLUME, null, ["a"]);
    const first = docker.containers.find((c) => c.Labels[PERSIST_HELPER_LABEL] === SID)!.Id;
    // While the check removes the first helper, a second run fails to remove its own.
    const getContainer = docker.getContainer.bind(docker);
    docker.getContainer = (id: string) => {
      const c = getContainer(id);
      return {
        ...c,
        remove: async () => {
          if (id === first) await volumes.prepare(SID, VOLUME, null, ["b"]);
          await c.remove();
        },
      };
    };
    await persist.volume();
    failRemoval = false;
    expect(docker.containers.filter((c) => c.Labels[PERSIST_HELPER_LABEL] === SID)).toEqual([]);
  });

  it("removes before the next mount a helper of this process that it could not remove at the end of its run", async () => {
    fs.writeFileSync(recordFile(), "volume\n");
    await volumes.forSession(SID, sessionDir).volume();
    const realCreate = docker.createContainer.bind(docker);
    docker.createContainer = async (opts) => {
      const c = await realCreate(opts);
      return { ...c, remove: async () => { throw new Error("daemon busy"); } };
    };
    await volumes.prepare(SID, VOLUME, null, ["plan"]);
    const helper = docker.containers.find((c) => c.Labels[PERSIST_HELPER_LABEL] === SID)!;
    expect(helper).toBeDefined();
    await volumes.forSession(SID, sessionDir).volume();
    expect(docker.removedContainers).toContain(helper.Id);
  });

  it("does not adopt a volume of that name that someone else made, and stays on scratch/", async () => {
    withScratchFiles();
    docker.addVolume(VOLUME, new Date().toISOString(), { "shipit-parent-session": OTHER });
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: null, restart: [] });
    expect(runsOf("copy")).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it("refuses to mount such a volume on the volume layout", async () => {
    docker.addVolume(VOLUME, new Date().toISOString(), { "shipit-session": OTHER });
    await expect(volumes.forSession(SID, sessionDir).volume()).rejects.toThrow(/will not use the volume.*shipit-session/);
  });

  it("removes a running Compose stack first and names its running services to start again", async () => {
    withScratchFiles();
    docker.containers.push(
      { Id: "web1", Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": "web", "shipit-stack": "prod" }, State: "running" },
      { Id: "db1", Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": "db", "shipit-stack": "prod" }, State: "exited" },
    );
    docker.onRun = () => {
      expect(docker.containers.filter((c) => c.Labels["com.docker.compose.project"])).toEqual([]);
      return { code: 0 };
    };
    expect(await volumes.forAgent(SID, sessionDir)).toEqual({ volume: VOLUME, restart: ["web"] });
    expect(docker.removedContainers).toEqual(expect.arrayContaining(["web1", "db1"]));
  });

  it("waits for a Compose start that holds the shared lease", async () => {
    withScratchFiles();
    let release!: () => void;
    const start = withPersistLease(SID, "shared", () => new Promise<void>((r) => { release = r; }));
    const agent = volumes.forAgent(SID, sessionDir);
    await new Promise((r) => setTimeout(r, 10));
    expect(docker.runs).toEqual([]);
    release();
    await start;
    expect((await agent).volume).toBe(VOLUME);
  });
});

describe("the helper containers", () => {
  it("run each script isolated, with only its own capabilities and the session's labels", async () => {
    withScratchFiles();
    await volumes.forAgent(SID, sessionDir);
    await volumes.prepare(SID, VOLUME, { uid: 2001, gid: 2001 }, ["plan", "media/clips"]);
    await volumes.measure(SID).catch(() => undefined);
    await volumes.empty(SID);
    const caps = Object.fromEntries(docker.runs.map((r) => [r.script, r.opts.HostConfig?.CapAdd]));
    expect(caps).toEqual({
      copy: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"],
      prepare: ["CHOWN", "FOWNER", "FSETID", "SETUID", "SETGID"],
      measure: ["DAC_READ_SEARCH"],
      empty: ["DAC_OVERRIDE", "FOWNER"],
    });
    for (const { opts } of docker.runs) {
      expect(opts.Image).toBe("shipit-session-worker:test");
      expect(opts.Entrypoint).toEqual(["/bin/sh", "-c"]);
      expect(opts.Labels).toEqual({ [PERSIST_HELPER_LABEL]: SID, [BOOT_LABEL]: BOOT_ID, "shipit-stack": "prod" });
      expect(opts.HostConfig).toMatchObject({
        NetworkMode: "none",
        CapDrop: ["ALL"],
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
      });
    }
  });

  it("mount scratch/ read-only beside the volume for the copy, and the volume alone otherwise", async () => {
    withScratchFiles();
    await volumes.forAgent(SID, sessionDir);
    docker.onRun = () => ({ code: 0, stdout: "0\n" });
    await volumes.measure(SID);
    const mounts = Object.fromEntries(docker.runs.map((r) => [r.script, r.opts.HostConfig?.Mounts]));
    expect(mounts.copy).toEqual([
      { Type: "volume", Source: WS_VOLUME, Target: "/old", ReadOnly: true, VolumeOptions: { Subpath: `sessions/${SID}/scratch` } },
      { Type: "volume", Source: VOLUME, Target: "/new", VolumeOptions: { NoCopy: true } },
    ]);
    expect(mounts.measure).toEqual([
      { Type: "volume", Source: VOLUME, Target: "/persist", ReadOnly: true, VolumeOptions: { NoCopy: true } },
    ]);
  });

  it("pass subdirectory names as arguments, never in the script text", async () => {
    await volumes.prepare(SID, VOLUME, { uid: 2001, gid: 2002 }, ["a b;rm -rf /", "a b;rm -rf /", ""]);
    const cmd = docker.runs[0].opts.Cmd!;
    expect(cmd[0]).toBe(PERSIST_SCRIPTS.prepare.text);
    expect(cmd.slice(1)).toEqual(["sh", "2001:2002", "a b;rm -rf /"]);
  });

  it("report a subdirectory that could not be made", async () => {
    docker.onRun = () => ({ code: 1, stderr: "mkdir: Permission denied" });
    await expect(volumes.prepare(SID, VOLUME, null, ["plan"])).rejects.toThrow(/\/persist\/plan.*Permission denied/);
  });
});

describe("measure and empty (docs/323 through the volume)", () => {
  it("refuse a volume of that name that ShipIt did not make", async () => {
    docker.addVolume(VOLUME, new Date().toISOString(), { "shipit-parent-session": OTHER });
    await expect(volumes.measure(SID)).rejects.toThrow(/will not use the volume/);
    await expect(volumes.empty(SID)).rejects.toThrow(/will not use the volume/);
    expect(docker.runs).toEqual([]);
  });

  it("measure a volume that does not exist yet as 0, with no helper", async () => {
    expect(await volumes.measure(SID)).toBe(0);
    await volumes.empty(SID);
    expect(docker.runs).toEqual([]);
  });

  it("read the size the helper sums", async () => {
    await volumes.ensureVolume(SID);
    docker.onRun = () => ({ code: 0, stdout: "123456\n" });
    expect(await volumes.measure(SID)).toBe(123456);
  });

  it("fail rather than report a size the helper could not measure", async () => {
    await volumes.ensureVolume(SID);
    docker.onRun = () => ({ code: 1, stderr: "find: Permission denied" });
    await expect(volumes.measure(SID)).rejects.toThrow(/Permission denied/);
    // A log that could not be read is not a size of 0.
    docker.onRun = () => ({ code: 0, stdout: "" });
    await expect(volumes.measure(SID)).rejects.toThrow(/Measuring/);
    docker.onRun = () => ({ code: 1 });
    await expect(volumes.empty(SID)).rejects.toThrow(/exit 1/);
  });
});

describe("the helper scripts, run on this host", () => {
  function run(script: PersistScript, paths: Record<string, string>, args: string[] = []): string {
    let text = PERSIST_SCRIPTS[script].text;
    for (const [from, to] of Object.entries(paths)) text = text.split(from).join(to);
    return execFileSync("/bin/sh", ["-c", text, "sh", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  it("measure counts by the rule of the scratch layout's treeBytes: symlinks and empty files included", async () => {
    const dir = path.join(root, "persist");
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(dir, "empty-dir"));
    fs.writeFileSync(path.join(dir, "a", "b", "big.bin"), Buffer.alloc(70_000, 1));
    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    fs.symlinkSync("/etc", path.join(dir, "link"));
    const out = run("measure", { "/persist": dir });
    expect(Number(out.trim())).toBe(await treeBytes(dir));
    expect(Number(out.trim())).toBeGreaterThan(70_000);
  });

  it("measure fails when the walk fails", () => {
    expect(() => run("measure", { "/persist": path.join(root, "missing") })).toThrow();
  });

  it("copy wipes a partial copy, keeps symlinks as symlinks, and gives the root the old root's mode", () => {
    const from = path.join(root, "old");
    const to = path.join(root, "new");
    fs.mkdirSync(path.join(from, "plan"), { recursive: true });
    fs.writeFileSync(path.join(from, "plan", "a.txt"), "A");
    fs.symlinkSync("../../..", path.join(from, "up"));
    fs.chmodSync(from, 0o750);
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "partial"), "stale");
    run("copy", { "/old": from, "/new": to });
    expect(fs.readdirSync(to).sort()).toEqual(["plan", "up"]);
    expect(fs.readFileSync(path.join(to, "plan", "a.txt"), "utf8")).toBe("A");
    expect(fs.readlinkSync(path.join(to, "up"))).toBe("../../..");
    expect(fs.statSync(to).mode & 0o7777).toBe(0o750);
  });

  it("empty deletes everything below the root and keeps the root", () => {
    const dir = path.join(root, "persist");
    fs.mkdirSync(path.join(dir, "x", "y"), { recursive: true });
    fs.writeFileSync(path.join(dir, "x", "y", "f"), "1");
    fs.symlinkSync("/", path.join(dir, "root-link"));
    run("empty", { "/persist": dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("prepare makes each named subdirectory literally, with no owner to hand over", () => {
    const dir = path.join(root, "persist");
    fs.mkdirSync(dir);
    run("prepare", { "/persist": dir }, ["", "plan", "a b;touch pwned"]);
    expect(fs.statSync(path.join(dir, "plan")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dir, "a b;touch pwned")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
  });
});

describe("Full reset", () => {
  it("removes each session's containers by label, then its volume, and keeps ShipIt's own session", async () => {
    await volumes.ensureVolume(SID);
    docker.addVolume(persistVolumeName(WS_VOLUME, CLEANUP_CONTAINER_SESSION_ID), new Date().toISOString());
    const ours = { "shipit-stack": "prod" };
    docker.containers.push(
      { Id: "agent", Labels: { "shipit-session-id": SID, ...ours }, State: "running" },
      { Id: "svc", Labels: { "shipit-parent-session": SID, ...ours }, State: "running" },
      { Id: "compose-helper", Labels: { "shipit-compose-helper": SID, ...ours }, State: "exited" },
      { Id: "persist-helper", Labels: { [PERSIST_HELPER_LABEL]: SID, ...ours }, State: "exited" },
      { Id: "cleanup", Labels: { "shipit-session-id": CLEANUP_CONTAINER_SESSION_ID, ...ours }, State: "running" },
    );
    await volumes.removeAllForReset();
    expect(docker.removedContainers.sort()).toEqual(["agent", "compose-helper", "persist-helper", "svc"]);
    expect(docker.removedVolumes).toEqual([VOLUME]);
    expect(docker.containers.map((c) => c.Id)).toEqual(["cleanup"]);
  });

  it("removes no container of another install, and then keeps the volume while one remains", async () => {
    await volumes.ensureVolume(SID);
    docker.containers.push({ Id: "theirs", Labels: { "shipit-session-id": SID, "shipit-stack": "other" }, State: "running" });
    await volumes.removeAllForReset();
    expect(docker.removedContainers).toEqual([]);
    expect(docker.volumes.has(VOLUME)).toBe(true);
  });

  it("goes on to the next session when one volume cannot be removed", async () => {
    await volumes.ensureVolume(SID);
    await volumes.ensureVolume(OTHER);
    docker.failVolumeRemoval.add(VOLUME);
    await volumes.removeAllForReset();
    expect(docker.removedVolumes).toEqual([persistVolumeName(WS_VOLUME, OTHER)]);
  });
});

describe("sweepOrphans", () => {
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();

  it("removes an old volume whose session has no row, and nothing else", async () => {
    docker.addVolume(VOLUME, old);
    docker.addVolume(persistVolumeName(WS_VOLUME, OTHER), old);
    docker.addVolume(persistVolumeName(WS_VOLUME, "4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a"), new Date().toISOString());
    docker.addVolume(persistVolumeName(WS_VOLUME, CLEANUP_CONTAINER_SESSION_ID), old);
    docker.addVolume(persistVolumeName("another_workspace", SID), old);
    expect(await volumes.sweepOrphans(new Set([OTHER]))).toBe(1);
    expect(docker.removedVolumes).toEqual([VOLUME]);
  });

  it("removes a persist helper a crash left behind, which would keep the volume in use", async () => {
    docker.addVolume(VOLUME, old);
    docker.containers.push({ Id: "left", Labels: { [PERSIST_HELPER_LABEL]: SID, "shipit-stack": "prod" }, State: "exited" });
    expect(await volumes.sweepOrphans(new Set())).toBe(1);
    expect(docker.removedContainers).toEqual(["left"]);
  });

  it("leaves a volume in use for the next pass", async () => {
    docker.addVolume(VOLUME, old);
    docker.failVolumeRemoval.add(VOLUME);
    expect(await volumes.sweepOrphans(new Set())).toBe(0);
    expect(docker.volumes.has(VOLUME)).toBe(true);
  });
});

describe("restartKeptServices", () => {
  it("starts each service the copy removed again, through the session's manager", async () => {
    const restartService = vi.fn(async () => undefined);
    const mgr = { getService: (name: string) => (name === "gone" ? undefined : { name }), restartService };
    restartKeptServices(mgr, SID, ["web", "gone", "worker"]);
    expect(restartService.mock.calls).toEqual([["web"], ["worker"]]);
    restartKeptServices(undefined, SID, ["web"]);
    expect(restartService).toHaveBeenCalledTimes(2);
  });
});
