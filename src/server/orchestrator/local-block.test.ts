import { describe, it, expect, afterEach, vi } from "vitest";
import type Docker from "dockerode";
import {
  _setLocalBlockForTest,
  assertLoopbackOnlyWithoutBlock,
  hostAddresses,
  initLocalBlock,
  localBlockActive,
  nonLoopbackBindings,
  parseHostAddresses,
  sessionContainerRefusal,
} from "./local-block.js";

function helperDocker(opts: { exitCode?: number; output?: string; os?: string; inspect?: unknown } = {}) {
  const created: Record<string, unknown>[] = [];
  const docker = {
    createContainer: vi.fn(async (spec: Record<string, unknown>) => {
      created.push(spec);
      return {
        start: async () => {},
        wait: async () => ({ StatusCode: opts.exitCode ?? 0 }),
        logs: async () => opts.output ?? "",
        remove: async () => {},
      };
    }),
    info: async () => ({ OperatingSystem: opts.os ?? "Ubuntu 24.04" }),
    getContainer: () => ({
      inspect: async () => {
        if (opts.inspect === undefined) throw new Error("no such container");
        return opts.inspect;
      },
    }),
  };
  return { docker: docker as unknown as Docker, created };
}

afterEach(() => _setLocalBlockForTest(false));

describe("initLocalBlock (docs/319 req 6)", () => {
  it("is active when the probe installs its rules, in a namespace of its own", async () => {
    const { docker, created } = helperDocker();
    await expect(initLocalBlock(docker, { SESSION_EGRESS_SIDECAR_IMAGE: "sidecar:test" })).resolves.toBe(true);
    expect(localBlockActive()).toBe(true);
    expect(created[0]).toMatchObject({
      Image: "sidecar:test",
      Entrypoint: ["/usr/local/bin/probe-firewall.sh"],
      HostConfig: { NetworkMode: "none", CapAdd: ["NET_ADMIN"] },
    });
  });

  it("is not active when the host refuses the rules", async () => {
    const { docker } = helperDocker({ exitCode: 1 });
    await expect(initLocalBlock(docker, { SESSION_EGRESS_SIDECAR_IMAGE: "sidecar:test" })).resolves.toBe(false);
  });

  it("is not active without a sidecar image", async () => {
    const { docker, created } = helperDocker();
    await expect(initLocalBlock(docker, {})).resolves.toBe(false);
    expect(created).toHaveLength(0);
  });

  it("refuses session containers on Docker Desktop without the block (req 1, req 3)", async () => {
    const { docker } = helperDocker({ exitCode: 1, os: "Docker Desktop" });
    await initLocalBlock(docker, { SESSION_EGRESS_SIDECAR_IMAGE: "sidecar:test" });
    expect(sessionContainerRefusal()).toMatch(/Docker Desktop/);
  });

  it("allows session containers elsewhere without the block", async () => {
    const { docker } = helperDocker({ exitCode: 1 });
    await initLocalBlock(docker, { SESSION_EGRESS_SIDECAR_IMAGE: "sidecar:test" });
    expect(sessionContainerRefusal()).toBeNull();
  });
});

describe("assertLoopbackOnlyWithoutBlock (docs/319 req 6)", () => {
  const published = (hostIp: string) => ({
    NetworkSettings: { Ports: { "4123/tcp": [{ HostIp: hostIp, HostPort: "4123" }] } },
  });

  it("refuses to start with a tailnet binding when the block is not active", async () => {
    const { docker } = helperDocker({ inspect: published("100.64.1.2") });
    await expect(assertLoopbackOnlyWithoutBlock(docker, async () => "self")).rejects.toThrow(/100\.64\.1\.2:4123/);
  });

  it("starts on loopback only", async () => {
    const { docker } = helperDocker({ inspect: published("127.0.0.1") });
    await expect(assertLoopbackOnlyWithoutBlock(docker, async () => "self")).resolves.toBeUndefined();
  });

  it("starts with any binding while the block is active", async () => {
    _setLocalBlockForTest(true);
    const { docker } = helperDocker({ inspect: published("0.0.0.0") });
    await expect(assertLoopbackOnlyWithoutBlock(docker, async () => "self")).resolves.toBeUndefined();
  });

  it("reads an empty host address as every address", () => {
    expect(nonLoopbackBindings(published(""))).toEqual(["0.0.0.0:4123"]);
    expect(nonLoopbackBindings({ HostConfig: { PortBindings: { "4123/tcp": [{ HostIp: "::1", HostPort: "4123" }] } } }))
      .toEqual([]);
  });
});

describe("hostAddresses", () => {
  const IP_OUTPUT = [
    "1: lo    inet 127.0.0.1/8 scope host lo",
    "2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0",
    "2: eth0    inet6 2001:db8::7/64 scope global",
    "2: eth0    inet6 fe80::1/64 scope link",
    "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0",
  ].join("\n");

  it("keeps global addresses and drops loopback and link-local", () => {
    expect(parseHostAddresses(IP_OUTPUT)).toEqual(["172.17.0.1", "2001:db8::7", "203.0.113.7"]);
  });

  it("reads them in the host network namespace, and reuses a read for a minute", async () => {
    const { docker, created } = helperDocker({ output: IP_OUTPUT });
    let now = 1_000;
    await hostAddresses(docker, "sidecar:test", () => now);
    now += 30_000;
    await hostAddresses(docker, "sidecar:test", () => now);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ HostConfig: { NetworkMode: "host" } });
    now += 31_000;
    await hostAddresses(docker, "sidecar:test", () => now);
    expect(created).toHaveLength(2);
  });

  it("throws when they cannot be read, so the install fails closed", async () => {
    const { docker } = helperDocker({ exitCode: 1 });
    await expect(hostAddresses(docker, "sidecar:test")).rejects.toThrow(/host's addresses/);
  });
});
