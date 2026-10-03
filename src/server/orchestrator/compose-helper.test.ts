import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import {
  COMPOSE_HELPER_LABEL,
  ComposeHelperError,
  ConfinedCompose,
  SERVICE_ENV_HOST_DIR_ENV,
  composeHelperDaemonPath,
  createHelperRunner,
  reapOrphanComposeHelpers,
  resolveComposeHelperImage,
  stageRegistryLogin,
  type ComposeHelperImage,
  type ConfinedComposeOptions,
  type HelperRunRequest,
  type HelperRunResult,
} from "./compose-helper.js";

const SID = "0123456789abcdef-0000";
const PROJECT = "shipit-0123456789ab";
const WS = `/workspace/sessions/${SID}/workspace`;
const SCRATCH = `/workspace/sessions/${SID}/scratch`;
const COMPOSE_DIR = `/workspace/sessions/${SID}/state/compose`;
const IMAGE_ID = "sha256:helper";
const READY: ComposeHelperImage = { status: "ready", name: "shipit-compose-helper:test", id: IMAGE_ID };
const ORCHESTRATOR_ENV = { HOME: "/root", PATH: "/usr/bin:/bin", DOCKER_CONTEXT: "ctx", GITHUB_TOKEN: "secret" };

function recorder(result: Partial<HelperRunResult> = {}) {
  const calls: HelperRunRequest[] = [];
  const run = vi.fn(async (req: HelperRunRequest): Promise<HelperRunResult> => {
    calls.push(req);
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", ...result };
  });
  return { calls, run };
}

function confined(run: ConfinedComposeOptions["run"], extra: Partial<ConfinedComposeOptions> = {}) {
  return new ConfinedCompose({
    sessionId: SID,
    workspaceDir: WS,
    workspaceVolume: "shipit_workspace",
    daemonPath: async (p) => `/var/lib/docker/volumes/shipit_workspace/_data${p.slice("/workspace".length)}`,
    stackName: "shipit",
    image: () => READY,
    identity: () => ({ uid: 1234, gid: 1000 }),
    socketGid: () => 999,
    env: () => ORCHESTRATOR_ENV,
    run,
    ...extra,
  });
}

function flag(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (args[i - 1] === name ? [a] : []));
}

/** The argv of the command inside the container, after the image. */
function inner(args: string[]): string[] {
  return args.slice(args.indexOf(IMAGE_ID) + 1);
}

function envOf(args: string[]): Record<string, string> {
  return Object.fromEntries(flag(args, "-e").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
}

function framed(raw: string, rest: string): Buffer {
  return Buffer.from(`${Buffer.byteLength(raw)}\n${raw}${rest}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConfinedCompose — every run is a confined throwaway container", () => {
  it.each(["config", "read", "build", "up"] as const)("%s: --rm, no network, read-only root, no new privileges, labelled", async (command) => {
    const { calls, run } = recorder({ stdout: framed("services: {}\n", "") });
    const c = confined(run);
    if (command === "config") await c.config({ projectFile: "docker-compose.yml", services: [] });
    if (command === "read") await c.readWorkspaceFile("docker-compose.yml");
    if (command === "build") await c.build({ buildModel: "services: {}", services: [] });
    if (command === "up") await c.up({ overrideFile: `${COMPOSE_DIR}/override.yml`, services: [] });

    const { args, containerName } = calls[0]!;
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(flag(args, "--name")).toEqual([containerName]);
    expect(containerName).toMatch(new RegExp(`^${COMPOSE_HELPER_LABEL}-${command}-0123456789ab-[0-9a-f]{8}$`));
    expect(flag(args, "--label")).toEqual([`${COMPOSE_HELPER_LABEL}=${SID}`, "shipit-stack=shipit"]);
    expect(flag(args, "--network")).toEqual(["none"]);
    expect(args).toContain("--read-only");
    expect(flag(args, "--tmpfs")[0]).toMatch(/^\/tmp:/);
    expect(flag(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flag(args, "--pull")).toEqual(["never"]);
    expect(args).toContain(IMAGE_ID);
    // Only the allowlisted environment reaches the container.
    expect(envOf(args).GITHUB_TOKEN).toBeUndefined();
  });

  it("refuses to run, naming the image, when the helper image was not resolved", async () => {
    const { run } = recorder();
    const c = confined(run, {
      image: () => ({ status: "missing", name: "shipit-compose-helper:prod", reason: "No such image" }),
    });
    await expect(c.config({ projectFile: "docker-compose.yml", services: ["web"] }))
      .rejects.toThrow(/Compose helper image \(shipit-compose-helper:prod\) was not available.*No such image/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("ConfinedCompose.config", () => {
  it("mounts the workspace read-only at its own path, no socket, and runs as the session", async () => {
    const { calls, run } = recorder({ stdout: framed("services: {}\n", "name: x\n") });
    await confined(run).config({ projectFile: "docker-compose.yml", services: ["web"], stdin: "services:\n  db: {image: x}\n" });

    const { args, stdin } = calls[0]!;
    expect(flag(args, "--mount")).toEqual([
      `type=volume,src=shipit_workspace,dst=${WS},volume-subpath=sessions/${SID}/workspace,readonly`,
    ]);
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(flag(args, "--user")).toEqual(["1234:1000"]);
    expect(flag(args, "--group-add")).toEqual([]);
    expect(flag(args, "--workdir")).toEqual([WS]);
    expect(args).toContain("-i");
    expect(stdin).toBe("services:\n  db: {image: x}\n");
    const cmd = inner(args);
    expect(cmd.slice(-12)).toEqual([
      "docker", "compose", "-p", PROJECT, "-f", "docker-compose.yml", "-f", "-",
      "config", "--no-consistency", "--", "web",
    ]);
  });

  it("gives Compose exactly the orchestrator's allowlisted environment, HOME included", async () => {
    const { calls, run } = recorder({ stdout: framed("", "") });
    await confined(run).config({ projectFile: "docker-compose.yml", services: [] });
    expect(envOf(calls[0]!.args)).toEqual({ HOME: "/root", PATH: "/usr/bin:/bin", DOCKER_CONTEXT: "ctx" });
  });

  it("returns the resolved model and the project file's raw bytes from one run", async () => {
    const raw = "services:\n  web:\n    image: nginx # ünïcode\n";
    const { run } = recorder({ stdout: framed(raw, "name: shipit-0123456789ab\nservices: {}\n") });
    const out = await confined(run).config({ projectFile: "docker-compose.yml", services: ["web"] });
    expect(out.projectFile.toString()).toBe(raw);
    expect(out.stdout).toBe("name: shipit-0123456789ab\nservices: {}\n");
  });

  it("adds the fix to a path Compose could not read, and keeps the raw bytes it did read", async () => {
    const { run } = recorder({
      code: 1,
      stdout: framed("services: {}\n", ""),
      stderr: "env file /etc/secret.env not found: stat /etc/secret.env: no such file or directory",
    });
    const err = await confined(run).config({ projectFile: "docker-compose.yml", services: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComposeHelperError);
    expect((err as ComposeHelperError).message).toMatch(/^docker compose config failed \(exit 1\): env file/);
    expect((err as ComposeHelperError).message).toMatch(/must point inside the workspace/);
    expect((err as ComposeHelperError).projectFile?.toString()).toBe("services: {}\n");
  });

  it("says the container could not start when docker run itself fails", async () => {
    const { run } = recorder({ code: 125, stderr: "docker: Error response from daemon: invalid mount config" });
    await expect(confined(run).config({ projectFile: "docker-compose.yml", services: [] }))
      .rejects.toMatchObject({ kind: "start", message: expect.stringMatching(/could not start its Compose helper/) });
  });

  it("mounts the scratch directory beside the workspace when it exists", async () => {
    const exists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((p) => p === SCRATCH || exists(p));
    const { calls, run } = recorder({ stdout: framed("", "") });
    await confined(run).config({ projectFile: "docker-compose.yml", services: [] });
    expect(flag(calls[0]!.args, "--mount")).toContain(
      `type=volume,src=shipit_workspace,dst=${SCRATCH},volume-subpath=sessions/${SID}/scratch,readonly`,
    );
  });

  describe("the in-container script, run with sh here", () => {
    let tmp: string;
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // Runs the container's command locally, with Compose replaced by a stand-in that echoes stdin.
    function localRunner(cwd: string) {
      return createHelperRunner({
        spawn: (_cmd, args, options) => {
          const cmd = inner(args);
          const composeAt = cmd.indexOf("docker");
          return spawn(cmd[0]!, [...cmd.slice(1, composeAt), "sh", "-c", "printf 'model:'; cat"], { ...options, cwd });
        },
        removeContainer: async () => {},
      });
    }

    it("frames the project file's bytes ahead of Compose's output", async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-helper-sh-"));
      const raw = "services:\n  web:\n    image: nginx # ünïcode\n";
      fs.writeFileSync(path.join(tmp, "docker-compose.yml"), raw);
      const out = await confined(localRunner(tmp)).config({
        projectFile: "docker-compose.yml", services: [], stdin: "stubs",
      });
      expect(out.projectFile.toString()).toBe(raw);
      expect(out.stdout).toBe("model:stubs");
    });

    it("fails with the fix when the project file cannot be read", async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-helper-sh-"));
      await expect(confined(localRunner(tmp)).config({ projectFile: "missing.yml", services: [] }))
        .rejects.toThrow(/No such file or directory[\s\S]*must point inside the workspace/);
    });
  });

  it("bind-mounts the workspace at the same path in the bind deployment", async () => {
    const { calls, run } = recorder({ stdout: framed("", "") });
    await confined(run, { workspaceVolume: undefined }).config({ projectFile: "docker-compose.yml", services: [] });
    expect(flag(calls[0]!.args, "--mount")).toEqual([`type=bind,src=${WS},dst=${WS},readonly`]);
  });
});

describe("ConfinedCompose.readWorkspaceFile", () => {
  it("reads one file with no socket and returns its bytes", async () => {
    const { calls, run } = recorder({ stdout: Buffer.from([0, 1, 2, 255]) });
    const bytes = await confined(run).readWorkspaceFile("certs/key.pem");
    expect([...bytes]).toEqual([0, 1, 2, 255]);
    const { args } = calls[0]!;
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(flag(args, "--user")).toEqual(["1234:1000"]);
    expect(inner(args)).toEqual(["head", "-c", String(16 * 1024 * 1024 + 1), "--", `${WS}/certs/key.pem`]);
  });

  it("refuses a path outside the workspace without starting a container", async () => {
    const { run } = recorder();
    await expect(confined(run).readWorkspaceFile("../../other/workspace/.env")).rejects.toThrow(/outside it/);
    expect(run).not.toHaveBeenCalled();
  });

  it("adds the fix to a file it could not read", async () => {
    const { run } = recorder({ code: 1, stderr: "head: cannot open 'x' for reading: No such file or directory" });
    await expect(confined(run).readWorkspaceFile("x")).rejects.toThrow(/must point inside the workspace/);
  });
});

describe("ConfinedCompose.build", () => {
  it("adds the socket and its group, keeps the workspace writable, and mounts no ShipIt file", async () => {
    const { calls, run } = recorder();
    await confined(run).build({ buildModel: "services:\n  web: {build: /x}\n", services: ["web"] });
    const { args, stdin } = calls[0]!;
    expect(flag(args, "--mount")).toEqual([
      `type=volume,src=shipit_workspace,dst=${WS},volume-subpath=sessions/${SID}/workspace`,
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    ]);
    expect(flag(args, "--user")).toEqual(["1234:1000"]);
    expect(flag(args, "--group-add")).toEqual(["999"]);
    expect(stdin).toBe("services:\n  web: {build: /x}\n");
    expect(inner(args)).toEqual(["docker", "compose", "-p", PROJECT, "-f", "-", "build", "--", "web"]);
  });

  it("keeps the build tooling's state on the tmpfs and reaches the daemon only through the socket", async () => {
    const { calls, run } = recorder();
    await confined(run).build({ buildModel: "", services: [] });
    const env = envOf(calls[0]!.args);
    expect(env).toMatchObject({
      HOME: "/tmp",
      DOCKER_CONFIG: "/tmp/.docker",
      BUILDX_CONFIG: "/tmp/.docker/buildx",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    expect(env.DOCKER_CONTEXT).toBeUndefined();
  });

  it("names the registry-login exception when a base image needs a login", async () => {
    const { run } = recorder({ code: 1, stderr: "failed to solve: pull access denied, repository does not exist or may require authorization" });
    await expect(confined(run).build({ buildModel: "", services: [] }))
      .rejects.toThrow(/Builds do not get ShipIt's registry login/);
  });
});

describe("ConfinedCompose.up", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs as root from ShipIt's files at their Docker-host paths, without the workspace", async () => {
    const { calls, run } = recorder();
    const serviceEnv = `/workspace/service-env/${SID}`;
    await confined(run).up({
      snapshotFile: `${COMPOSE_DIR}/snapshot-1.yml`,
      overrideFile: `${COMPOSE_DIR}/override-1.yml`,
      services: ["web"],
      serviceEnvDir: serviceEnv,
    });
    const { args } = calls[0]!;
    expect(flag(args, "--user")).toEqual(["0:0"]);
    expect(flag(args, "--workdir")).toEqual([COMPOSE_DIR]);
    expect(flag(args, "--mount")).toEqual([
      `type=bind,src=/var/lib/docker/volumes/shipit_workspace/_data/sessions/${SID}/state/compose,dst=${COMPOSE_DIR},readonly`,
      `type=bind,src=/var/lib/docker/volumes/shipit_workspace/_data/service-env/${SID},dst=${serviceEnv},readonly`,
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    ]);
    expect(args.join(" ")).not.toContain(`dst=${WS}`);
    expect(inner(args)).toEqual([
      "docker", "compose", "-p", PROJECT,
      "-f", `${COMPOSE_DIR}/snapshot-1.yml`, "-f", `${COMPOSE_DIR}/override-1.yml`,
      "up", "-d", "--no-build", "--", "web",
    ]);
  });

  it("mounts a copy of the registry login and names it in DOCKER_CONFIG", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-helper-"));
    const source = path.join(tmp, "config.json");
    fs.writeFileSync(source, '{"auths":{"ghcr.io":{"auth":"x"}}}');
    const loginDir = "/workspace/compose-registry-login";
    const staged = path.join(tmp, "login");
    const { calls, run } = recorder();
    const c = confined(run, {
      registryLoginDir: staged,
      dockerClientConfigFile: source,
      daemonPath: async (p) => (p === staged ? `/host${loginDir}` : `/host${p}`),
    });
    await c.up({ overrideFile: `${COMPOSE_DIR}/override-1.yml`, services: [] });
    const { args } = calls[0]!;
    expect(flag(args, "--mount")).toContain(`type=bind,src=/host${loginDir},dst=${staged},readonly`);
    expect(envOf(args).DOCKER_CONFIG).toBe(staged);
    expect(fs.readFileSync(path.join(staged, "config.json"), "utf-8")).toContain("ghcr.io");
  });

  it("refuses a model file outside the compose state directory", async () => {
    const { run } = recorder();
    await expect(confined(run).up({ overrideFile: `${WS}/override.yml`, services: [] }))
      .rejects.toThrow(/the only directory `up` sees/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses, naming the setting, when the service-env directory has no Docker-host path", async () => {
    const { run } = recorder();
    const daemonPath = composeHelperDaemonPath({
      docker: { getVolume: () => ({ inspect: async () => ({ Mountpoint: "/data" }) }) } as unknown as Docker,
      workspaceVolume: "shipit_workspace",
      serviceEnvDir: "/srv/service-env",
    });
    await expect(confined(run, { daemonPath }).up({
      overrideFile: `${COMPOSE_DIR}/override-1.yml`,
      services: [],
      serviceEnvDir: `/srv/service-env/${SID}`,
    })).rejects.toThrow(new RegExp(SERVICE_ENV_HOST_DIR_ENV));
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the orchestrator's conflict-recovery message shape", async () => {
    const { run } = recorder({ code: 1, stderr: 'Conflict. The container name "/x" is already in use by container "abcdef0123456789"' });
    await expect(confined(run).up({ overrideFile: `${COMPOSE_DIR}/override-1.yml`, services: [] }))
      .rejects.toThrow(/^docker compose up failed \(exit 1\): Conflict/);
  });
});

describe("composeHelperDaemonPath", () => {
  const docker = { getVolume: () => ({ inspect: async () => ({ Mountpoint: "/data" }) }) } as unknown as Docker;

  it("translates workspace-volume paths and a supplied service-env host directory", async () => {
    const resolve = composeHelperDaemonPath({
      docker, workspaceVolume: "ws", serviceEnvDir: "/srv/env", serviceEnvHostDir: "/opt/env",
    });
    await expect(resolve("/workspace/sessions/s/state/compose")).resolves.toBe("/data/sessions/s/state/compose");
    await expect(resolve("/srv/env/s")).resolves.toBe("/opt/env/s");
  });

  it("keeps paths as they are in the bind deployment", async () => {
    await expect(composeHelperDaemonPath({})("/srv/x")).resolves.toBe("/srv/x");
  });
});

describe("stageRegistryLogin", () => {
  let tmp: string;
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("copies the client configuration root-only, and drops the copy once there is none", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-login-"));
    const source = path.join(tmp, "src.json");
    const dir = path.join(tmp, "login");
    fs.writeFileSync(source, "{}");
    expect(stageRegistryLogin(dir, source)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);

    fs.rmSync(source);
    expect(stageRegistryLogin(dir, source)).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
  });
});

describe("createHelperRunner — cleanup by name", () => {
  const node = (script: string) => () => spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });

  it("removes the container by name when the run times out", async () => {
    const removeContainer = vi.fn(async () => {});
    const run = createHelperRunner({ spawn: node("setTimeout(() => {}, 30000)"), removeContainer });
    const result = await run({ args: ["run"], containerName: "helper-a", timeoutMs: 50 });
    expect(result.interrupted).toBe("timeout");
    expect(removeContainer).toHaveBeenCalledWith("helper-a");
  });

  it("removes the container by name when the caller cancels", async () => {
    const removeContainer = vi.fn(async () => {});
    const run = createHelperRunner({ spawn: node("setTimeout(() => {}, 30000)"), removeContainer });
    const controller = new AbortController();
    const pending = run({ args: ["run"], containerName: "helper-b", signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.interrupted).toBe("cancelled");
    expect(removeContainer).toHaveBeenCalledWith("helper-b");
  });

  it("stops a run whose output passes the limit", async () => {
    const removeContainer = vi.fn(async () => {});
    const run = createHelperRunner({
      spawn: node("process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 30000)"),
      removeContainer,
    });
    const result = await run({ args: ["run"], containerName: "helper-c", captureStdout: true, maxStdoutBytes: 1000 });
    expect(result.interrupted).toBe("output-limit");
    expect(removeContainer).toHaveBeenCalledWith("helper-c");
  });

  it("leaves a finished run's removal to --rm", async () => {
    const removeContainer = vi.fn(async () => {});
    const run = createHelperRunner({ spawn: node("process.stdout.write('ok')"), removeContainer });
    const result = await run({ args: ["run"], containerName: "helper-d", captureStdout: true });
    expect(result).toMatchObject({ code: 0, stdout: Buffer.from("ok") });
    expect(result.interrupted).toBeUndefined();
    expect(removeContainer).not.toHaveBeenCalled();
  });
});

describe("resolveComposeHelperImage", () => {
  const docker = (inspect: () => Promise<{ Id?: string }>) =>
    ({ getImage: vi.fn(() => ({ inspect })) }) as unknown as Docker;

  it("pins the image by id", async () => {
    const d = docker(async () => ({ Id: "sha256:abc" }));
    await expect(resolveComposeHelperImage(d, "shipit-compose-helper:prod"))
      .resolves.toEqual({ status: "ready", name: "shipit-compose-helper:prod", id: "sha256:abc" });
    expect(d.getImage).toHaveBeenCalledWith("shipit-compose-helper:prod");
  });

  it("reports a missing image with Docker's reason", async () => {
    const result = await resolveComposeHelperImage(docker(async () => { throw new Error("No such image"); }), "x:y");
    expect(result).toEqual({ status: "missing", name: "x:y", reason: "No such image" });
  });

  it("reports an unset image name", async () => {
    const result = await resolveComposeHelperImage(docker(async () => ({ Id: "sha256:abc" })), undefined);
    expect(result).toMatchObject({ status: "missing", reason: expect.stringMatching(/SESSION_COMPOSE_HELPER_IMAGE/) });
  });
});

describe("reapOrphanComposeHelpers", () => {
  it("removes an earlier process's helpers and keeps the ones started since boot", async () => {
    const bootMs = 1_700_000_000_000;
    const removed: string[] = [];
    const listContainers = vi.fn(async () => [
      { Id: "old", Created: bootMs / 1000 - 60 },
      { Id: "live", Created: bootMs / 1000 + 5 },
    ]);
    const docker = {
      listContainers,
      getContainer: (id: string) => ({ remove: async () => { removed.push(id); } }),
    } as unknown as Docker;

    expect(await reapOrphanComposeHelpers(docker, { stackName: "shipit", bootMs })).toBe(1);
    expect(removed).toEqual(["old"]);
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: [COMPOSE_HELPER_LABEL, "shipit-stack=shipit"] },
    });
  });
});
