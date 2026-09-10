import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  extractContainerPort,
  parseComposeFile,
  parseUserNamedVolumes,
  generateComposeOverride,
  writeComposeOverride,
  ComposeValidationError,
  validateDevices,
  isDevKvmAllowed,
  ALLOWED_DEVICE,
  parseStopGracePeriodMs,
  UNKNOWN_STOP_GRACE_PERIOD_MS,
} from "./compose-generator.js";

describe("parseStopGracePeriodMs (docs/283)", () => {
  it("reads a bare number as seconds, per Compose", () => {
    expect(parseStopGracePeriodMs(30)).toBe(30_000);
    expect(parseStopGracePeriodMs("30")).toBe(30_000);
    expect(parseStopGracePeriodMs("1.5")).toBe(1_500);
  });

  it("reads Go-style durations, including compound ones", () => {
    expect(parseStopGracePeriodMs("10s")).toBe(10_000);
    expect(parseStopGracePeriodMs("1m30s")).toBe(90_000);
    expect(parseStopGracePeriodMs("500ms")).toBe(500);
    expect(parseStopGracePeriodMs("2h")).toBe(7_200_000);
    expect(parseStopGracePeriodMs("1h2m3s")).toBe(3_723_000);
  });

  it("distinguishes absent from unreadable", () => {
    expect(parseStopGracePeriodMs(undefined)).toBeUndefined();
    expect(parseStopGracePeriodMs(null)).toBeUndefined();
  });

  it("fails LONG on anything it cannot read", () => {
    expect(parseStopGracePeriodMs("about a minute")).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs("1m30")).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs("30d")).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs("")).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs({})).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs(-5)).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
    expect(parseStopGracePeriodMs(Number.NaN)).toBe(UNKNOWN_STOP_GRACE_PERIOD_MS);
  });
});

describe("parseComposeFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-gen-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): string {
    const p = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(p, content);
    return p;
  }

  function trustedProxyEnvironment(extra = ""): string {
    const allowed = ["CONTAINERS", "EVENTS", "IMAGES", "INFO", "NETWORKS", "VOLUMES", "VERSION", "PING"];
    const denied = ["POST", "BUILD", "COMMIT", "EXEC", "AUTH", "CONFIGS", "DISTRIBUTION",
      "GRPC", "NODES", "PLUGINS", "SECRETS", "SERVICES", "SESSION", "SWARM", "SYSTEM", "TASKS"];
    return [...allowed.map((key) => `      ${key}: 1`), ...denied.map((key) => `      ${key}: 0`), extra]
      .filter(Boolean).join("\n");
  }

  it("parses basic service definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["5173:5173"]
  db:
    image: postgres:16
    ports: ["5432:5432"]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(2);
    expect(services[0].name).toBe("web");
    expect(services[0].ports).toEqual(["5173:5173"]);
    expect(services[1].name).toBe("db");
  });

  it("captures an explicit user: field (#1646)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    user: "1001:1001"
  db:
    image: postgres:16
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].user).toBe("1001:1001");
    expect(services[1].user).toBeUndefined();
  });

  it("extracts x-shipit-preview values", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
  db:
    image: postgres:16
    x-shipit-preview: manual
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].shipitPreview).toBe("auto");
    expect(services[1].shipitPreview).toBe("manual");
  });

  it("defaults dependsOnInstall to true for auto-preview services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("defaults dependsOnInstall to true for services with ports (implicit auto)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["5173:5173"]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("defaults dependsOnInstall to false for manual-preview services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  db:
    image: postgres:16
    x-shipit-preview: manual
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("defaults dependsOnInstall to false for portless services (implicit manual)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  db:
    image: postgres:16
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("honors explicit x-shipit-depends-on-install: false on an auto service", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
    x-shipit-depends-on-install: false
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("honors explicit x-shipit-depends-on-install: true on a manual service", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  worker:
    image: node:20
    x-shipit-preview: manual
    x-shipit-depends-on-install: true
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("extracts user-defined profiles", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  debug:
    image: node:20
    profiles: [debug, testing]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].profiles).toEqual(["debug", "testing"]);
  });

  it("rejects privileged: true", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    privileged: true
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("privileged");
  });

  it("rejects repository-defined Linux capabilities", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    cap_add: [NET_ADMIN]\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("cap_add");
  });

  it("rejects reserved egress labels", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    labels:\n      shipit-egress-resolver: forged\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("reserved egress namespace");
  });

  it("rejects Compose API socket access in contained services", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    use_api_socket: true\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("use_api_socket");
    expect(() => parseComposeFile(p, { dockerSocket: true, containEgress: true })).toThrow("use_api_socket");
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("compose.docker-socket");
    expect(() => parseComposeFile(p, { dockerSocket: true })).not.toThrow();
  });

  it("rejects lifecycle hooks in contained services", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    post_start:\n      - command: /bin/true\n        privileged: true\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("lifecycle hooks");
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
  });

  it("rejects network_mode: host", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    network_mode: host
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("network_mode: host");
  });

  it("accepts the exact /dev/kvm:/dev/kvm device mapping (emulator)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  emulator:
    image: budtmo/docker-android:emulator_14.0
    devices: ["/dev/kvm:/dev/kvm"]
    expose: ["5555"]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("emulator");
  });

  it("rejects any device other than /dev/kvm", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  bad:
    image: node:20
    devices: ["/dev/sda:/dev/sda"]
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("is not allowed");
  });

  it("rejects a /dev/kvm host remapped to a different container device", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  sneaky:
    image: node:20
    devices: ["/dev/kvm:/dev/sda"]
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("is not allowed");
  });

  it("rejects Docker socket mount when docker-socket is false", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Docker socket");
  });

  it("rejects interpolation in contained security-sensitive fields", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: attacker/example
    user: "1001"
    privileged: \${X:-true}
    volumes:
      - "\${S:-/var/run/docker.sock}:/var/run/docker.sock"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("variable interpolation");
  });

  it("rejects custom YAML tags in contained service definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: attacker/example\n    user: "1001"\n    privileged: !override true\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("Custom YAML tags");
  });

  it("allows exclamation marks in ordinary contained scalar values", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: attacker/example\n    user: "1001"\n    environment:\n      PASSWORD: Str0ng!Password\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .not.toThrow();
  });

  it("rejects resolved YAML tags in contained service definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: attacker/example\n    user: "1001"\n    volumes: !!set\n      ? /var/run/docker.sock:/var/run/docker.sock\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("Custom YAML tags");
  });

  it("rejects YAML merge keys in contained service definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `x-base: &base\n  privileged: true\n  cap_add: [NET_ADMIN]\nservices:\n  web:\n    <<: *base\n    image: attacker/example\n    user: "1001"\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("YAML merge keys");
  });

  it("resolves YAML merge keys before Open-mode security validation", () => {
    const dir = setup();
    const p = writeCompose(dir, `x-base: &base\n  privileged: true\nservices:\n  web:\n    <<: *base\n    image: attacker/example\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("privileged: true");
  });

  it("rejects a project declaration of the reserved contained network", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: attacker/example\n    user: "1001"\nnetworks:\n  shipit-session:\n    driver: macvlan\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("reserved `shipit-session` network");
  });

  it("rejects a project declaration of the reserved network in an Open session too", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\nnetworks:\n  shipit-session:\n    driver: macvlan\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("reserved `shipit-session` network");
  });

  it("rejects a network driver that attaches the host's own segment", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    networks: [lan]
networks:
  lan:
    driver: macvlan
    driver_opts:
      parent: eth0
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("network driver");
  });

  it("rejects an external network declaration", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    networks: [borrowed]
networks:
  borrowed:
    external: true
    name: shipit-session-11111111-2222-3333-4444-555555555555
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("external");
  });

  it("rejects a top-level network `name:` override", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
networks:
  backend:
    name: shipit-session-11111111-2222-3333-4444-555555555555
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("name:");
  });

  it("rejects network driver_opts and a chosen address pool", () => {
    const dir = setup();
    const opts = writeCompose(dir, `
services:
  web:
    image: node:20
networks:
  backend:
    driver_opts:
      com.docker.network.bridge.name: docker0
`);
    expect(() => parseComposeFile(opts, { dockerSocket: false })).toThrow("driver_opts");
    const ipam = writeCompose(dir, `
services:
  web:
    image: node:20
networks:
  backend:
    ipam:
      config:
        - subnet: 172.31.0.0/16
`);
    expect(() => parseComposeFile(ipam, { dockerSocket: false })).toThrow("ipam");
  });

  it("allows an ordinary project-declared bridge network", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    networks: [backend]
networks:
  backend:
  frontend:
    driver: bridge
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
  });

  it("rejects `include:` in every session, not only contained ones", () => {
    const dir = setup();
    const p = writeCompose(dir, `
include:
  - ./volumes.yml
services:
  web:
    image: node:20
    volumes:
      - escape:/host
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("include:");
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("include:");
  });

  it("rejects build.network: host in contained services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      network: host
`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("`build.network: host` is not allowed for contained services");
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
  });

  it("rejects a build network ShipIt cannot describe, and allows the two it can", () => {
    const dir = setup();
    const named = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      network: backend
`);
    expect(() => parseComposeFile(named, { dockerSocket: false, containEgress: true }))
      .toThrow("`build.network: backend` is not allowed");

    const interpolated = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      network: \${BUILD_NET}
`);
    expect(() => parseComposeFile(interpolated, { dockerSocket: false, containEgress: true }))
      .toThrow("build.network");

    for (const value of ["none", "default"]) {
      const ok = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      network: ${value}
`);
      expect(() => parseComposeFile(ok, { dockerSocket: false, containEgress: true })).not.toThrow();
    }

    const plain = writeCompose(dir, `
services:
  app:
    user: "1001"
    build: ./app
`);
    expect(() => parseComposeFile(plain, { dockerSocket: false, containEgress: true })).not.toThrow();
  });

  it("rejects build.privileged and build.entitlements in contained services", () => {
    const dir = setup();
    const privileged = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      privileged: true
`);
    expect(() => parseComposeFile(privileged, { dockerSocket: false, containEgress: true }))
      .toThrow("build.privileged");
    expect(() => parseComposeFile(privileged, { dockerSocket: false })).not.toThrow();

    const quoted = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      privileged: "true"
`);
    expect(() => parseComposeFile(quoted, { dockerSocket: false, containEgress: true }))
      .toThrow("build.privileged");

    const entitlements = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      entitlements:
        - security.insecure
`);
    expect(() => parseComposeFile(entitlements, { dockerSocket: false, containEgress: true }))
      .toThrow("build.entitlements");

    const harmless = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      privileged: false
      entitlements: []
`);
    expect(() => parseComposeFile(harmless, { dockerSocket: false, containEgress: true })).not.toThrow();
  });

  it("reads every boolean spelling Compose reads for build.privileged", () => {
    const dir = setup();
    const write = (value: string) => writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      privileged: ${value}
`);
    for (const no of ['"no"', '"off"', '"n"', '"FALSE"', "false"]) {
      expect(() => parseComposeFile(write(no), { dockerSocket: false, containEgress: true }),
        `expected \`privileged: ${no}\` to be read as false`).not.toThrow();
    }
    for (const yes of ['"yes"', '"on"', '"y"', '"TRUE"', "true", '"perhaps"']) {
      expect(() => parseComposeFile(write(yes), { dockerSocket: false, containEgress: true }),
        `expected \`privileged: ${yes}\` to be refused`).toThrow("build.privileged");
    }
  });

  it("rejects volumes_from in contained services", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: attacker/example\n    user: "1001"\n    volumes_from: [docker-socket-proxy]\n`);
    expect(() => parseComposeFile(p, { dockerSocket: true, containEgress: true }))
      .toThrow("volumes_from");
  });

  it("explains when the ops proxy is missing the server-side ops flag", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.3.0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("server-created ops sessions");
  });

  it("allows Docker socket mount when docker-socket is true", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    const services = parseComposeFile(p, { dockerSocket: true });
    expect(services).toHaveLength(1);
  });

  it("rejects direct Docker socket access for contained non-proxy services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(() => parseComposeFile(p, { dockerSocket: true, containEgress: true }))
      .toThrow("direct Docker socket access");
  });

  it("rejects a spoofed proxy name without the server-authoritative ops flag", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  docker-socket-proxy:
    image: attacker/example
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(() => parseComposeFile(p, { dockerSocket: true, containEgress: true }))
      .toThrow("direct Docker socket access");
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("allows the trusted ops proxy on the internal network in a contained ops session", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment();
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).not.toThrow();
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      trustedOpsProxy: true,
    })).not.toThrow();
  });

  it("does not trust an ops proxy that supplies a build definition", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment();
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    build: .\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("does not trust an ops proxy with an extra bind mount", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment();
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n      - ./proxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("does not trust an ops proxy with a repository-controlled healthcheck", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment();
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    environment:\n${environment}\n    healthcheck:\n      test: [CMD-SHELL, 'true']\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("does not trust an ops proxy with an unapproved environment key", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment("      ALLOW_START: 1");
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("does not trust list-form proxy environment inherited from a project env file", () => {
    const dir = setup();
    const allowed = ["CONTAINERS", "EVENTS", "IMAGES", "INFO", "NETWORKS", "VOLUMES", "VERSION", "PING"];
    const denied = ["POST", "BUILD", "COMMIT", "EXEC", "AUTH", "CONFIGS", "DISTRIBUTION",
      "GRPC", "NODES", "PLUGINS", "SECRETS", "SERVICES", "SESSION", "SWARM", "SYSTEM", "TASKS"];
    const environment = [...allowed.map((key) => `      - ${key}=1`),
      ...denied.map((key) => `      - ${key}=0`), "      - ALLOW_START"].join("\n");
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: tecnativa/docker-socket-proxy:0.3.0\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("direct Docker socket access");
  });

  it("does not grant the proxy UID exemption by service name alone", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  docker-socket-proxy:
    image: attacker/example
    user: 911
`);
    expect(() => parseComposeFile(p, {
      dockerSocket: true,
      containEgress: true,
      trustedOpsProxy: true,
    })).toThrow("reserved UID");
  });

  it("rejects a user: inside ShipIt's per-session UID range", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    user: "2000001"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("reserves for per-session");
  });

  it("rejects it on an OPEN session too, not only a contained one", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    user: "2999999:1000"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: false }))
      .toThrow("reserves for per-session");
  });

  it("still accepts the UIDs real images and projects actually use", () => {
    const dir = setup();
    for (const user of ["33", "101", "999", "1000", "1001:1001", "65534"]) {
      const p = writeCompose(dir, `
services:
  web:
    image: node:20
    user: "${user}"
`);
      expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
    }
  });

  it("rejects absolute bind mount paths", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /etc/passwd:/etc/passwd
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Absolute bind mount");
  });

  it("rejects path traversal in volumes", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - ../secret:/data
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Path traversal");
  });

  it("rejects a host bind encoded in a top-level volume's driver_opts (planning#386)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - escape:/host
volumes:
  escape:
    driver: local
    driver_opts:
      type: none
      device: /
      o: bind
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("driver_opts");
  });

  it("cannot be evaded by hiding the driver_opts behind an anchor", () => {
    const dir = setup();
    const p = writeCompose(dir, `
x-anchors: &bind
  type: none
  device: /
  o: bind
services:
  web:
    image: node:20
    user: "1000:1000"
    volumes:
      - escape:/host
volumes:
  escape:
    driver_opts: *bind
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("driver_opts");
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("driver_opts");
  });

  it("cannot be evaded by a merge key on the volume entry", () => {
    const dir = setup();
    const p = writeCompose(dir, `
x-anchors: &escape
  driver_opts:
    type: none
    device: /
    o: bind
services:
  web:
    image: node:20
    volumes:
      - escape:/host
volumes:
  escape:
    <<: *escape
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("driver_opts");
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("merge keys");
  });

  it("has nothing to refuse in the list form of a volumes block", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - pgdata:/data
volumes:
  - pgdata
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
    expect(parseUserNamedVolumes(p)).toEqual([]);
  });

  it("rejects a driver_opts host bind in a contained session too", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    user: "1000:1000"
    volumes:
      - escape:/host
volumes:
  escape:
    driver_opts:
      type: none
      device: /var/lib/shipit
      o: bind
`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }))
      .toThrow("driver_opts");
  });

  it("rejects a remote-filesystem volume declaration", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - share:/data
volumes:
  share:
    driver_opts:
      type: nfs
      o: addr=10.0.0.1,rw
      device: ":/export"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("driver_opts");
  });

  it("rejects a non-local volume driver", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - store:/data
volumes:
  store:
    driver: some-host-plugin
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("volume driver");
  });

  it("rejects an external volume declaration", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - borrowed:/data
volumes:
  borrowed:
    external: true
    name: shipit-dev_workspace
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("external");
  });

  it("rejects a top-level volume that renames itself onto an existing volume", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - data:/data
volumes:
  data:
    name: shipit-dev_workspace
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("name:");
  });

  it("allows empty option maps and every casing of a false `external`", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - data:/data
volumes:
  data:
    driver_opts: {}
    external: "FALSE"
  spare:
    external: false
networks:
  backend:
    driver_opts: {}
    ipam: {}
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
  });

  it("still refuses a true `external` however it is spelled", () => {
    const dir = setup();
    for (const value of ['true', '"TRUE"', '"yes"', "1", "{ name: other }"]) {
      const p = writeCompose(dir, `
services:
  web:
    image: node:20
volumes:
  data:
    external: ${value}
`);
      expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("external");
    }
  });

  it("allows ordinary Compose-managed named volumes", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - pgdata:/var/lib/postgresql/data
      - cache:/cache
volumes:
  pgdata:
  cache:
    labels:
      com.example.keep: "true"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
    expect(parseUserNamedVolumes(p).map((v) => v.name)).toEqual(["pgdata", "cache"]);
  });

  it("rejects an absolute env_file path (the CLI reads it, in the orchestrator's own fs)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    env_file: /proc/1/environ
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("absolute path");
  });

  it("rejects an escaping env_file in list and object form", () => {
    const dir = setup();
    const list = writeCompose(dir, `
services:
  web:
    image: node:20
    env_file:
      - ./ok.env
      - ../../root/.env
`);
    expect(() => parseComposeFile(list, { dockerSocket: false })).toThrow("path traversal");
    const obj = writeCompose(dir, `
services:
  web:
    image: node:20
    env_file:
      - path: /proc/1/environ
        required: false
`);
    expect(() => parseComposeFile(obj, { dockerSocket: false })).toThrow("absolute path");
  });

  it("rejects an absolute config file path", () => {
    const dir = setup();
    const p = writeCompose(dir, `
configs:
  leak:
    file: /etc/shadow
services:
  web:
    image: node:20
    configs:
      - leak
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("absolute path");
  });

  it("allows a workspace-relative env_file", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    env_file: ./.env
`);
    expect(parseComposeFile(p, { dockerSocket: false })).toHaveLength(1);
  });

  it("rejects an absolute secret file path", () => {
    const dir = setup();
    const p = writeCompose(dir, `
secrets:
  leak:
    file: /proc/1/environ
services:
  web:
    image: node:20
    build:
      context: .
      secrets:
        - leak
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("absolute path");
  });

  it("rejects path traversal in a secret file path", () => {
    const dir = setup();
    const p = writeCompose(dir, `
secrets:
  leak:
    file: ../../root/.docker/config.json
services:
  web:
    image: node:20
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("path traversal");
  });

  it("rejects an interpolated secret file path", () => {
    const dir = setup();
    const p = writeCompose(dir, `
secrets:
  leak:
    file: \${HOME}/.docker/config.json
services:
  web:
    image: node:20
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("interpolation is not allowed");
  });

  it("allows a workspace-relative secret file", () => {
    const dir = setup();
    const p = writeCompose(dir, `
secrets:
  api_key:
    file: ./secrets/api_key.txt
services:
  web:
    image: node:20
    secrets:
      - api_key
`);
    expect(parseComposeFile(p, { dockerSocket: false })).toHaveLength(1);
  });

  it("handles long-syntax port definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports:
      - published: 8080
        target: 80
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].ports).toEqual(["8080:80"]);
  });

  it("rejects unsupported port entry types", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports:
      - published: 8080
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("unsupported ports");
  });

  it("rejects object-form volume with path traversal", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - type: bind
        source: ../secret
        target: /data
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Path traversal");
  });

  it("allows named volume in object form", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - type: volume
        source: mydata
        target: /data
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(1);
  });

  it("throws for missing compose file", () => {
    expect(() => parseComposeFile("/nonexistent/file.yml", { dockerSocket: false }))
      .toThrow("Cannot read compose file");
  });

  it("throws for compose file without services", () => {
    const dir = setup();
    const p = writeCompose(dir, "version: '3'\n");
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("must have a `services` section");
  });

  it("wraps YAML parse errors as ComposeValidationError (e.g. mid-merge conflict markers)", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:
  web:
    image: node:20
<<<<<<< HEAD
    ports: ["5173:5173"]
=======
    ports: ["3000:3000"]
>>>>>>> feature
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(/not valid YAML/);
  });

  describe("distinguishes a malformed file from a refused one", () => {
    function kindOf(content: string, opts: { dockerSocket: boolean; containEgress?: boolean }): string {
      const p = writeCompose(tmpDir, content);
      try {
        parseComposeFile(p, opts);
      } catch (err) {
        return err instanceof ComposeValidationError ? err.kind : "not-a-validation-error";
      }
      return "no-throw";
    }

    it("marks a file it cannot parse at all as malformed", () => {
      setup();
      expect(kindOf("services: [oh: : no\n", { dockerSocket: false })).toBe("malformed");
      expect(kindOf("version: '3'\n", { dockerSocket: false })).toBe("malformed");
      expect(kindOf("- a\n- b\n", { dockerSocket: false })).toBe("malformed");
    });

    it("keeps a refusal raised during the parse pass a refusal", () => {
      setup();
      const contained = { dockerSocket: false, containEgress: true };
      expect(kindOf(
        `services:\n  web:\n    image: x\n    user: "1001"\n    privileged: !override true\n`,
        contained,
      )).toBe("refused");
      expect(kindOf(
        `x-base: &base\n  privileged: true\nservices:\n  web:\n    <<: *base\n    image: x\n    user: "1001"\n`,
        contained,
      )).toBe("refused");
      const p = writeCompose(tmpDir, `services:\n  web:\n    image: x\n    user: "1001"\n    privileged: !override true\n`);
      expect(() => parseComposeFile(p, contained)).toThrow(/^Custom YAML tags/);
    });

    it("marks a well-formed file it declines as refused", () => {
      setup();
      expect(kindOf(`services:
  web:
    image: node:22-alpine
    user: "0"
`, { dockerSocket: false, containEgress: true })).toBe("refused");
      expect(kindOf(`services:
  web:
    image: node:22-alpine
    privileged: true
`, { dockerSocket: false })).toBe("refused");
    });
  });
});

describe("generateComposeOverride", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  it("generates override with labels and network", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], user: "1001:1001" }],
      baseOpts,
    );
    expect(override).toContain("shipit-parent-session: test-session-123");
    expect(override).toContain("shipit-service-name: web");
    expect(override).toContain("shipit-session");
    expect(override).toContain("shipit-session-test-session-123");
    expect(override).toContain("NET_RAW");
  });

  it("makes the service network internal while egress containment is active", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], user: "1001:1001" }],
      { ...baseOpts, containEgress: true, containDns: true, containProxy: true },
    );
    expect(override).toContain("internal: true");
    expect(override).toContain("192.0.2.1");
    expect(override).toContain("networks: !override");
    expect(override).toContain("dns: !override");
    expect(override).toContain("restart: no");
    expect(override).toContain("no-new-privileges");
    expect(override).toContain("cap_drop:\n      - NET_RAW\n      - SETUID\n      - SETGID");
    expect(override).toContain("net.ipv4.conf.all.route_localnet: \"1\"");

    const openOverride = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }],
      baseOpts,
    );
    expect(openOverride).not.toContain("internal: true");
    expect(openOverride).not.toContain("192.0.2.1");
    expect(openOverride).not.toContain("SETUID");
  });

  it("overrides repository DNS in contained mode", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], user: "1001:1001" }],
      { ...baseOpts, containEgress: true, containDns: true },
    );
    expect(override).toContain("dns: !override\n      - 192.0.2.1");
    expect(override).not.toContain("user: 1000:1000");
  });

  it("requires an explicit safe numeric user only in contained mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-contained-user-"));
    const write = (content: string) => {
      const file = path.join(dir, "docker-compose.yml");
      fs.writeFileSync(file, content);
      return file;
    };
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    try {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const p = write(`services:\n  web:\n    image: postgres:17\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("numeric, non-root");
      expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
      const safe = write(`services:\n  web:\n    image: app:test\n    user: "1001:1001"\n`);
      expect(() => parseComposeFile(safe, { dockerSocket: false, containEgress: true })).not.toThrow();
      const reserved = write(`services:\n  web:\n    image: app:test\n    user: "911"\n`);
      expect(() => parseComposeFile(reserved, { dockerSocket: false, containEgress: true })).toThrow("reserved UID");
    } finally {
      if (orig === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = orig;
    }
  });

  it("accepts an undeclared user in contained mode when ShipIt supplies the identity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-contained-fillin-"));
    const file = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(file, `services:\n  web:\n    image: postgres:17\n`);
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    try {
      process.env.SHIPIT_SESSION_WORKER_UID = "2000006";
      expect(() => parseComposeFile(file, { dockerSocket: false, containEgress: true })).not.toThrow();
      fs.writeFileSync(file, `services:\n  web:\n    image: app:test\n    user: "2000006"\n`);
      expect(() => parseComposeFile(file, { dockerSocket: false, containEgress: true }))
        .toThrow("reserves for per-session identities");
      fs.writeFileSync(file, `services:\n  web:\n    image: app:test\n    user: "0"\n`);
      expect(() => parseComposeFile(file, { dockerSocket: false, containEgress: true }))
        .toThrow("numeric, non-root");
    } finally {
      if (orig === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = orig;
    }
  });

  it("this repository's own compose file is valid in contained mode, on the non-root runtime", () => {
    const own = path.join(process.cwd(), "docker-compose.yml");
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    try {
      process.env.SHIPIT_SESSION_WORKER_UID = "2000006";
      expect(() => parseComposeFile(own, { dockerSocket: false, containEgress: true })).not.toThrow();

      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(() => parseComposeFile(own, { dockerSocket: false, containEgress: true }))
        .toThrow("numeric, non-root");
      expect(() => parseComposeFile(own, { dockerSocket: false })).not.toThrow();
    } finally {
      if (orig === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = orig;
    }
  });

  it("labels manual services without adding profiles", () => {
    const override = generateComposeOverride(
      [{ name: "db", shipitPreview: "manual" }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: manual");
    expect(override).not.toContain("profiles");
  });

  it("defaults services with ports to auto", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["3000:3000"] }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: auto");
  });

  it("defaults services without ports to manual", () => {
    const override = generateComposeOverride(
      [{ name: "redis" }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: manual");
  });

  it("strips ports with !reset sentinel", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }],
      baseOpts,
    );
    expect(override).toContain("!reset []");
  });

  it("rewrites workspace volumes when workspaceVolume is set", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], volumes: [".:/app"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "sessions/abc/workspace" },
    );
    expect(override).toContain("source: shipit-workspace");
    expect(override).toContain("target: /app");
    expect(override).toContain("subpath: sessions/abc/workspace");
    expect(override).toContain("shipit-workspace");
    expect(override).toContain("external: true");
  });

  it("rewrites subdirectory volumes with combined subpath", () => {
    const override = generateComposeOverride(
      [{ name: "api", volumes: ["./backend:/app"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "sessions/abc/workspace" },
    );
    expect(override).toContain("subpath: sessions/abc/workspace/backend");
    expect(override).toContain("target: /app");
  });

  it("preserves read-only mode on rewritten volumes", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app:ro"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol" },
    );
    expect(override).toContain("read_only: true");
  });

  it("leaves non-workspace volumes untouched", () => {
    const override = generateComposeOverride(
      [{ name: "db", volumes: ["pgdata:/var/lib/postgresql/data"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol" },
    );
    expect(override).toContain("pgdata:/var/lib/postgresql/data");
  });

  it("rewrites object-form workspace volumes", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [{ type: "bind", source: ".", target: "/app" }] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "ws/dir" },
    );
    expect(override).toContain("source: shipit-workspace");
    expect(override).toContain("subpath: ws/dir");
  });
});

describe("generateComposeOverride — session-worker UID (#1646)", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };
  const origUid = process.env.SHIPIT_SESSION_WORKER_UID;
  afterEach(() => {
    if (origUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = origUid;
  });

  it("does not set user when SHIPIT_SESSION_WORKER_UID is unset (legacy all-root)", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    const override = generateComposeOverride([{ name: "web", ports: ["5173:5173"] }], baseOpts);
    const doc = parseYaml(override) as { services: Record<string, { user?: string }> };
    expect(doc.services.web.user).toBeUndefined();
  });

  it("runs services as the worker UID when the var is set", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride([{ name: "web", ports: ["5173:5173"] }], baseOpts);
    const doc = parseYaml(override) as { services: Record<string, { user?: string }> };
    expect(doc.services.web.user).toBe("1000:1000");
  });

  it("applies the UID to every service in the stack", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }, { name: "api", ports: ["3000:3000"] }],
      baseOpts,
    );
    const doc = parseYaml(override) as { services: Record<string, { user?: string }> };
    expect(doc.services.web.user).toBe("1000:1000");
    expect(doc.services.api.user).toBe("1000:1000");
  });

  it("keeps the ops docker-socket-proxy image startup user so HAProxy config generation can run", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride(
      [{ name: "docker-socket-proxy", shipitPreview: "auto", trustedOpsProxy: true }],
      { ...baseOpts, composeConfig: { file: "docker-compose.yml", dockerSocket: true } },
    );
    const doc = parseYaml(override) as { services: Record<string, { user?: string; cap_drop?: string[] }> };
    expect(doc.services["docker-socket-proxy"].user).toBeUndefined();
    expect(doc.services["docker-socket-proxy"].cap_drop).toEqual(["NET_RAW"]);

    const containedOverride = generateComposeOverride(
      [{ name: "docker-socket-proxy", shipitPreview: "auto", trustedOpsProxy: true }],
      {
        ...baseOpts,
        containEgress: true,
        containDns: true,
        composeConfig: { file: "docker-compose.yml", dockerSocket: true },
      },
    );
    const contained = parseYaml(containedOverride) as {
      services: Record<string, { user?: string; dns?: string[] }>;
    };
    expect(contained.services["docker-socket-proxy"].user).toBeUndefined();
    expect(contained.services["docker-socket-proxy"].dns).toEqual(["192.0.2.1"]);
  });

  it("honors an explicit user: from the compose file and never overrides it", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], user: "root" }],
      baseOpts,
    );
    const doc = parseYaml(override) as { services: Record<string, { user?: string }> };
    expect(doc.services.web.user).toBeUndefined();
  });

  it("preserves a named user: so images with their own baked-in user still boot", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride(
      [{ name: "emulator", ports: ["6080:6080"], user: "androidusr" }],
      baseOpts,
    );
    const doc = parseYaml(override) as { services: Record<string, { user?: string }> };
    expect(doc.services.emulator.user).toBeUndefined();
  });

  it("adds the session group to a service that declares its own user", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride(
      [{ name: "emulator", ports: ["6080:6080"], user: "1300:1301" }],
      baseOpts,
    );
    const doc = parseYaml(override) as {
      services: Record<string, { user?: string; group_add?: string[] }>;
    };
    expect(doc.services.emulator.user).toBeUndefined();
    expect(doc.services.emulator.group_add).toEqual(["1000"]);
  });

  it("does not add a group to a service it runs as the session identity", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    const override = generateComposeOverride([{ name: "web", ports: ["5173:5173"] }], baseOpts);
    const doc = parseYaml(override) as {
      services: Record<string, { user?: string; group_add?: string[] }>;
    };
    expect(doc.services.web.user).toBe("1000:1000");
    expect(doc.services.web.group_add).toBeUndefined();
  });

  it("treats an empty user: as absent, and fills in the identity rather than leaving root", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "2000006";
    for (const declared of ['""', '"   "']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-empty-user-"));
      const file = path.join(dir, "docker-compose.yml");
      fs.writeFileSync(file, `services:\n  web:\n    image: node:22-alpine\n    user: ${declared}\n`);
      const services = parseComposeFile(file, { dockerSocket: false, containEgress: true });
      const override = generateComposeOverride(services, { ...baseOpts, containEgress: true });
      const doc = parseYaml(override) as {
        services: Record<string, { user?: string; group_add?: string[] }>;
      };
      expect(doc.services.web.user).toBe("2000006:2000006");
      expect(doc.services.web.group_add).toBeUndefined();
    }
  });

  it("refuses an undeclared contained service when the fill-in would be root", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "0";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-root-fillin-"));
    const file = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(file, `services:\n  web:\n    image: node:22-alpine\n`);
    expect(() => parseComposeFile(file, { dockerSocket: false, containEgress: true }))
      .toThrow("numeric, non-root");
  });

  it("adds no group in legacy all-root mode, where there is no session group", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    const override = generateComposeOverride(
      [{ name: "emulator", ports: ["6080:6080"], user: "1300:1301" }],
      baseOpts,
    );
    const doc = parseYaml(override) as { services: Record<string, { group_add?: string[] }> };
    expect(doc.services.emulator.group_add).toBeUndefined();
  });
});

describe("writeComposeOverride", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-write-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the override into the given directory", () => {
    const dir = setup();
    const content = "services: {}\n";
    const result = writeComposeOverride(dir, content);
    expect(result).toBe(path.join(dir, "compose.override.yml"));
    expect(fs.readFileSync(result, "utf-8")).toBe(content);
  });

  it("writes the override 0600, including over a pre-existing looser file", () => {
    const dir = setup();
    const target = path.join(dir, "compose.override.yml");
    fs.writeFileSync(target, "stale", { mode: 0o644 });
    writeComposeOverride(dir, "services: {}\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("creates the target directory if it doesn't exist", () => {
    const dir = setup();
    const target = path.join(dir, "state");
    writeComposeOverride(target, "test");
    expect(fs.existsSync(path.join(target, "compose.override.yml"))).toBe(true);
  });

  it("never creates a .shipit directory in the caller's tree", () => {
    const dir = setup();
    writeComposeOverride(path.join(dir, "state"), "services: {}\n");
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);
  });

  it("does not chown the override, even with the worker-uid flag set", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    try {
      const dir = setup();
      const result = writeComposeOverride(dir, "services: {}\n");
      const before = fs.lstatSync(result).uid;
      writeComposeOverride(dir, "services: {}\n");
      expect(fs.lstatSync(result).uid).toBe(before);
    } finally {
      if (orig === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = orig;
    }
  });
});

describe("x-shipit-secrets parsing", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-secrets-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): string {
    const p = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(p, content);
    return p;
  }

  it("parses string-form x-shipit-secrets", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      - STRIPE_KEY
  api:
    image: node:20
    x-shipit-secrets:
      - DATABASE_URL
      - REDIS_URL
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const web = services.find(s => s.name === "web");
    const api = services.find(s => s.name === "api");
    expect(web?.secrets).toEqual(["STRIPE_KEY"]);
    expect(api?.secrets).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });

  it("leaves secrets undefined for services that don't declare any", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toBeUndefined();
  });

  it("rejects non-list x-shipit-secrets", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      not: a list
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(ComposeValidationError);
  });

  it("rejects invalid env var names", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      - "1bad-name"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("not a valid env var name");
  });

  it("accepts object-form entries with a name (Phase 2 forward-compat)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: DATABASE_URL
        description: PostgreSQL connection string
        required: true
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["DATABASE_URL"]);
  });

  it("silently skips object entries without a name", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - description: missing name field
      - VALID_NAME
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["VALID_NAME"]);
  });

  it("populates secretRequirements with description / required / agent / source", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - SIMPLE_KEY
      - name: DATABASE_URL
        description: PostgreSQL connection string
        required: true
        agent: true
      - name: ANTHROPIC_API_KEY
        source: platform:claude_oauth
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const reqs = services[0].secretRequirements;
    expect(reqs).toBeDefined();
    expect(reqs).toHaveLength(3);

    const simple = reqs!.find((r) => r.name === "SIMPLE_KEY");
    expect(simple).toEqual({ name: "SIMPLE_KEY" });

    const db = reqs!.find((r) => r.name === "DATABASE_URL");
    expect(db).toEqual({
      name: "DATABASE_URL",
      description: "PostgreSQL connection string",
      required: true,
      agent: true,
    });

    const api = reqs!.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(api).toEqual({
      name: "ANTHROPIC_API_KEY",
      source: "platform:claude_oauth",
    });
  });

  it("keeps secrets and secretRequirements in lockstep (same order, same names)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - FIRST
      - name: SECOND
        required: true
      - THIRD
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(services[0].secretRequirements?.map((r) => r.name)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("ignores extra / unknown object fields without breaking parsing", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: WITH_EXTRA
        description: kept
        unknown_field: value
        another: 42
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secretRequirements?.[0]).toEqual({
      name: "WITH_EXTRA",
      description: "kept",
    });
  });

  it("treats `required: false` (or absent) as not required", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: MAYBE
        required: false
      - name: ABSENT
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const reqs = services[0].secretRequirements!;
    expect(reqs[0].required).toBeUndefined();
    expect(reqs[1].required).toBeUndefined();
  });
});

describe("generateComposeOverride env_file injection", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  const ENV_ROOT = "/state/service-env/test-session-123";

  it("adds env_file reference for services with declared secrets", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      { ...baseOpts, serviceEnvFiles: { api: `${ENV_ROOT}/.env.api` } },
    );
    expect(override).toContain("env_file:");
    expect(override).toContain(`${ENV_ROOT}/.env.api`);
  });

  it("does not add env_file for services without secrets", () => {
    const override = generateComposeOverride(
      [{ name: "redis" }],
      baseOpts,
    );
    expect(override).not.toContain("env_file:");
  });

  it("scopes env_file per service", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL"] },
      ],
      {
        ...baseOpts,
        serviceEnvFiles: {
          web: `${ENV_ROOT}/.env.web`,
          api: `${ENV_ROOT}/.env.api`,
        },
      },
    );
    expect(override).toContain(`${ENV_ROOT}/.env.web`);
    expect(override).toContain(`${ENV_ROOT}/.env.api`);
  });

  it("uses supplied absolute env-file paths when serviceEnvFiles is present", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL"] },
      ],
      {
        ...baseOpts,
        serviceEnvFiles: {
          web: "/workspace/service-env/test-session-123/.env.web",
          api: "/workspace/service-env/test-session-123/.env.api",
        },
      },
    );
    expect(override).toContain("/workspace/service-env/test-session-123/.env.web");
    expect(override).toContain("/workspace/service-env/test-session-123/.env.api");
    expect(override).not.toContain(".shipit/.env.web");
    expect(override).not.toContain(".shipit/.env.api");
  });

  it("emits no env_file for a service missing from serviceEnvFiles", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL"] },
      ],
      {
        ...baseOpts,
        serviceEnvFiles: {
          web: "/workspace/service-env/test-session-123/.env.web",
        },
      },
    );
    expect(override).toContain("/workspace/service-env/test-session-123/.env.web");
    expect(override).not.toContain(".env.api");
  });

  describe("plugin services (req 23)", () => {
    const probe = {
      name: "probe",
      origin: {
        kind: "plugin" as const,
        repo: "art-kit",
        alias: "artk",
        plugin: "palette",
        sourceName: "probe",
        self: false,
      },
      pluginDefinition: {
        image: "node:22-alpine",
        entrypoint: ["/plugin/bin/serve"],
        environment: { SHIPIT_PROJECT_DIR: "/project", PROBE_PORT: "4820" },
      },
      externalVolumes: [],
    };

    function envOf(override: string): Record<string, string> {
      const doc = parseYaml(override) as {
        services: Record<string, { environment?: Record<string, string> }>;
      };
      return doc.services.probe.environment ?? {};
    }

    it("delivers the resolved values as the service's own environment", () => {
      const override = generateComposeOverride(
        [probe],
        { ...baseOpts, pluginServiceEnv: { probe: { FAL_KEY: "sk-live" } } },
      );
      expect(envOf(override)).toMatchObject({ FAL_KEY: "sk-live", PROBE_PORT: "4820" });
    });

    it("wins over the same name declared by the plugin's own fragment", () => {
      const shadowing = {
        ...probe,
        pluginDefinition: { ...probe.pluginDefinition, environment: { FAL_KEY: "fragment-literal" } },
      };
      const override = generateComposeOverride(
        [shadowing],
        { ...baseOpts, pluginServiceEnv: { probe: { FAL_KEY: "sk-live" } } },
      );
      expect(envOf(override).FAL_KEY).toBe("sk-live");
    });

    it("never overrides one of ShipIt's own contract variables", () => {
      const override = generateComposeOverride(
        [probe],
        { ...baseOpts, pluginServiceEnv: { probe: { SHIPIT_PROJECT_DIR: "/elsewhere" } } },
      );
      expect(envOf(override).SHIPIT_PROJECT_DIR).toBe("/project");
    });

    it("escapes a value so Compose interpolates nothing from the orchestrator", () => {
      const override = generateComposeOverride(
        [probe],
        { ...baseOpts, pluginServiceEnv: { probe: { FAL_KEY: `a$b$\{GITHUB_TOKEN}` } } },
      );
      expect(override).toContain(`a$$b$$\{GITHUB_TOKEN}`);
      expect(override).not.toContain(`a$b$\{GITHUB_TOKEN}`);
    });

    it("never injects an environment into one of the project's own services", () => {
      const override = generateComposeOverride(
        [{ name: "probe", secrets: ["DATABASE_URL"] }],
        { ...baseOpts, pluginServiceEnv: { probe: { FAL_KEY: "sk-live" } } },
      );
      expect(override).not.toContain("sk-live");
    });

    it("delivers nothing when the project has no value, and does not hijack the entrypoint", () => {
      const override = generateComposeOverride(
        [probe],
        {
          ...baseOpts,
          pluginServiceEnv: { probe: {} },
          dockerSecrets: {
            secretNames: ["DATABASE_URL"],
            perService: { probe: ["DATABASE_URL"] },
            filePathFor: (name: string) => `/host/secrets/test-session-123/${name}`,
            entrypointHostPath: "/host/secrets/_entrypoint/secrets-entrypoint.sh",
          },
        },
      );
      expect(override).toContain("/plugin/bin/serve");
      expect(override).not.toContain("secrets-entrypoint.sh");
      expect(override).not.toContain("env_file");
    });
  });
});

describe("generateComposeOverride — Docker-secrets mode", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  function dockerSecretsOpts(perService: Record<string, string[]>) {
    const allNames = [...new Set(Object.values(perService).flat())].sort();
    return {
      secretNames: allNames,
      perService,
      filePathFor: (name: string) => `/host/secrets/test-session-123/${name}`,
      entrypointHostPath: "/host/secrets/_entrypoint/secrets-entrypoint.sh",
    };
  }

  it("emits top-level secrets block with file references", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).toContain("secrets:");
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).toContain("/host/secrets/test-session-123/DATABASE_URL");
  });

  it("emits per-service secrets references with shipit- prefix", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
      ],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({
          web: ["STRIPE_KEY"],
          api: ["DATABASE_URL", "STRIPE_KEY"],
        }),
      },
    );
    expect(override).toContain("shipit-STRIPE_KEY");
    expect(override).toContain("shipit-DATABASE_URL");
  });

  it("does NOT emit env_file when Docker-secrets mode is active", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).not.toContain("env_file");
    expect(override).not.toContain(".shipit/.env.api");
  });

  it("sets entrypoint to the wrapper script", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).toContain("/shipit/secrets-entrypoint.sh");
  });

  it("does NOT add secrets / entrypoint for services without declared secrets", () => {
    const override = generateComposeOverride(
      [
        { name: "api", secrets: ["DATABASE_URL"] },
        { name: "redis" },
      ],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    const redisIdx = override.indexOf("redis:");
    const apiIdx = override.indexOf("api:");
    expect(redisIdx).toBeGreaterThan(0);
    expect(apiIdx).toBeGreaterThan(0);
    const afterRedis = override.slice(redisIdx, redisIdx + 200);
    expect(afterRedis).not.toContain("secrets-entrypoint");
  });

  it("bind-mounts the wrapper from its absolute staged path, even with a workspace volume", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"], volumes: [".:/app"] }],
      {
        ...baseOpts,
        workspaceVolume: "shipit-dev_workspace",
        workspaceSubpath: "sessions/test-session-123/workspace",
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    const parsed = parseYaml(override) as {
      services: Record<string, { volumes?: Record<string, unknown>[]; entrypoint?: string[] }>;
    };
    const wrapper = parsed.services.api!.volumes!.find(
      (v) => v.target === "/shipit/secrets-entrypoint.sh",
    );
    expect(wrapper).toEqual({
      type: "bind",
      source: "/host/secrets/_entrypoint/secrets-entrypoint.sh",
      target: "/shipit/secrets-entrypoint.sh",
      read_only: true,
    });
    expect(parsed.services.api!.entrypoint).toEqual(["/shipit/secrets-entrypoint.sh"]);
    expect(override).not.toContain(".shipit/secrets-entrypoint.sh");
  });

  it("omits the entrypoint hijack when the wrapper could not be staged", () => {
    const { entrypointHostPath: _dropped, ...noEntrypoint } = dockerSecretsOpts({
      api: ["DATABASE_URL"],
    });
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      { ...baseOpts, dockerSecrets: noEntrypoint },
    );
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).not.toContain("secrets-entrypoint");
  });
});

describe("generateComposeOverride — overlay dep-dir mounts (docs/183 Phase 5)", () => {
  const baseOpts = {
    sessionId: "sess123abcdef",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    workspaceVolume: "shipit-ws",
  };

  type Vol =
    | string
    | { type?: string; source?: string; target?: string; volume?: { subpath?: string }; read_only?: boolean };
  interface OverrideDoc {
    services: Record<string, { volumes?: Vol[] }>;
    volumes?: Record<string, { name?: string; external?: boolean; labels?: Record<string, string> }>;
  }
  const overrideDoc = (override: string): OverrideDoc => parseYaml(override) as OverrideDoc;
  const isObj = (v: Vol): v is Exclude<Vol, string> => typeof v === "object";

  const NM = { depDir: "node_modules", volumeName: "shipit-sess123abcde_overlay-aaaa1111" };

  it("appends a nested overlay mount for a root workspace mount, keeping the workspace mount", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app"] }],
      { ...baseOpts, workspaceSubpath: "sessions/abc/workspace", overlayDepDirs: [NM] },
    );
    const doc = overrideDoc(override);
    const vols = doc.services.web.volumes ?? [];
    expect(vols).toContainEqual(
      expect.objectContaining({ source: "shipit-workspace", target: "/app" }),
    );
    expect(vols).toContainEqual({ type: "volume", source: NM.volumeName, target: "/app/node_modules" });
    expect(doc.volumes?.[NM.volumeName]).toEqual({ name: NM.volumeName, external: true });
  });

  it("appends one overlay mount per dep dir reachable from the mount", () => {
    const dirs = [
      { depDir: "node_modules", volumeName: "vol-nm" },
      { depDir: "packages/api/node_modules", volumeName: "vol-api" },
    ];
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app"] }],
      { ...baseOpts, overlayDepDirs: dirs },
    );
    const vols = overrideDoc(override).services.web.volumes ?? [];
    expect(vols).toContainEqual({ type: "volume", source: "vol-nm", target: "/app/node_modules" });
    expect(vols).toContainEqual({
      type: "volume",
      source: "vol-api",
      target: "/app/packages/api/node_modules",
    });
  });

  it("maps dep dirs through a subdir mount and skips dep dirs outside it", () => {
    const override = generateComposeOverride(
      [{ name: "api", volumes: ["./backend:/srv"] }],
      {
        ...baseOpts,
        overlayDepDirs: [
          { depDir: "backend/node_modules", volumeName: "vol-be" },
          { depDir: "node_modules", volumeName: "vol-root" },
        ],
      },
    );
    const doc = overrideDoc(override);
    const vols = doc.services.api.volumes ?? [];
    expect(vols).toContainEqual({ type: "volume", source: "vol-be", target: "/srv/node_modules" });
    expect(vols.some((v) => isObj(v) && v.source === "vol-root")).toBe(false);
    expect(doc.volumes?.["vol-be"]).toEqual({ name: "vol-be", external: true });
    expect(doc.volumes?.["vol-root"]).toBeUndefined();
  });

  it("targets the overlay volume root (no subpath) and never an overlay-base/ or storage subpath", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app"] }],
      { ...baseOpts, workspaceSubpath: "sessions/abc/workspace", overlayDepDirs: [NM] },
    );
    const mount = (overrideDoc(override).services.web.volumes ?? []).find(
      (v) => isObj(v) && v.source === NM.volumeName,
    );
    expect(mount && isObj(mount) ? mount.volume : "missing").toBeUndefined();
    expect(override).not.toContain("overlay-base");
    expect(override).not.toContain("sessions/abc/workspace/node_modules");
  });

  it("adds no overlay mounts to a service without a workspace mount", () => {
    const override = generateComposeOverride(
      [{ name: "db", volumes: ["pgdata:/var/lib/postgresql/data"] }],
      { ...baseOpts, overlayDepDirs: [NM] },
    );
    const doc = overrideDoc(override);
    const vols = doc.services.db.volumes ?? [];
    expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
    expect(doc.volumes?.[NM.volumeName]).toBeUndefined();
  });

  it("emits nothing overlay-related when overlayDepDirs is absent (non-overlay session unchanged)", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app"] }],
      { ...baseOpts },
    );
    expect(override).not.toContain("overlay");
  });

  it("replaces a direct dep-dir mount with the overlay volume (no duplicate target)", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app", "./node_modules:/app/node_modules"] }],
      { ...baseOpts, workspaceSubpath: "s/w", overlayDepDirs: [NM] },
    );
    const vols = overrideDoc(override).services.web.volumes ?? [];
    const atNodeModules = vols.filter((v) => isObj(v) && v.target === "/app/node_modules");
    expect(atNodeModules).toEqual([
      { type: "volume", source: NM.volumeName, target: "/app/node_modules" },
    ]);
  });

  it("drops an anonymous volume at a dep dir rather than declaring two mounts there", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app", "/app/node_modules"] }],
      { ...baseOpts, workspaceSubpath: "s/w", overlayDepDirs: [NM] },
    );
    const vols = overrideDoc(override).services.web.volumes ?? [];
    expect(vols.filter((v) => (isObj(v) ? v.target : v) === "/app/node_modules")).toEqual([
      { type: "volume", source: NM.volumeName, target: "/app/node_modules" },
    ]);
    expect(vols).toContainEqual(expect.objectContaining({ source: "shipit-workspace", target: "/app" }));
  });

  it("keeps an anonymous volume that is not at a dep dir", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app", "/app/.cache"] }],
      { ...baseOpts, workspaceSubpath: "s/w", overlayDepDirs: [NM] },
    );
    expect(overrideDoc(override).services.web.volumes ?? []).toContain("/app/.cache");
  });

  it("nests dep-dir overlays through a subdir mount written with a trailing slash", () => {
    const override = generateComposeOverride(
      [{ name: "game", volumes: ["./game/:/app"] }],
      {
        ...baseOpts,
        workspaceSubpath: "s/w",
        overlayDepDirs: [{ depDir: "game/node_modules", volumeName: "vol-game" }],
      },
    );
    const vols = overrideDoc(override).services.game.volumes ?? [];
    expect(vols).toContainEqual({ type: "volume", source: "vol-game", target: "/app/node_modules" });
    expect(vols).toContainEqual(
      expect.objectContaining({ target: "/app", volume: { subpath: "s/w/game" } }),
    );
  });

  describe("plugin services (docs/262)", () => {
    const WS = "sessions/abc/workspace";
    const pluginService = (
      volumes: unknown[],
      self = true,
    ): Parameters<typeof generateComposeOverride>[0][number] => ({
      name: "probe",
      origin: { kind: "plugin", repo: "tools", alias: "tools", plugin: "probe", sourceName: "probe", self },
      pluginDefinition: { image: "node:22-alpine", volumes },
    });
    const projectMount = { type: "volume", source: "shipit-workspace", target: "/project", volume: { subpath: WS } };
    const stateMount = {
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-state",
      volume: { subpath: "sessions/abc/plugin-data/tools/state" },
    };

    it("nests the overlay dep dir under both working-tree mounts of a `repo: self` plugin", () => {
      const selfPluginMount = {
        type: "volume",
        source: "shipit-workspace",
        target: "/plugin",
        volume: { subpath: WS },
      };
      const doc = overrideDoc(generateComposeOverride(
        [pluginService([selfPluginMount, projectMount])],
        { ...baseOpts, workspaceSubpath: WS, overlayDepDirs: [NM] },
      ));
      const vols = doc.services.probe.volumes ?? [];
      expect(vols).toContainEqual(projectMount);
      expect(vols).toContainEqual({ type: "volume", source: NM.volumeName, target: "/plugin/node_modules" });
      expect(vols).toContainEqual({ type: "volume", source: NM.volumeName, target: "/project/node_modules" });
      expect(doc.volumes?.[NM.volumeName]).toEqual({ name: NM.volumeName, external: true });
    });

    it("leaves the state dir alone — plugin-data/ is a sibling of workspace/, not a child", () => {
      const vols = overrideDoc(generateComposeOverride(
        [pluginService([stateMount])],
        { ...baseOpts, workspaceSubpath: WS, overlayDepDirs: [NM] },
      )).services.probe.volumes ?? [];
      expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
    });

    it("adds nothing for a TRACKED plugin, including at its /project mount", () => {
      const generationMount = { type: "volume", source: "shipit-abc_plugin-tools", target: "/plugin", read_only: true };
      const doc = overrideDoc(generateComposeOverride(
        [pluginService([generationMount, projectMount], false)],
        { ...baseOpts, workspaceSubpath: WS, overlayDepDirs: [NM] },
      ));
      const vols = doc.services.probe.volumes ?? [];
      expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
      expect(doc.volumes?.[NM.volumeName]).toBeUndefined();
    });

    it("maps a fragment's own subdirectory mount and skips dep dirs outside it", () => {
      const fragmentMount = {
        type: "volume",
        source: "shipit-workspace",
        target: "/app",
        volume: { subpath: `${WS}/packages/api` },
      };
      const vols = overrideDoc(generateComposeOverride(
        [pluginService([fragmentMount])],
        {
          ...baseOpts,
          workspaceSubpath: WS,
          overlayDepDirs: [NM, { depDir: "packages/api/node_modules", volumeName: "vol-api" }],
        },
      )).services.probe.volumes ?? [];
      expect(vols).toContainEqual({ type: "volume", source: "vol-api", target: "/app/node_modules" });
      expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
    });
  });
});

describe("isDevKvmAllowed (docs/213 operator kill-switch)", () => {
  it("defaults to allowed when unset", () => {
    expect(isDevKvmAllowed({})).toBe(true);
  });

  it("treats 0/false/no/off (any case) as disabled", () => {
    for (const v of ["0", "false", "FALSE", "no", "Off", " off "]) {
      expect(isDevKvmAllowed({ SESSION_ALLOW_DEV_KVM: v })).toBe(false);
    }
  });

  it("treats any other value as allowed", () => {
    for (const v of ["1", "true", "yes", "on", ""]) {
      expect(isDevKvmAllowed({ SESSION_ALLOW_DEV_KVM: v })).toBe(true);
    }
  });
});

describe("validateDevices (docs/213 — only /dev/kvm)", () => {
  it("is a no-op when devices is absent", () => {
    expect(() => validateDevices("svc", { image: "x" }, true)).not.toThrow();
  });

  it("accepts the exact /dev/kvm mapping in every supported form", () => {
    const forms: unknown[] = [
      "/dev/kvm",
      "/dev/kvm:/dev/kvm",
      "/dev/kvm:/dev/kvm:rwm",
      { source: "/dev/kvm", target: "/dev/kvm" },
      { source: "/dev/kvm" },
    ];
    for (const dev of forms) {
      expect(() => validateDevices("emulator", { devices: [dev] }, true)).not.toThrow();
    }
    expect(ALLOWED_DEVICE).toBe("/dev/kvm");
  });

  it("rejects any other device, and a /dev/kvm host remapped to another container device", () => {
    const bad: unknown[] = [
      "/dev/sda",
      "/dev/sda:/dev/sda",
      "/dev/snd:/dev/snd:rwm",
      "/dev/kvm:/dev/sda",
      "/dev/sda:/dev/kvm",
      { source: "/dev/sda", target: "/dev/sda" },
    ];
    for (const dev of bad) {
      expect(() => validateDevices("svc", { devices: [dev] }, true)).toThrow("is not allowed");
    }
  });

  it("rejects a non-list devices value", () => {
    expect(() => validateDevices("svc", { devices: "/dev/kvm" }, true)).toThrow("must be a list");
  });

  it("rejects even /dev/kvm when the operator kill-switch is off", () => {
    expect(() => validateDevices("emulator", { devices: ["/dev/kvm:/dev/kvm"] }, false))
      .toThrow("disabled on this deployment");
  });
});

describe("container ports (#2325)", () => {
  it("reads the container port out of every mapping form", () => {
    expect(extractContainerPort("5173")).toBe(5173);
    expect(extractContainerPort("5173:5173")).toBe(5173);
    expect(extractContainerPort("8080:80")).toBe(80);
    expect(extractContainerPort("5173:5173/tcp")).toBe(5173);
    expect(extractContainerPort("127.0.0.1:8080:80")).toBe(80);
    expect(extractContainerPort("")).toBeUndefined();
    expect(extractContainerPort("nonsense")).toBeUndefined();
  });
});
