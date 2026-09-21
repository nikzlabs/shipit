import { describe, it, expect } from "vitest";
import { findAmbiguousFieldCasing } from "./docker-proxy-field-casing.js";

describe("findAmbiguousFieldCasing", () => {
  it("accepts a canonical container-create body", () => {
    const body = {
      Image: "alpine",
      Cmd: ["sleep", "1"],
      Env: ["A=1"],
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        Binds: ["/w/app:/app"],
        Mounts: [{ Type: "volume", Source: "data", Target: "/data" }],
        PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }] },
        CapDrop: ["NET_RAW"],
        NetworkMode: "shipit-session-1",
        Memory: 1024,
      },
      NetworkingConfig: { EndpointsConfig: { "shipit-session-1": { Aliases: ["web"] } } },
      Labels: { "com.docker.compose.project": "app" },
    };

    expect(findAmbiguousFieldCasing(body)).toBeUndefined();
  });

  it("names the field and its canonical spelling", () => {
    const message = findAmbiguousFieldCasing({ HostConfig: { privileged: true } });

    expect(message).toContain("HostConfig.privileged");
    expect(message).toContain(`"Privileged"`);
  });

  it("catches an alias at any depth and in any casing", () => {
    expect(findAmbiguousFieldCasing({ hostconfig: {} })).toBeDefined();
    expect(findAmbiguousFieldCasing({ HostConfig: { BINDS: ["/:/host"] } })).toBeDefined();
    expect(findAmbiguousFieldCasing({ HostConfig: { Mounts: [{ type: "bind" }] } })).toBeDefined();
    expect(findAmbiguousFieldCasing({ HostConfig: { Mounts: [{ Type: "bind", SOURCE: "/" }] } })).toBeDefined();
  });

  it("catches the two non-ASCII runes Go folds onto an ASCII letter", () => {
    // Go compares with bytes.EqualFold, so "Bindſ" reaches Binds and "NetworkMode" spelled with a
    // Kelvin sign reaches NetworkMode; plain lowercasing leaves both unchanged.
    expect(findAmbiguousFieldCasing({ HostConfig: { "Bindſ": ["/:/host"] } })).toBeDefined();
    expect(findAmbiguousFieldCasing({ HostConfig: { "NetworKMode": "host" } })).toBeDefined();
  });

  it("treats the keys of a Go map as data, not as field names", () => {
    expect(findAmbiguousFieldCasing({ Labels: { type: "web", privileged: "no" } })).toBeUndefined();
    expect(findAmbiguousFieldCasing({ HostConfig: { Sysctls: { binds: "1" } } })).toBeUndefined();
    expect(findAmbiguousFieldCasing({ Volumes: { "/data": {} } })).toBeUndefined();
    expect(
      findAmbiguousFieldCasing({ NetworkingConfig: { EndpointsConfig: { source: {} } } }),
    ).toBeUndefined();
  });

  it("accepts the real option names a Docker client sends", () => {
    // `--log-opt labels=…` and `--ipc` are ordinary usage; neither is an alias.
    expect(findAmbiguousFieldCasing({
      HostConfig: {
        LogConfig: { Type: "json-file", Config: { labels: "app", "max-size": "10m" } },
        Tmpfs: { "/run": "rw,size=64m" },
        Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 2048 }],
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      },
    })).toBeUndefined();
    expect(findAmbiguousFieldCasing({
      Name: "net",
      IPAM: {
        Driver: "default",
        Options: { "com.docker.network.driver.mtu": "1500" },
        Config: [{ Subnet: "10.0.0.0/24", AuxiliaryAddresses: { source: "10.0.0.5" } }],
      },
    })).toBeUndefined();
  });

  it("still checks the values below a map key", () => {
    const body = { NetworkingConfig: { EndpointsConfig: { "my-net": { ipamconfig: {} } } } };

    // IPAMConfig is not guarded, so this body is clean; a guarded field at the same depth is not.
    expect(findAmbiguousFieldCasing(body)).toBeUndefined();
    expect(
      findAmbiguousFieldCasing({ Labels: { type: { driveropts: {} } } }),
    ).toBeDefined();
  });

  it("ignores fields no check reads", () => {
    expect(findAmbiguousFieldCasing({ image: "alpine", cmd: ["ls"], entrypoint: [] })).toBeUndefined();
  });

  it("handles a body that is not an object", () => {
    expect(findAmbiguousFieldCasing(null)).toBeUndefined();
    expect(findAmbiguousFieldCasing("privileged")).toBeUndefined();
    expect(findAmbiguousFieldCasing([{ privileged: true }])).toBeDefined();
  });
});
