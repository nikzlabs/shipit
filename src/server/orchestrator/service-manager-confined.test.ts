import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ComposeQuery, ComposeRunner, ServiceManagerOptions } from "./service-manager.js";
import { ComposeValidationError } from "./compose-generator.js";
import { ComposeHelperError } from "./compose-helper.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { composeStateDirForWorkspace, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";
import type { PluginComposeService } from "./plugin-compose.js";
import {
  FakeConfinedCompose,
  recordedOverride,
  recordedSnapshot,
  recordedStartFiles,
  startFiles,
  testServiceManager,
  type FakeConfinedOptions,
} from "./compose-test-helpers.js";

const SESSION = "test-session";
const PROJECT = composeProjectName(SESSION);

type Mapping = Record<string, unknown>;
interface Model {
  services: Record<string, Mapping>;
  volumes?: Record<string, Mapping>;
  secrets?: Record<string, Mapping>;
}

let sessionDir: string | undefined;

afterEach(() => {
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = undefined;
});

function setup(compose?: string): string {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-confined-"));
  const dir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  if (compose !== undefined) fs.writeFileSync(path.join(dir, "docker-compose.yml"), compose);
  return dir;
}

function noModelDir(dir: string): string {
  return path.join(composeStateDirForWorkspace(dir), "no-model");
}

interface Call { args: string[]; cwd: string }

function harness(dir: string, opts: {
  query?: (args: string[]) => string;
  /** Holds a Compose run open, to overlap it with another manager's work. */
  gate?: (args: string[]) => Promise<void> | undefined;
  makeFake?: (opts: FakeConfinedOptions) => FakeConfinedCompose;
  extra?: Partial<ServiceManagerOptions>;
} = {}) {
  const runs: Call[] = [];
  const queries: Call[] = [];
  const order: string[] = [];
  const runner: ComposeRunner = (args, cwd) => {
    runs.push({ args, cwd });
    if (args.includes("up")) order.push("up");
    return opts.gate?.(args) ?? Promise.resolve();
  };
  const composeQuery: ComposeQuery = (args, cwd) => {
    queries.push({ args, cwd });
    if (args[0] === "rm") order.push("rm");
    return Promise.resolve(opts.query?.(args) ?? "");
  };
  const fakeOpts: FakeConfinedOptions = {
    workspaceDir: dir,
    sessionId: SESSION,
    runner,
    buildRunner: () => { order.push("build"); return Promise.resolve(); },
  };
  const fake = opts.makeFake?.(fakeOpts) ?? new FakeConfinedCompose(fakeOpts);
  const mgr = testServiceManager({
    sessionId: SESSION,
    workspaceDir: dir,
    serviceEnvDir: path.join(path.dirname(dir), "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: runner,
    composeQuery,
    pollIntervalMs: 0,
    fakeConfined: fake,
    ...opts.extra,
  });
  return { mgr, fake, runs, queries, order };
}

function plugin(overrides: Partial<PluginComposeService> = {}): PluginComposeService {
  return {
    name: "probe",
    sourceName: "probe",
    alias: "probe",
    repo: "tools",
    plugin: "probe",
    preview: "auto",
    port: 4820,
    definition: { image: "node:22-alpine", command: "node server.mjs" },
    credentials: [],
    externalVolumes: [],
    self: false,
    ...overrides,
  };
}

const AUTO_WEB = "services:\n  web:\n    image: node:20\n    x-shipit-preview: auto\n";
const MANUAL_WEB = "services:\n  web:\n    image: node:20\n    x-shipit-preview: manual\n";

describe("the before-up sequence", () => {
  const STACK = `
services:
  web:
    build: .
    ports: ["3000:3000"]
    env_file: ./web.env
    label_file: ./web.labels
    volumes:
      - .:/app
      - ./sub:/x
    depends_on: [db]
  db:
    image: postgres:16
    x-shipit-preview: manual
  other:
    image: redis:7
    x-shipit-preview: manual
`;

  async function startStack() {
    const dir = setup(STACK);
    fs.writeFileSync(path.join(dir, "web.env"), "FROM_FILE=1\n");
    fs.writeFileSync(path.join(dir, "web.labels"), "com.example.team=web\n");
    fs.mkdirSync(path.join(dir, "sub"));
    const h = harness(dir, {
      extra: {
        workspaceVolume: "shipit-ws",
        workspaceSubpath: "sessions/test-session/workspace",
        resolveWorkspaceDevice: () => Promise.resolve("/daemon/ws"),
      },
    });
    h.mgr.setPluginServices([plugin()]);
    await h.mgr.start();
    return { dir, ...h };
  }

  it("resolves only the named project services, with the plugin stubs on stdin", async () => {
    const { fake } = await startStack();

    expect(fake.configs.map((c) => c.services)).toEqual([["web"]]);
    expect(parseYaml(fake.configs[0].stdin!)).toEqual({ services: { probe: { image: "node:22-alpine" } } });
  });

  it("writes the resolved model with workspace binds as volume subpaths", async () => {
    const { dir } = await startStack();

    const snapshot = parseYaml(recordedSnapshot(dir, "web")) as Model;
    expect(Object.keys(snapshot.services).sort()).toEqual(["db", "web"]);
    const web = snapshot.services.web;
    expect(web.volumes).toEqual([
      { type: "volume", source: "shipit-workspace", target: "/app", volume: { subpath: "sessions/test-session/workspace" } },
      { type: "volume", source: "shipit-session-workspace", target: "/x", volume: { subpath: "sub" } },
    ]);
    expect(snapshot.volumes?.["shipit-workspace"]).toEqual({ name: "shipit-ws", external: true });
    expect(snapshot.volumes?.["shipit-session-workspace"]).toMatchObject({
      driver_opts: { type: "none", o: "bind", device: "/daemon/ws" },
    });
    expect(web.environment).toMatchObject({ FROM_FILE: "1" });
    for (const key of ["env_file", "label_file", "ports"]) expect(web[key]).toBeUndefined();
  });

  it("builds the built services before up, then starts without pulling them", async () => {
    const { dir, fake, order } = await startStack();

    expect(order).toEqual(["build", "up"]);
    expect(fake.builds.map((b) => b.services)).toEqual([["web"]]);
    const buildModel = parseYaml(fake.builds[0].buildModel) as Model;
    expect(buildModel.services.web.build).toMatchObject({ context: dir });
    expect(buildModel.services.probe).toEqual({ image: "node:22-alpine" });

    const override = parseYaml(recordedOverride(dir, "web"), { logLevel: "error" }) as Model;
    expect(Object.keys(override.services).sort()).toEqual(["db", "probe", "web"]);
    expect(override.services.web.pull_policy).toBe("never");
    expect(override.services.db.pull_policy).toBeUndefined();
  });

  it("starts from this start's files, never with --build or --remove-orphans", async () => {
    const { dir, fake, runs } = await startStack();

    const files = recordedStartFiles(dir, "web");
    expect(fake.ups).toHaveLength(1);
    expect(fake.ups[0]).toMatchObject({
      services: ["web", "probe"],
      snapshotFile: files.snapshot,
      overrideFile: files.override,
    });
    const args = runs.flatMap((r) => r.args);
    expect(args).not.toContain("--build");
    expect(args).not.toContain("--remove-orphans");
  });

  // `config` prints `$` as `$$` (checked on Compose 5.5.1); the snapshot must escape it once, not twice.
  it("keeps a literal $ literal through config and the snapshot", async () => {
    const dir = setup("services:\n  web:\n    image: node:22\n    x-shipit-preview: auto\n    environment:\n      LIT: \"a$$b\"\n");
    const { mgr } = harness(dir);
    await mgr.start();

    const snapshot = recordedSnapshot(dir, "web");
    expect(snapshot).toContain("a$$b");
    expect(snapshot).not.toContain("a$$$$b");
  });

  it("copies a project secret file into ShipIt's state and names the copy", async () => {
    const dir = setup(
      "services:\n  web:\n    build: .\n    x-shipit-preview: auto\n    secrets: [tok]\n"
      + "secrets:\n  tok:\n    file: ./tok.txt\n",
    );
    fs.writeFileSync(path.join(dir, "tok.txt"), "s3cret");
    const { mgr, fake } = harness(dir);
    await mgr.start();

    const copies = path.join(composeStateDirForWorkspace(dir), "secrets");
    const copy = path.join(copies, "secrets-tok");
    expect(fake.reads).toContain(path.join(dir, "tok.txt"));
    expect(fs.readFileSync(copy, "utf-8")).toBe("s3cret");
    expect(fs.statSync(copies).mode & 0o777).toBe(0o700);
    expect((parseYaml(recordedSnapshot(dir, "web")) as Model).secrets?.tok.file).toBe(copy);
    expect((parseYaml(fake.builds[0].buildModel) as Model).secrets?.tok.file).toBe(path.join(dir, "tok.txt"));
  });
});

describe("a project secret copy with a workspace volume", () => {
  const SECRET_STACK = "services:\n  web:\n    build: .\n    x-shipit-preview: auto\n    secrets: [tok]\n"
    + "secrets:\n  tok:\n    file: ./tok.txt\n";

  // Compose would hand `file:` to the daemon as a bind source, and the copy has no host path.
  it("mounts the copy into the service as one file of the volume", async () => {
    const dir = setup(SECRET_STACK);
    fs.writeFileSync(path.join(dir, "tok.txt"), "s3cret");
    const { mgr } = harness(dir, {
      extra: { workspaceVolume: "shipit-ws", workspaceSubpath: `sessions/${SESSION}/workspace` },
    });
    await mgr.start();

    const snapshot = parseYaml(recordedSnapshot(dir, "web")) as Model;
    expect(snapshot.services.web.secrets).toEqual([]);
    expect(snapshot.services.web.volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/run/secrets/tok",
      read_only: true,
      volume: { subpath: `sessions/${SESSION}/state/compose/secrets/secrets-tok` },
    });
    expect(snapshot.volumes?.["shipit-workspace"]).toEqual({ name: "shipit-ws", external: true });
  });

  it("refuses the start when it cannot place the copy in the volume", async () => {
    const dir = setup(SECRET_STACK);
    fs.writeFileSync(path.join(dir, "tok.txt"), "s3cret");
    const { mgr, fake } = harness(dir, { extra: { workspaceVolume: "shipit-ws" } });
    await mgr.start().catch(() => {});
    expect(fake.ups).toEqual([]);
  });
});

describe("the plugin-only path", () => {
  it("starts a stack with no project file from the override alone", async () => {
    const dir = setup();
    const { mgr, fake } = harness(dir, { extra: { noProjectCompose: true } });
    mgr.setPluginServices([plugin()]);
    await mgr.start();

    expect(fake.configs).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(fake.ups).toHaveLength(1);
    expect(fake.ups[0].services).toEqual(["probe"]);
    expect(fake.ups[0].snapshotFile).toBeUndefined();
    expect(startFiles(dir)).toEqual([{ override: fake.ups[0].overrideFile }]);
  });

  it("skips the resolve when a start names only plugin services", async () => {
    const dir = setup(MANUAL_WEB);
    const { mgr, fake } = harness(dir);
    mgr.setPluginServices([plugin()]);
    await mgr.start();

    expect(fake.configs).toEqual([]);
    expect(fake.ups).toHaveLength(1);
    expect(fake.ups[0].services).toEqual(["probe"]);
    expect(fake.ups[0].snapshotFile).toBeUndefined();
    const override = parseYaml(fs.readFileSync(fake.ups[0].overrideFile, "utf-8")) as Model;
    expect(Object.keys(override.services)).toEqual(["probe"]);
  });
});

describe("stop", () => {
  it("stops a service from the files it was started from", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, runs } = harness(dir);
    await mgr.start();
    const { snapshot, override } = recordedStartFiles(dir, "web");
    runs.length = 0;

    await mgr.stopService("web");

    expect(runs).toEqual([{
      args: ["compose", "-f", snapshot!, "-f", override, "-p", PROJECT, "stop", "web"],
      cwd: composeStateDirForWorkspace(dir),
    }]);
  });

  it("stops without a model once the start's files are gone", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, runs } = harness(dir);
    await mgr.start();
    fs.rmSync(path.dirname(recordedStartFiles(dir, "web").override), { recursive: true, force: true });
    runs.length = 0;

    await mgr.stopService("web");

    expect(runs).toEqual([{ args: ["compose", "-p", PROJECT, "stop", "web"], cwd: noModelDir(dir) }]);
  });

  it("runs no stop for an unrecorded service with no container", async () => {
    const dir = setup(MANUAL_WEB);
    const { mgr, runs, queries } = harness(dir);
    await mgr.start();

    await mgr.stopService("web");

    expect(runs.filter((r) => r.args.includes("stop"))).toEqual([]);
    expect(queries.map((q) => q.args)).toContainEqual([
      "ps", "-aq",
      "--filter", `label=com.docker.compose.project=${PROJECT}`,
      "--filter", "label=com.docker.compose.service=web",
    ]);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("stops an unrecorded service's container without a model", async () => {
    const dir = setup(MANUAL_WEB);
    const { mgr, runs } = harness(dir, {
      query: (args) => (args.includes("-aq") && args.includes("label=com.docker.compose.service=web") ? "abc123\n" : ""),
    });
    await mgr.start();

    await mgr.stopService("web");

    expect(runs).toEqual([{ args: ["compose", "-p", PROJECT, "stop", "web"], cwd: noModelDir(dir) }]);
  });

  it("stops each running service from its files, then downs without a model", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, runs, queries } = harness(dir, {
      query: (args) => {
        if (args.includes("status=running")) return "web\n";
        if (args[0] === "volume" && args[1] === "ls") return `${PROJECT}_data\n`;
        return "";
      },
    });
    await mgr.start();
    const { snapshot, override } = recordedStartFiles(dir, "web");
    runs.length = 0;

    await mgr.stop({ removeVolumes: true });

    expect(runs).toEqual([
      {
        args: ["compose", "-f", snapshot!, "-f", override, "-p", PROJECT, "stop", "web"],
        cwd: composeStateDirForWorkspace(dir),
      },
      { args: ["compose", "-p", PROJECT, "down", "--remove-orphans", "--volumes"], cwd: noModelDir(dir) },
    ]);
    const queried = queries.map((q) => q.args);
    expect(queried).toContainEqual(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]);
    expect(queried).toContainEqual(["volume", "rm", `${PROJECT}_data`]);
    expect(startFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(composeStateDirForWorkspace(dir), "started-by.json"))).toBe(false);
  });

  it("leaves a second manager's in-flight start its files and record when a slow stop finishes", async () => {
    const dir = setup(AUTO_WEB);
    let releaseDown!: () => void;
    const downHeld = new Promise<void>((resolve) => { releaseDown = resolve; });
    const outgoing = harness(dir, {
      query: (args) => (args.includes("status=running") ? "web\n" : ""),
      gate: (args) => (args.includes("down") ? downHeld : undefined),
    });
    await outgoing.mgr.start();
    const stopped = outgoing.mgr.stop();

    let releaseUp!: () => void;
    const upHeld = new Promise<void>((resolve) => { releaseUp = resolve; });
    const incoming = harness(dir, { gate: (args) => (args.includes("up") ? upHeld : undefined) });
    const started = incoming.mgr.start();
    await vi.waitFor(() => expect(incoming.fake.ups).toHaveLength(1));
    const up = incoming.fake.ups[0];

    releaseDown();
    await stopped;

    expect(fs.existsSync(up.snapshotFile!)).toBe(true);
    expect(fs.existsSync(up.overrideFile)).toBe(true);

    releaseUp();
    await started;

    expect(recordedStartFiles(dir, "web")).toEqual({ snapshot: up.snapshotFile, override: up.overrideFile });
    expect(startFiles(dir)).toEqual([{ snapshot: up.snapshotFile, override: up.overrideFile }]);
    await incoming.mgr.stop();
  });

  it("keeps volumes on a plain stop", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, runs, queries } = harness(dir);
    await mgr.start();
    runs.length = 0;

    await mgr.stop();

    expect(runs.map((r) => r.args)).toEqual([["compose", "-p", PROJECT, "down", "--remove-orphans"]]);
    expect(queries.some((q) => q.args[0] === "volume")).toBe(false);
  });
});

describe("orphan removal", () => {
  const STACK = "services:\n  web:\n    image: node:20\n    x-shipit-preview: auto\n"
    + "  db:\n    image: postgres:16\n    x-shipit-preview: manual\n";
  const LISTING = [
    "p-web-1\tweb\tFalse",
    "p-db-1\tdb\tFalse",
    "p-probe-1\tprobe\tFalse",
    "p-gone-1\tgone\tFalse",
    "p-gone-run-1\tgone\tTrue",
  ].join("\n");
  const isListing = (args: string[]) =>
    args[0] === "ps" && args.includes("-a") && args.some((a) => a.startsWith("{{.Names}}"));

  it("removes, before up, containers of services the stack does not declare", async () => {
    const dir = setup(STACK);
    const { mgr, queries, order } = harness(dir, { query: (args) => (isListing(args) ? LISTING : "") });
    mgr.setPluginServices([plugin({ preview: "manual" })]);
    await mgr.start();

    expect(queries.filter((q) => q.args[0] === "rm").map((q) => q.args)).toEqual([["rm", "-f", "p-gone-1"]]);
    expect(order).toEqual(["rm", "up"]);
  });

  it("leaves other containers alone on a single-service start", async () => {
    const dir = setup(STACK);
    const { mgr, queries } = harness(dir, { query: (args) => (isListing(args) ? LISTING : "") });
    await mgr.start();
    queries.length = 0;

    await mgr.startService("db");

    expect(queries.filter((q) => isListing(q.args) || q.args[0] === "rm")).toEqual([]);
  });
});

class HeldConfig extends FakeConfinedCompose {
  entered = false;
  releaseConfig: () => void = () => {};
  private readonly held = new Promise<void>((resolve) => { this.releaseConfig = resolve; });

  override async config(req: Parameters<FakeConfinedCompose["config"]>[0]) {
    this.entered = true;
    await this.held;
    return super.config(req);
  }
}

describe("a stop during the resolve", () => {
  it("builds and starts nothing, and the service stays stopped", async () => {
    const dir = setup("services:\n  web:\n    build: .\n    x-shipit-preview: manual\n");
    let fake!: HeldConfig;
    const { mgr, runs } = harness(dir, { makeFake: (o) => (fake = new HeldConfig(o)) });
    await mgr.start();

    const starting = mgr.startService("web");
    await vi.waitFor(() => expect(fake.entered).toBe(true));
    await mgr.stopService("web");
    fake.releaseConfig();
    await starting;
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.builds).toEqual([]);
    expect(fake.ups).toEqual([]);
    expect(runs.filter((r) => r.args.includes("up"))).toEqual([]);
    expect(mgr.getService("web")?.status).toBe("stopped");
    expect(startFiles(dir)).toEqual([]);
  });
});

class UnreadableProjectFile extends FakeConfinedCompose {
  override readProjectFile(): Promise<Buffer> {
    return Promise.reject(new ComposeHelperError("Reading docker-compose.yml failed: permission denied", "failed"));
  }
}

describe("a start that cannot be checked is refused", () => {
  function resolved(web: Mapping): string {
    return stringifyYaml({ name: PROJECT, services: { web: { image: "node:20", ...web } } });
  }

  it("when Compose cannot resolve the file", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, fake } = harness(dir);
    fake.nextConfig = new ComposeHelperError("service \"web\" refers to undefined volume data", "failed");

    const err = await mgr.start().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ComposeValidationError);
    expect((err as Error).message).toContain("undefined volume data");
    expect(mgr.projectComposeFailure?.message).toContain("undefined volume data");
    expect(fake.ups).toEqual([]);
  });

  it("when the file Compose read fails the raw checks", async () => {
    const dir = setup(MANUAL_WEB);
    const { mgr, fake } = harness(dir);
    await mgr.start();
    fs.writeFileSync(
      path.join(dir, "docker-compose.yml"),
      "include:\n  - other.yml\nservices:\n  web:\n    image: node:20\n",
    );

    await expect(mgr.startService("web")).rejects.toThrow("`include:` is not supported");

    expect(fake.configs).toHaveLength(1);
    expect(mgr.projectComposeFailure?.kind).toBe("refused");
    expect(fake.ups).toEqual([]);
  });

  it.each([
    ["a bind source outside the workspace", { volumes: [{ type: "bind", source: "/etc", target: "/x" }] }, /outside this session's workspace/],
    ["provider", { provider: { type: "model" } }, /`provider` is not allowed/],
    ["an undeclared named volume", { volumes: [{ type: "volume", source: "data", target: "/d" }] }, /not declared/],
    ["an unresolved env_file", { env_file: ["./app.env"] }, /did not resolve `env_file`/],
  ])("when the resolved model holds %s", async (_what, web: Mapping, reason) => {
    const dir = setup(AUTO_WEB);
    const { mgr, fake } = harness(dir);
    fake.nextConfig = resolved(web);

    await expect(mgr.start()).rejects.toThrow(reason);

    expect(mgr.projectComposeFailure?.kind).toBe("refused");
    expect(fake.ups).toEqual([]);
    expect(startFiles(dir)).toEqual([]);
  });

  it("when an interpolated source resolves outside the workspace", async () => {
    const dir = setup("services:\n  web:\n    image: node:20\n    x-shipit-preview: auto\n    volumes:\n      - $SRC:/x\n");
    const { mgr, fake } = harness(dir, {
      makeFake: (o) => new FakeConfinedCompose({ ...o, env: { SRC: "/etc" } }),
    });

    await expect(mgr.start()).rejects.toThrow("bind mount source `/etc` is outside this session's workspace");
    expect(fake.ups).toEqual([]);
  });

  it("when the Compose helper cannot run", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, fake } = harness(dir);
    fake.nextConfig = new ComposeHelperError("ShipIt's Compose helper image is not available", "unavailable");

    await expect(mgr.start()).rejects.toThrow("ShipIt's Compose helper image is not available");

    expect(fake.ups).toEqual([]);
    expect(mgr.getService("web")?.status).toBe("error");
  });

  it("when the project file cannot be read", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, fake } = harness(dir, { makeFake: (o) => new UnreadableProjectFile(o) });

    const err = await mgr.start().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ComposeValidationError);
    expect((err as Error).message).toContain("permission denied");
    expect(mgr.projectComposeFailure?.message).toContain("permission denied");
    expect(fake.configs).toEqual([]);
    expect(fake.ups).toEqual([]);
  });
});

describe("status polling", () => {
  it("queries by project name, with no model file", async () => {
    const dir = setup(AUTO_WEB);
    const { mgr, queries } = harness(dir);
    await mgr.start();

    const polls = queries.filter((q) => q.args[0] === "compose");
    expect(polls.length).toBeGreaterThan(0);
    for (const { args, cwd } of polls) {
      expect(args.slice(0, 4)).toEqual(["compose", "-p", PROJECT, "ps"]);
      expect(args).not.toContain("-f");
      expect(cwd).toBe(noModelDir(dir));
    }
    expect(fs.readdirSync(noModelDir(dir))).toEqual([]);
  });
});
