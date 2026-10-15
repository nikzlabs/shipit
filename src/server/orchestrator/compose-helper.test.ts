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
  composeHelperImage,
  createHelperRunner,
  pinComposeHelperImage,
  reapOrphanComposeHelpers,
  repinComposeHelperImage,
  resolveComposeHelperImage,
  setComposeHelperImage,
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
    daemonPath: composeHelperDaemonPath({ workspaceVolume: "shipit_workspace" }),
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

  describe("when Docker no longer has the pinned image", () => {
    const NEW_ID = "sha256:rebuilt";
    const gone = { code: 125, stderr: `docker: Error response from daemon: No such image: ${IMAGE_ID}\n` };

    function goneThenOk() {
      const calls: HelperRunRequest[] = [];
      const run = vi.fn(async (req: HelperRunRequest): Promise<HelperRunResult> => {
        calls.push(req);
        return calls.length === 1
          ? { stdout: Buffer.alloc(0), ...gone }
          : { code: 0, stdout: framed("services: {}\n", "name: x\n"), stderr: "" };
      });
      return { calls, run };
    }

    it("re-pins by name and runs once more on the new id, still by id and never pulling", async () => {
      const { calls, run } = goneThenOk();
      const repinImage = vi.fn(async () => ({ ...READY, id: NEW_ID }));
      const out = await confined(run, { repinImage }).config({ projectFile: "docker-compose.yml", services: [] });

      expect(out.stdout).toBe("name: x\n");
      expect(repinImage).toHaveBeenCalledExactlyOnceWith(IMAGE_ID);
      expect(calls).toHaveLength(2);
      const retry = calls[1]!.args;
      expect(retry).toContain(NEW_ID);
      expect(retry).not.toContain(IMAGE_ID);
      expect(flag(retry, "--pull")).toEqual(["never"]);
      expect(calls[1]!.containerName).not.toBe(calls[0]!.containerName);
      expect(retry.slice(retry.indexOf(NEW_ID) + 1)).toEqual(inner(calls[0]!.args));
    });

    it("does not retry while Docker still has the pinned image, so a command that ran is not repeated", async () => {
      const { calls, run } = goneThenOk();
      const repinImage = vi.fn(async () => READY);
      await expect(confined(run, { repinImage }).readWorkspaceFile("docker-compose.yml"))
        .rejects.toMatchObject({ kind: "start", message: expect.stringMatching(/No such image/) });
      expect(calls).toHaveLength(1);
    });

    it("flushes the first run's trailing output before the retry starts", async () => {
      const events: string[] = [];
      const onOutput = Object.assign((chunk: string) => { events.push(`out:${chunk.trim()}`); }, {
        flush: () => { events.push("flush"); },
      });
      let runs = 0;
      const run = vi.fn(async (req: HelperRunRequest): Promise<HelperRunResult> => {
        events.push("run");
        if (++runs === 1) {
          req.onOutput?.(gone.stderr);
          return { stdout: Buffer.alloc(0), ...gone };
        }
        req.onOutput?.("built\n");
        return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
      await confined(run, { repinImage: async () => ({ ...READY, id: NEW_ID }) })
        .build({ buildModel: "", services: [], onOutput });
      expect(events).toEqual(["run", `out:${gone.stderr.trim()}`, "flush", "run", "out:built", "flush"]);
    });

    it("stops waiting for the re-pin when the caller cancels, and starts no second run", async () => {
      const { calls, run } = goneThenOk();
      const controller = new AbortController();
      const repinImage = vi.fn(() => new Promise<ComposeHelperImage>(() => {}));
      const pending = confined(run, { repinImage })
        .readWorkspaceFile("docker-compose.yml", { signal: controller.signal })
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(repinImage).toHaveBeenCalled());
      controller.abort();
      expect(await pending).toMatchObject({ kind: "cancelled" });
      expect(calls).toHaveLength(1);
    });

    it("reports a cancel that came before the re-pin, and handles the re-pin's rejection", async () => {
      const { calls, run } = goneThenOk();
      const controller = new AbortController();
      controller.abort();
      // Not vi.fn: a mock subscribes to the promises it returns, which would hide an unhandled rejection.
      const repinImage = (): Promise<ComposeHelperImage> => Promise.reject(new Error("daemon gone"));
      // The test setup logs unhandled rejections instead of failing on them.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        await expect(confined(run, { repinImage }).readWorkspaceFile("docker-compose.yml", { signal: controller.signal }))
          .rejects.toMatchObject({ kind: "cancelled" });
        await new Promise((r) => setImmediate(r));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it("says to rebuild ShipIt's images when the name does not resolve either", async () => {
      const { calls, run } = goneThenOk();
      const repinImage = vi.fn(async (): Promise<ComposeHelperImage> => ({
        status: "missing", name: READY.name, reason: "No such image: shipit-compose-helper:test",
      }));
      const err = await confined(run, { repinImage }).up({ overrideFile: `${COMPOSE_DIR}/override.yml`, services: [] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ComposeHelperError);
      expect(err).toMatchObject({ kind: "unavailable" });
      expect((err as Error).message).toMatch(/reported its Compose helper image \(shipit-compose-helper:test, pinned as sha256:helper\) missing/);
      expect((err as Error).message).toMatch(/Rebuild ShipIt's images/);
      expect((err as Error).message).not.toMatch(/Error response from daemon/);
      expect(calls).toHaveLength(1);
    });

    it("does not re-pin for any other reason docker run fails", async () => {
      const repinImage = vi.fn(async () => ({ ...READY, id: NEW_ID }));
      const daemonError = recorder({ code: 125, stderr: "docker: Error response from daemon: invalid mount config" });
      await expect(confined(daemonError.run, { repinImage }).readWorkspaceFile("x")).rejects.toMatchObject({ kind: "start" });
      // The container's own command, not `docker run`, failed.
      const inside = recorder({ code: 1, stderr: "Error response from daemon: No such image: postgres:16" });
      await expect(confined(inside.run, { repinImage }).up({ overrideFile: `${COMPOSE_DIR}/override.yml`, services: [] }))
        .rejects.toMatchObject({ kind: "failed" });
      const timedOut = recorder({ code: 125, stderr: "No such image", interrupted: "timeout" });
      await expect(confined(timedOut.run, { repinImage }).readWorkspaceFile("x")).rejects.toMatchObject({ kind: "timeout" });

      expect(repinImage).not.toHaveBeenCalled();
      expect([daemonError, inside, timedOut].map((r) => r.calls.length)).toEqual([1, 1, 1]);
    });
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

  // A volume's Mountpoint is not a host path on Docker Desktop: Docker mounts an empty directory for it.
  it("runs as root from ShipIt's files, mounted as the workspace volume and never by a host path", async () => {
    const { calls, run } = recorder();
    const serviceEnv = `/workspace/service-env/${SID}`;
    const daemonPath = vi.fn(async (p: string) => `/var/lib/docker/volumes/shipit_workspace/_data${p.slice("/workspace".length)}`);
    await confined(run, { daemonPath }).up({
      snapshotFile: `${COMPOSE_DIR}/snapshot-1.yml`,
      overrideFile: `${COMPOSE_DIR}/override-1.yml`,
      services: ["web"],
      serviceEnvDir: serviceEnv,
    });
    const { args } = calls[0]!;
    expect(flag(args, "--user")).toEqual(["0:0"]);
    expect(flag(args, "--workdir")).toEqual([COMPOSE_DIR]);
    expect(flag(args, "--mount")).toEqual([
      `type=volume,src=shipit_workspace,dst=${COMPOSE_DIR},volume-subpath=sessions/${SID}/state/compose,readonly`,
      `type=volume,src=shipit_workspace,dst=${serviceEnv},volume-subpath=service-env/${SID},readonly`,
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    ]);
    expect(daemonPath).not.toHaveBeenCalled();
    expect(args.join(" ")).not.toContain(`dst=${WS}`);
    expect(inner(args)).toEqual([
      "docker", "compose", "-p", PROJECT,
      "-f", `${COMPOSE_DIR}/snapshot-1.yml`, "-f", `${COMPOSE_DIR}/override-1.yml`,
      "up", "-d", "--no-build", "--", "web",
    ]);
  });

  it("binds ShipIt's files at their own paths in the bind deployment", async () => {
    const { calls, run } = recorder();
    const serviceEnv = `/workspace/service-env/${SID}`;
    await confined(run, { workspaceVolume: undefined, daemonPath: composeHelperDaemonPath({}) }).up({
      overrideFile: `${COMPOSE_DIR}/override-1.yml`,
      services: [],
      serviceEnvDir: serviceEnv,
    });
    expect(flag(calls[0]!.args, "--mount")).toEqual([
      `type=bind,src=${COMPOSE_DIR},dst=${COMPOSE_DIR},readonly`,
      `type=bind,src=${serviceEnv},dst=${serviceEnv},readonly`,
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    ]);
  });

  it("binds a service-env directory outside the workspace volume from its supplied Docker-host path", async () => {
    const { calls, run } = recorder();
    const daemonPath = composeHelperDaemonPath({
      workspaceVolume: "shipit_workspace", serviceEnvDir: "/srv/service-env", serviceEnvHostDir: "/opt/env",
    });
    await confined(run, { daemonPath }).up({
      overrideFile: `${COMPOSE_DIR}/override-1.yml`,
      services: [],
      serviceEnvDir: `/srv/service-env/${SID}`,
    });
    expect(flag(calls[0]!.args, "--mount")).toEqual([
      `type=volume,src=shipit_workspace,dst=${COMPOSE_DIR},volume-subpath=sessions/${SID}/state/compose,readonly`,
      `type=bind,src=/opt/env/${SID},dst=/srv/service-env/${SID},readonly`,
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
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
  it("translates a supplied service-env host directory", async () => {
    const resolve = composeHelperDaemonPath({
      workspaceVolume: "ws", serviceEnvDir: "/srv/env", serviceEnvHostDir: "/opt/env",
    });
    await expect(resolve("/srv/env/s")).resolves.toBe("/opt/env/s");
  });

  it("names no host path for anything inside the workspace volume", async () => {
    const resolve = composeHelperDaemonPath({ workspaceVolume: "ws" });
    await expect(resolve("/workspace/sessions/s/state/compose")).rejects.toThrow(/has no Docker-host path/);
    await expect(resolve("/srv/x")).rejects.toThrow(/does not know the Docker-host path/);
  });

  it("keeps paths as they are in the bind deployment", async () => {
    await expect(composeHelperDaemonPath({})("/srv/x")).resolves.toBe("/srv/x");
    await expect(composeHelperDaemonPath({})("/workspace/x")).resolves.toBe("/workspace/x");
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

describe("repinComposeHelperImage", () => {
  const NAME = "shipit-compose-helper:test";
  const NEW_ID = "sha256:rebuilt";
  const NEW: ComposeHelperImage = { ...READY, id: NEW_ID };
  afterEach(() => {
    vi.useRealTimers();
    setComposeHelperImage({ status: "missing", name: undefined, reason: "reset by test" });
  });

  /** A daemon holding `images` (reference → id); each answer waits for `gate`. */
  function fakeDocker(images: Record<string, string>, gate: Promise<void> = Promise.resolve()) {
    const inspected: string[] = [];
    const docker = {
      getImage: (ref: string) => ({
        inspect: async () => {
          inspected.push(ref);
          await gate;
          const id = images[ref];
          if (id === undefined) throw Object.assign(new Error(`No such image: ${ref}`), { statusCode: 404 });
          return { Id: id };
        },
      }),
    } as unknown as Docker;
    return { docker, inspected };
  }

  function deferred() {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    return { gate, open };
  }

  it("re-pins what the name resolves to once Docker confirms the pinned id gone, in one shared resolve", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gate, open } = deferred();
    const { docker, inspected } = fakeDocker({ [NAME]: NEW_ID }, gate);
    setComposeHelperImage(READY, docker);

    const pending = [repinComposeHelperImage(IMAGE_ID), repinComposeHelperImage(IMAGE_ID), repinComposeHelperImage(IMAGE_ID)];
    open();
    expect(await Promise.all(pending)).toEqual([NEW, NEW, NEW]);
    expect(inspected).toEqual([IMAGE_ID, NAME]);
    expect(composeHelperImage()).toEqual(NEW);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`${IMAGE_ID}; ${NAME} re-pinned to ${NEW_ID}`));

    // A run that started on the old id and fails after the re-pin takes the new pin, without a resolve.
    expect(await repinComposeHelperImage(IMAGE_ID)).toEqual(NEW);
    expect(inspected).toHaveLength(2);
  });

  it("keeps the pin, and resolves nothing by name, while Docker still has the pinned image", async () => {
    const { docker, inspected } = fakeDocker({ [IMAGE_ID]: IMAGE_ID, [NAME]: NEW_ID });
    setComposeHelperImage(READY, docker);
    expect(await repinComposeHelperImage(IMAGE_ID)).toEqual(READY);
    expect(composeHelperImage()).toEqual(READY);
    expect(inspected).toEqual([IMAGE_ID]);
  });

  it("keeps the pin when Docker cannot say whether the pinned image is gone", async () => {
    const inspected: string[] = [];
    const docker = {
      getImage: (ref: string) => ({
        inspect: async () => {
          inspected.push(ref);
          throw new Error("connect ECONNREFUSED /var/run/docker.sock");
        },
      }),
    } as unknown as Docker;
    setComposeHelperImage(READY, docker);
    expect(await repinComposeHelperImage(IMAGE_ID)).toEqual(READY);
    expect(inspected).toEqual([IMAGE_ID]);
  });

  it("keeps the pin, and resolves again next time, when the name does not resolve", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { docker, inspected } = fakeDocker({});
    setComposeHelperImage(READY, docker);

    expect(await repinComposeHelperImage(IMAGE_ID)).toMatchObject({ status: "missing", reason: `No such image: ${NAME}` });
    expect(composeHelperImage()).toEqual(READY);
    await repinComposeHelperImage(IMAGE_ID);
    expect(inspected).toEqual([IMAGE_ID, NAME, IMAGE_ID, NAME]);
  });

  it("stops waiting for a daemon that does not answer", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { docker } = fakeDocker({ [NAME]: NEW_ID }, new Promise(() => {}));
    setComposeHelperImage(READY, docker);

    const pending = repinComposeHelperImage(IMAGE_ID);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ status: "missing", reason: expect.stringMatching(/did not answer within 30 seconds/) });
    expect(composeHelperImage()).toEqual(READY);
  });

  it("answers with the newer pin, and leaves its resolve shared, when the pin is replaced during a resolve", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = deferred();
    setComposeHelperImage(READY, fakeDocker({ [NAME]: "sha256:stale" }, first.gate).docker);
    const stale = repinComposeHelperImage(IMAGE_ID);

    const second = deferred();
    const later = fakeDocker({ [NAME]: NEW_ID }, second.gate);
    const other: ComposeHelperImage = { ...READY, id: "sha256:other" };
    setComposeHelperImage(other, later.docker);
    const current = repinComposeHelperImage("sha256:other");

    first.open();
    expect(await stale).toEqual(other);
    const joined = repinComposeHelperImage("sha256:other");
    second.open();
    expect(await Promise.all([current, joined])).toEqual([NEW, NEW]);
    expect(later.inspected).toEqual(["sha256:other", NAME]);
    expect(composeHelperImage()).toEqual(NEW);
  });

  it("re-pins the next run of every session's ConfinedCompose, with the Docker client startup pinned with", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const images: Record<string, string> = { [NAME]: IMAGE_ID };
    const { docker } = fakeDocker(images);
    expect(await pinComposeHelperImage(docker, NAME)).toEqual(READY);
    images[NAME] = NEW_ID;

    const { run } = recorder();
    run.mockResolvedValueOnce({ code: 125, stdout: Buffer.alloc(0), stderr: `No such image: ${IMAGE_ID}` });
    await confined(run, { image: composeHelperImage }).readWorkspaceFile("docker-compose.yml");
    await confined(run, { image: composeHelperImage }).readWorkspaceFile("docker-compose.yml");
    expect(run.mock.calls.map(([req]) => req.args.includes(NEW_ID))).toEqual([false, true, true]);
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
