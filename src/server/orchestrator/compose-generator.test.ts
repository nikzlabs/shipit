import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { SESSION_CPU_SHARES } from "./container-config-builder.js";
import {
  extractContainerPort,
  parseComposeContent,
  validateResolvedModel,
  rewriteResolvedModel,
  serializeComposeModel,
  composeBuildModel,
  pluginStubModel,
  generateComposeOverride,
  writeRootOnlyFile,
  ComposeValidationError,
  validateDevices,
  isDevKvmAllowed,
  ALLOWED_DEVICE,
  parseStopGracePeriodMs,
  UNKNOWN_STOP_GRACE_PERIOD_MS,
  TRUSTED_OPS_PROXY_IMAGE,
  CLASSIFIED_SERVICE_FIELDS,
  type ComposeParseOptions,
  type ComposeService,
} from "./compose-generator.js";
import { fakeResolvedModel } from "./compose-test-helpers.js";
import { OPS_TEMPLATE } from "./templates-ops.js";

const PROJECT = "shipit-test";

/** What a start runs on the file: the raw gate, then validation of the model Compose resolves. */
function parseComposeFile(
  file: string,
  opts: ComposeParseOptions,
  env?: Record<string, string>,
): ComposeService[] {
  const raw = fs.readFileSync(file, "utf-8");
  const services = parseComposeContent(raw, opts);
  const workspaceDir = path.dirname(file);
  const model = fakeResolvedModel(raw, { workspaceDir, project: PROJECT, ...(env ? { env } : {}) });
  validateResolvedModel(model, { ...opts, project: PROJECT, workspaceDir });
  return services;
}

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
    expect(() => parseComposeFile(p, { dockerSocket: true })).toThrow("project.allowDockerSocket");
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "granted" })).not.toThrow();
  });

  it("rejects lifecycle hooks in contained services", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    post_start:\n      - command: /bin/true\n`);
    expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true })).toThrow("lifecycle hooks");
    expect(() => parseComposeFile(p, { dockerSocket: false })).not.toThrow();
  });

  it("rejects a privileged lifecycle hook in every mode", () => {
    const dir = setup();
    for (const field of ["post_start", "pre_stop"]) {
      for (const value of ["true", '"yes"']) {
        const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    ${field}:\n      - command: /bin/true\n        privileged: ${value}\n`);
        expect(() => parseComposeFile(p, { dockerSocket: false }), `${field} ${value}`)
          .toThrow(`${field}[0].privileged`);
      }
    }
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

  it("rejects build.network: host in every mode", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  app:
    user: "1001"
    build:
      context: .
      network: host
`);
    for (const containEgress of [true, false]) {
      expect(() => parseComposeFile(p, { dockerSocket: false, containEgress }))
        .toThrow(/`build.network: host` is not allowed\. A build may use only/);
    }
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
    expect(() => parseComposeFile(interpolated, { dockerSocket: false, containEgress: true }, { BUILD_NET: "host" }))
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

  it("rejects build.privileged and build.entitlements in every mode", () => {
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
    expect(() => parseComposeFile(privileged, { dockerSocket: false })).toThrow("build.privileged");
    expect(() => parseComposeFile(privileged, { dockerSocket: false })).not.toThrow("contained");

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
    expect(() => parseComposeFile(entitlements, { dockerSocket: false })).toThrow("build.entitlements");

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
    image: ${TRUSTED_OPS_PROXY_IMAGE}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("server-created ops sessions");
  });

  it("allows a Docker socket mount only with the key and the user's grant", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "granted" })).toHaveLength(1);
    expect(() => parseComposeFile(p, { dockerSocket: true }))
      .toThrow(/needs the user's permission.*`project\.allowDockerSocket`.*Project Settings → Deployments/);
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "not_granted" }))
      .toThrow("project.allowDockerSocket");
    expect(() => parseComposeFile(p, { dockerSocket: false, dockerSocketGrant: "granted" }))
      .toThrow(/compose\.docker-socket: true.*project\.allowDockerSocket/);
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "no_repository" }))
      .toThrow(/without a repository.*"Docker access" in Session settings/);
  });

  it("gives a sandbox no socket through use_api_socket either", () => {
    const dir = setup();
    const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    use_api_socket: "true"\n`);
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "no_repository" }))
      .toThrow("Docker access");
    expect(() => parseComposeFile(p, { dockerSocket: true })).toThrow("project.allowDockerSocket");
  });

  it("matches the socket source exactly", () => {
    const dir = setup();
    for (const source of ["/var/run/docker.sock.bak", "/var/run/docker.sock-x", "/run/docker.sock"]) {
      const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    volumes:\n      - ${source}:/s\n`);
      expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "granted" }), source)
        .toThrow("Absolute bind mount path");
    }
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
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "granted", containEgress: true }))
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

  it("allows the trusted ops proxy without the grant, in both modes", () => {
    const dir = setup();
    const environment = trustedProxyEnvironment();
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
    for (const containEgress of [true, false]) {
      for (const dockerSocket of [true, false]) {
        const [svc] = parseComposeFile(p, { dockerSocket, containEgress, trustedOpsProxy: true });
        expect(svc.trustedOpsProxy).toBe(true);
      }
    }
  });

  it("accepts the ops template's own proxy in an ops session without the grant", () => {
    const dir = setup();
    const p = writeCompose(dir, OPS_TEMPLATE.files["docker-compose.yml"]!);
    for (const containEgress of [true, false]) {
      const [svc] = parseComposeFile(p, { dockerSocket: true, containEgress, trustedOpsProxy: true });
      expect(svc.trustedOpsProxy).toBe(true);
    }
  });

  it("trusts an older ops file's tag-only proxy and runs the pinned image", () => {
    const dir = setup();
    const legacy = OPS_TEMPLATE.files["docker-compose.yml"]!
      .replace(TRUSTED_OPS_PROXY_IMAGE, "tecnativa/docker-socket-proxy:0.3.0");
    expect(legacy).not.toContain(TRUSTED_OPS_PROXY_IMAGE);
    const services = parseComposeFile(writeCompose(dir, legacy), { dockerSocket: true, trustedOpsProxy: true });
    const proxy = services.find((svc) => svc.name === "docker-socket-proxy");
    expect(proxy?.trustedOpsProxy).toBe(true);
    const override = parseYaml(generateComposeOverride(services, { sessionId: "s1", composeConfig: { file: "docker-compose.yml", dockerSocket: false } })) as {
      services: Record<string, { image?: string }>;
    };
    expect(override.services["docker-socket-proxy"].image).toBe(TRUSTED_OPS_PROXY_IMAGE);
  });

  describe("does not trust an ops proxy that differs from the template", () => {
    const environment = trustedProxyEnvironment();
    const socket = "    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n";
    const cases: Record<string, string> = {
      "another tag": `    image: tecnativa/docker-socket-proxy:latest\n    environment:\n${environment}\n${socket}`,
      "a build definition": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    build: .\n    environment:\n${environment}\n${socket}`,
      "an extra bind mount": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${environment}\n${socket}      - ./proxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro\n`,
      "a healthcheck": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${environment}\n    healthcheck:\n      test: [CMD-SHELL, 'true']\n${socket}`,
      "a lifecycle hook": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${environment}\n    post_start:\n      - command: /bin/true\n${socket}`,
      "extends": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    extends: { file: base.yml, service: proxy }\n    environment:\n${environment}\n${socket}`,
      "volumes_from": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    volumes_from: [web]\n    environment:\n${environment}\n${socket}`,
      "a secrets declaration": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    x-shipit-secrets: [POST]\n    environment:\n${environment}\n${socket}`,
      "an unapproved environment key": `    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${trustedProxyEnvironment("      ALLOW_START: 1")}\n${socket}`,
    };
    const extraFiles: Record<string, Record<string, string>> = {
      extends: { "base.yml": "services:\n  proxy:\n    healthcheck:\n      test: [CMD-SHELL, 'true']\n" },
    };
    for (const [label, body] of Object.entries(cases)) {
      it(label, () => {
        const dir = setup();
        for (const [name, content] of Object.entries(extraFiles[label] ?? {})) {
          fs.writeFileSync(path.join(dir, name), content);
        }
        const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n  docker-socket-proxy:\n${body}`);
        expect(() => parseComposeFile(p, { dockerSocket: true, containEgress: true, trustedOpsProxy: true }))
          .toThrow(ComposeValidationError);
        expect(() => parseComposeFile(p, { dockerSocket: true, trustedOpsProxy: true }))
          .toThrow(`only as the ops template defines it, with image \`${TRUSTED_OPS_PROXY_IMAGE}\``);
      });
    }
  });

  it("does not trust list-form proxy environment inherited from a project env file", () => {
    const dir = setup();
    const allowed = ["CONTAINERS", "EVENTS", "IMAGES", "INFO", "NETWORKS", "VOLUMES", "VERSION", "PING"];
    const denied = ["POST", "BUILD", "COMMIT", "EXEC", "AUTH", "CONFIGS", "DISTRIBUTION",
      "GRPC", "NODES", "PLUGINS", "SECRETS", "SERVICES", "SESSION", "SWARM", "SYSTEM", "TASKS"];
    const environment = [...allowed.map((key) => `      - ${key}=1`),
      ...denied.map((key) => `      - ${key}=0`), "      - ALLOW_START"].join("\n");
    const p = writeCompose(dir, `services:\n  docker-socket-proxy:\n    image: ${TRUSTED_OPS_PROXY_IMAGE}\n    environment:\n${environment}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`);
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

  it("gives an Open ops session without the grant only the proxy's socket", () => {
    const dir = setup();
    const p = writeCompose(dir, `${OPS_TEMPLATE.files["docker-compose.yml"]!}
  tool:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(() => parseComposeFile(p, { dockerSocket: true, trustedOpsProxy: true }))
      .toThrow(/Service `tool`: a Docker socket mount needs the user's permission/);
    expect(() => parseComposeFile(p, { dockerSocket: true, dockerSocketGrant: "granted", trustedOpsProxy: true }))
      .not.toThrow();
  });

  it("refuses any other service that builds or names the proxy image in an ops session", () => {
    const dir = setup();
    for (const extra of [
      "    image: tecnativa/docker-socket-proxy:0.3.0\n    build: .\n",
      `    image: docker.io/${TRUSTED_OPS_PROXY_IMAGE}\n`,
      "    build:\n      context: .\n      tags: [\"tecnativa/docker-socket-proxy:latest\"]\n",
    ]) {
      const p = writeCompose(dir, `${OPS_TEMPLATE.files["docker-compose.yml"]!}\n  other:\n${extra}`);
      expect(() => parseComposeFile(p, { dockerSocket: true, trustedOpsProxy: true }), extra)
        .toThrow("Service `other`: image");
    }
    const unrelated = writeCompose(dir, `${OPS_TEMPLATE.files["docker-compose.yml"]!}\n  other:\n    image: tecnativa/other:1\n`);
    expect(() => parseComposeFile(unrelated, { dockerSocket: true, trustedOpsProxy: true })).not.toThrow();
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

  it("rejects a home-relative bind source: Compose expands `~` on the host that runs it", () => {
    const dir = setup();
    for (const volume of ["~/.ssh:/keys", "~:/home", "{ type: bind, source: ~/.docker, target: /d }"]) {
      const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    volumes:\n      - ${volume}\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false }), volume).toThrow("home-relative");
    }
  });

  it("rejects a service that names ShipIt's workspace volumes, in every form", () => {
    const dir = setup();
    const forms = [
      "shipit-workspace:/everything",
      "shipit-session-workspace:/app",
      "{ type: volume, source: shipit-workspace, target: /b, volume: { subpath: sessions/other/workspace } }",
      "{ type: volume, source: shipit-session-workspace, target: /c }",
    ];
    for (const volume of forms) {
      const p = writeCompose(dir, `services:\n  web:\n    image: node:20\n    volumes:\n      - ${volume}\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false }), volume).toThrow("reserved for ShipIt");
      expect(() => parseComposeFile(p, { dockerSocket: false, containEgress: true }), volume)
        .toThrow("reserved for ShipIt");
    }
  });

  it("rejects a top-level declaration of ShipIt's workspace volume names", () => {
    const dir = setup();
    for (const name of ["shipit-workspace", "shipit-session-workspace"]) {
      const p = writeCompose(dir, `services:\n  web:\n    image: node:20\nvolumes:\n  ${name}: {}\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false }), name).toThrow("reserved for ShipIt");
    }
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
    expect(() => parseComposeContent(fs.readFileSync(p), { dockerSocket: false })).not.toThrow();
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
volumes:
  mydata:
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(1);
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

describe("settings that reach outside the service (docs/318 req 7)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  let written = 0;
  function file(content: string): string {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "compose-req7-"));
    const p = path.join(tmpDir, `compose-${written++}.yml`);
    fs.writeFileSync(p, content);
    return p;
  }

  function service(lines: string, extra = ""): string {
    return file(`services:\n  web:\n    image: node:20\n    user: "1001"\n${lines}${extra}`);
  }

  const bothModes = [false, true];

  it("refuses provider in every mode", () => {
    const p = service("    provider:\n      type: model\n");
    for (const containEgress of bothModes) {
      expect(() => parseComposeFile(p, { dockerSocket: false, containEgress })).toThrow("`provider` is not allowed");
    }
  });

  it("refuses host and container: namespaces in every mode, and keeps service: and private ones", () => {
    for (const field of ["pid", "ipc", "network_mode", "uts", "cgroup", "userns_mode"]) {
      for (const value of ["host", "HOST", "container:abc123"]) {
        const p = service(`    ${field}: "${value}"\n`);
        for (const containEgress of bothModes) {
          expect(() => parseComposeFile(p, { dockerSocket: false, containEgress }), `${field}: ${value}`)
            .toThrow(`\`${field}: ${value}\` is not allowed`);
        }
      }
    }
    for (const [field, value] of [["pid", "service:db"], ["ipc", "private"], ["ipc", "service:db"],
      ["network_mode", "none"], ["network_mode", "service:db"], ["cgroup", "private"]]) {
      const p = file(`services:\n  db:\n    image: postgres:16\n  web:\n    image: node:20\n    ${field}: "${value}"\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false }), `${field}: ${value}`).not.toThrow();
    }
  });

  it("allows volumes_from only for a service of this project", () => {
    const own = file("services:\n  db:\n    image: postgres:16\n  web:\n    image: node:20\n    volumes_from: [\"db:ro\"]\n");
    expect(() => parseComposeFile(own, { dockerSocket: false })).not.toThrow();
    const other = service("    volumes_from: [\"container:other-session-db\"]\n");
    expect(() => parseComposeFile(other, { dockerSocket: false }))
      .toThrow("`volumes_from: container:other-session-db` is not allowed. Name a service of this project");
  });

  it("refuses external and renamed top-level secrets and configs", () => {
    for (const kind of ["secrets", "configs"]) {
      const external = service("", `${kind}:\n  token:\n    external: true\n`);
      expect(() => parseComposeFile(external, { dockerSocket: false }), kind).toThrow("`external: true` is not allowed");
      const named = service("", `${kind}:\n  token:\n    file: ./token\n    name: shared-token\n`);
      expect(() => parseComposeFile(named, { dockerSocket: false }), kind).toThrow("`name: shared-token` is not allowed");
      const plain = service("", `${kind}:\n  token:\n    file: ./token\n    external: "false"\n`);
      expect(() => parseComposeFile(plain, { dockerSocket: false }), kind).not.toThrow();
    }
  });

  it("allows only safe added capabilities in Open sessions", () => {
    const ok = service("    cap_add: [NET_ADMIN, cap_sys_ptrace, CAP_CHOWN, ipc_lock, SYS_NICE]\n");
    expect(() => parseComposeFile(ok, { dockerSocket: false })).not.toThrow();
    expect(() => parseComposeFile(ok, { dockerSocket: false, containEgress: true })).toThrow("cap_add");
    for (const cap of ["ALL", "SYS_ADMIN", "CAP_SYS_MODULE", "NET_RAW", "DAC_READ_SEARCH"]) {
      const p = service(`    cap_add: [${cap}]\n`);
      expect(() => parseComposeFile(p, { dockerSocket: false }), cap)
        .toThrow(`\`cap_add: ${cap}\` is not allowed. A service may add only NET_ADMIN`);
    }
  });

  it("allows only no-new-privileges in security_opt, in every mode", () => {
    for (const value of ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"]) {
      const p = service(`    security_opt: ["${value}"]\n`);
      for (const containEgress of bothModes) {
        expect(() => parseComposeFile(p, { dockerSocket: false, containEgress }), value).not.toThrow();
      }
    }
    for (const value of ["seccomp:unconfined", "apparmor=unconfined", "label:disable", "no-new-privileges:false"]) {
      const p = service(`    security_opt: ["${value}"]\n`);
      for (const containEgress of bothModes) {
        expect(() => parseComposeFile(p, { dockerSocket: false, containEgress }), value)
          .toThrow(`\`security_opt: ${value}\` is not allowed`);
      }
    }
  });

  it("refuses device_cgroup_rules and device reservations in every mode", () => {
    const rules = service("    device_cgroup_rules: [\"c 1:3 mr\"]\n");
    const reserved = service("    deploy:\n      resources:\n        reservations:\n          devices:\n            - capabilities: [gpu]\n");
    for (const containEgress of bothModes) {
      expect(() => parseComposeFile(rules, { dockerSocket: false, containEgress })).toThrow("device_cgroup_rules");
      expect(() => parseComposeFile(reserved, { dockerSocket: false, containEgress }))
        .toThrow("deploy.resources.reservations.devices");
    }
    const limits = service("    deploy:\n      resources:\n        limits: { cpus: \"1\", memory: 512M }\n");
    expect(() => parseComposeFile(limits, { dockerSocket: false })).not.toThrow();
  });

  it("allows only log drivers that keep logs local", () => {
    const local = service("    logging:\n      driver: json-file\n      options: { max-size: 10m }\n");
    expect(() => parseComposeFile(local, { dockerSocket: false })).not.toThrow();
    const remote = service("    logging:\n      driver: syslog\n");
    expect(() => parseComposeFile(remote, { dockerSocket: false })).toThrow("`logging.driver: syslog` is not allowed");
  });

  it("refuses a string privileged flag", () => {
    const p = service("    privileged: \"true\"\n");
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("`privileged: true` is not allowed");
  });

  it("checks label_file paths, and refuses it in contained sessions", () => {
    const ok = service("    label_file: ./labels.env\n");
    expect(() => parseComposeFile(ok, { dockerSocket: false })).not.toThrow();
    expect(() => parseComposeFile(ok, { dockerSocket: false, containEgress: true })).toThrow("`label_file`");
    const outside = service("    label_file: [/etc/labels]\n");
    expect(() => parseComposeFile(outside, { dockerSocket: false })).toThrow("absolute path");
  });

  it("refuses a service field ShipIt has not classified, naming it", () => {
    for (const key of ["gpus", "runtime", "cgroup_parent", "pre_start", "oom_score_adj", "not_a_field"]) {
      const p = service(`    ${key}: x\n`);
      for (const containEgress of bothModes) {
        expect(() => parseComposeFile(p, { dockerSocket: false, containEgress }), key)
          .toThrow(`the Compose field \`${key}\` is not supported`);
      }
    }
    const extension = service("    x-anything: { free: form }\n");
    expect(() => parseComposeFile(extension, { dockerSocket: false })).not.toThrow();
    expect([...CLASSIFIED_SERVICE_FIELDS].filter((key) => key.startsWith("x-"))).toEqual([]);
  });

  describe("a service holding the socket cannot be joined", () => {
    const granted = { dockerSocket: true, dockerSocketGrant: "granted" as const };
    const holder = "  sock:\n    image: docker:cli\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n";

    it("through volumes_from", () => {
      const p = file(`services:\n${holder}  web:\n    image: node:20\n    volumes_from: [sock]\n`);
      expect(() => parseComposeFile(p, granted))
        .toThrow("`volumes_from: sock` is not allowed, because `sock` has the Docker socket");
    });

    it("through a service: namespace", () => {
      for (const field of ["pid", "ipc", "network_mode"]) {
        const p = file(`services:\n${holder}  web:\n    image: node:20\n    ${field}: "service:sock"\n`);
        expect(() => parseComposeFile(p, granted), field)
          .toThrow(`\`${field}: service:sock\` is not allowed, because \`sock\` has the Docker socket`);
      }
    });

    it("when the socket comes from use_api_socket or another service's volumes", () => {
      const api = file("services:\n  sock:\n    image: docker:cli\n    use_api_socket: true\n  web:\n    image: node:20\n    pid: service:sock\n");
      expect(() => parseComposeFile(api, granted)).toThrow("because `sock` has the Docker socket");
      const chain = file(`services:\n${holder}  mid:\n    image: node:20\n    volumes_from: [sock]\n  web:\n    image: node:20\n    ipc: service:mid\n`);
      expect(() => parseComposeFile(chain, granted)).toThrow("has the Docker socket");
    });

    it("including the ops proxy in an ops session", () => {
      const p = file(`${OPS_TEMPLATE.files["docker-compose.yml"]!}\n  web:\n    image: node:20\n    pid: service:docker-socket-proxy\n`);
      for (const containEgress of bothModes) {
        expect(() => parseComposeFile(p, { dockerSocket: true, containEgress, trustedOpsProxy: true }))
          .toThrow("`pid: service:docker-socket-proxy` is not allowed");
      }
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

  // planning#584: the boot sweeps select by the stack label, and Compose adds none of its own.
  it("labels the session network with the stack, like the services", () => {
    const override = generateComposeOverride([{ name: "db" }], { ...baseOpts, stackName: "shipit-a" });
    const doc = parseYaml(override) as {
      services: Record<string, { labels: Record<string, string> }>;
      networks: Record<string, { labels?: Record<string, string> }>;
    };
    expect(doc.services.db.labels["shipit-stack"]).toBe("shipit-a");
    expect(doc.networks["shipit-session"].labels).toEqual({ "shipit-stack": "shipit-a" });

    const unscoped = parseYaml(generateComposeOverride([{ name: "db" }], baseOpts)) as {
      networks: Record<string, { labels?: unknown }>;
    };
    expect(unscoped.networks["shipit-session"].labels).toBeUndefined();
  });

  it("sets pull_policy: never only on the services this start builds", () => {
    const doc = parseYaml(generateComposeOverride(
      [{ name: "web" }, { name: "db" }],
      { ...baseOpts, builtServices: ["web"] },
    )) as { services: Record<string, { pull_policy?: string }> };
    expect(doc.services.web.pull_policy).toBe("never");
    expect(doc.services.db.pull_policy).toBeUndefined();
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
});

describe("rewriteResolvedModel", () => {
  const WS = "/workspace/sessions/abc/workspace";
  const rewriteOpts = {
    sessionId: "test-session-123",
    workspaceDir: WS,
    workspaceVolume: "shipit-ws-vol",
    workspaceSubpath: "sessions/abc/workspace",
  };
  interface Doc {
    services: Record<string, Record<string, unknown> & { volumes?: Record<string, unknown>[] }>;
    volumes?: Record<string, Record<string, unknown> & { labels?: Record<string, string> }>;
  }
  const bind = (source: string, target: string, extra: Record<string, unknown> = {}) =>
    ({ type: "bind", source, target, ...extra, bind: { create_host_path: true } });
  const stack = (volumes: unknown[], top: Record<string, unknown> = {}, name = "web") =>
    ({ name: PROJECT, services: { [name]: { image: "node:20", volumes } }, ...top });
  const rewrite = (model: Record<string, unknown>, opts: Parameters<typeof rewriteResolvedModel>[1] = rewriteOpts): Doc =>
    rewriteResolvedModel(model, opts).model as unknown as Doc;

  // planning#584: the boot sweeps select by the stack label, and Compose adds none of its own.
  it("labels the project's named volumes with the stack", () => {
    const model = stack(
      [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql/data", volume: {} }],
      { volumes: { pgdata: { name: `${PROJECT}_pgdata`, labels: { "com.example.keep": "true" } } } },
    );
    const doc = rewrite(model, { ...rewriteOpts, stackName: "shipit-a" });
    expect(doc.volumes?.pgdata.labels).toMatchObject({
      "com.example.keep": "true",
      "shipit-managed": "true",
      "shipit-session": "test-session-123",
      "shipit-stack": "shipit-a",
    });
    expect(rewrite(model).volumes?.pgdata.labels).not.toHaveProperty("shipit-stack");
  });

  it("rewrites workspace volumes when workspaceVolume is set", () => {
    const { model, workspaceMounts } = rewriteResolvedModel(stack([bind(WS, "/app")]), rewriteOpts);
    const doc = model as unknown as Doc;
    expect(doc.services.web.volumes).toEqual([
      { type: "volume", source: "shipit-workspace", target: "/app", volume: { subpath: "sessions/abc/workspace" } },
    ]);
    expect(doc.volumes).toEqual({ "shipit-workspace": { name: "shipit-ws-vol", external: true } });
    expect(workspaceMounts.get("web")).toEqual([{ relPath: "", target: "/app" }]);
  });

  it("keeps binds, and records them, without a workspace volume", () => {
    const mount = bind(`${WS}/backend`, "/app");
    const { model, workspaceMounts } = rewriteResolvedModel(
      stack([mount]),
      { sessionId: "test-session-123", workspaceDir: WS },
    );
    expect((model as unknown as Doc).services.web.volumes).toEqual([mount]);
    expect(workspaceMounts.get("web")).toEqual([{ relPath: "backend", target: "/app" }]);
  });

  describe("workspace subdirectory mounts", () => {
    const DEVICE = "/var/lib/docker/volumes/shipit-ws-vol/_data/sessions/abc/workspace";
    const volumeOpts = { ...rewriteOpts, workspaceDevice: DEVICE };
    const render = (volumes: unknown[], opts: Parameters<typeof rewriteResolvedModel>[1] = volumeOpts) =>
      rewrite(stack(volumes, {}, "api"), opts);

    it("mounts a subdirectory from a volume rooted at this session's workspace, not the shared one", () => {
      const doc = render([
        bind(`${WS}/backend`, "/app", { read_only: true }),
        { type: "bind", source: `${WS}/frontend`, target: "/web" },
      ]);
      expect(doc.services.api.volumes).toEqual([
        { type: "volume", source: "shipit-session-workspace", volume: { subpath: "backend" }, target: "/app", read_only: true },
        { type: "volume", source: "shipit-session-workspace", volume: { subpath: "frontend" }, target: "/web" },
      ]);
      expect(doc.volumes?.["shipit-session-workspace"]).toEqual({
        driver: "local",
        driver_opts: { type: "none", o: "bind", device: DEVICE },
        labels: { "shipit-managed": "true", "shipit-session": "test-session-123" },
      });
    });

    // Docker confines a subpath only to its volume's root, and the shared root holds every session.
    it("never emits a shared-volume subpath below the workspace directory itself", () => {
      const doc = render([
        bind(WS, "/a"), bind(`${WS}/`, "/b"), bind(`${WS}/.`, "/c"),
        bind(`${WS}/x`, "/d"), bind(`${WS}/x/./y/`, "/e"), bind(`${WS}/x//y`, "/f"),
      ]);
      const volumes = doc.services.api.volumes ?? [];
      const shared = volumes.filter((v) => v.source === "shipit-workspace");
      expect(shared.map((v) => v.target)).toEqual(["/a", "/b", "/c"]);
      for (const mount of shared) expect(mount.volume).toEqual({ subpath: "sessions/abc/workspace" });
      expect(volumes.filter((v) => v.source === "shipit-session-workspace").map((v) => v.volume))
        .toEqual([{ subpath: "x" }, { subpath: "x/y" }, { subpath: "x/y" }]);
    });

    it("declares no session volume for a stack that only mounts the whole workspace", () => {
      const doc = render([bind(WS, "/app")], { ...volumeOpts, workspaceDevice: undefined });
      expect(doc.volumes?.["shipit-session-workspace"]).toBeUndefined();
      expect(doc.volumes?.["shipit-workspace"]).toEqual({ name: "shipit-ws-vol", external: true });
    });

    it("refuses a subdirectory mount when the workspace's daemon path is unknown", () => {
      expect(() => render([bind(`${WS}/backend`, "/app")], { ...volumeOpts, workspaceDevice: undefined }))
        .toThrow("could not locate this session's workspace on the Docker host");
    });

    it("refuses to mount the workspace when its place in the shared volume is unknown", () => {
      expect(() => render([bind(WS, "/app")], { ...volumeOpts, workspaceSubpath: undefined }))
        .toThrow("could not locate this session inside the workspace volume");
    });
  });

  it("preserves read-only mode on rewritten volumes", () => {
    const doc = rewrite(stack([bind(WS, "/app", { read_only: true })]));
    expect(doc.services.web.volumes?.[0]).toMatchObject({ source: "shipit-workspace", read_only: true });
  });

  it("leaves non-workspace volumes untouched", () => {
    const pgdata = { type: "volume", source: "pgdata", target: "/var/lib/postgresql/data", volume: {} };
    const doc = rewrite(stack([pgdata], { volumes: { pgdata: { name: `${PROJECT}_pgdata` } } }));
    expect(doc.services.web.volumes).toEqual([pgdata]);
  });

  it("rewrites object-form workspace volumes", () => {
    const doc = rewrite(
      stack([{ type: "bind", source: WS, target: "/app" }]),
      { ...rewriteOpts, workspaceSubpath: "ws/dir" },
    );
    expect(doc.services.web.volumes).toEqual([
      { type: "volume", source: "shipit-workspace", target: "/app", volume: { subpath: "ws/dir" } },
    ]);
  });

  it("drops empty env_file, label_file and ports, and lists built services and project files", () => {
    const model = {
      name: PROJECT,
      services: {
        web: {
          image: "app:dev",
          build: { context: WS, dockerfile: "Dockerfile" },
          env_file: [],
          label_file: [],
          ports: [{ mode: "ingress", target: 80, published: "8080", protocol: "tcp" }],
        },
        db: { image: "postgres:16" },
      },
      secrets: { token: { name: `${PROJECT}_token`, file: `${WS}/token` } },
      configs: { app: { name: `${PROJECT}_app`, file: `${WS}/conf/app.ini` } },
    };
    const before = structuredClone(model);
    const { model: out, builtServices, projectFiles } = rewriteResolvedModel(model, rewriteOpts);
    expect((out as unknown as Doc).services.web).toEqual({ image: "app:dev", build: { context: WS, dockerfile: "Dockerfile" } });
    expect(builtServices).toEqual(["web"]);
    expect(projectFiles).toEqual([
      { kind: "secrets", name: "token", file: `${WS}/token` },
      { kind: "configs", name: "app", file: `${WS}/conf/app.ini` },
    ]);
    expect(model).toEqual(before);
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

  it("gives every service the session CPU weight so a sibling cannot outrank the orchestrator", () => {
    const override = generateComposeOverride(
      [
        { name: "web", shipitPreview: "auto" },
        { name: "docker-socket-proxy", shipitPreview: "manual", trustedOpsProxy: true },
      ],
      { ...baseOpts, composeConfig: { file: "docker-compose.yml", dockerSocket: true } },
    );
    const doc = parseYaml(override) as { services: Record<string, { cpu_shares?: number }> };
    expect(doc.services.web.cpu_shares).toBe(SESSION_CPU_SHARES);
    expect(doc.services["docker-socket-proxy"].cpu_shares).toBe(SESSION_CPU_SHARES);
    // Docker's default is 1024, which is what the weight has to beat.
    expect(SESSION_CPU_SHARES).toBeLessThan(1024);
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

describe("writeRootOnlyFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-write-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the content to the given file", () => {
    const file = path.join(setup(), "override.yml");
    expect(writeRootOnlyFile(file, "services: {}\n")).toBe(file);
    expect(fs.readFileSync(file, "utf-8")).toBe("services: {}\n");
  });

  it("writes the file 0600, including over a pre-existing looser file", () => {
    const file = path.join(setup(), "override.yml");
    fs.writeFileSync(file, "stale", { mode: 0o644 });
    writeRootOnlyFile(file, "services: {}\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates the target directory if it doesn't exist", () => {
    const file = path.join(setup(), "state", "compose", "override.yml");
    writeRootOnlyFile(file, "test");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("does not chown the file, even with the worker-uid flag set", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    try {
      const file = path.join(setup(), "override.yml");
      writeRootOnlyFile(file, "services: {}\n");
      const before = fs.lstatSync(file).uid;
      writeRootOnlyFile(file, "services: {}\n");
      expect(fs.lstatSync(file).uid).toBe(before);
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
      [{ name: "api", secrets: ["DATABASE_URL"], workspaceMounts: [{ relPath: "", target: "/app" }] }],
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
    workspaceSubpath: "sessions/abc/workspace",
    workspaceDevice: "/var/lib/docker/volumes/shipit-ws/_data/sessions/abc/workspace",
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

  const ROOT = [{ relPath: "", target: "/app" }];

  it("appends a nested overlay mount for a root workspace mount", () => {
    const override = generateComposeOverride(
      [{ name: "web", workspaceMounts: ROOT }],
      { ...baseOpts, workspaceSubpath: "sessions/abc/workspace", overlayDepDirs: [NM] },
    );
    const doc = overrideDoc(override);
    expect(doc.services.web.volumes).toContainEqual({ type: "volume", source: NM.volumeName, target: "/app/node_modules" });
    expect(doc.volumes?.[NM.volumeName]).toEqual({ name: NM.volumeName, external: true });
  });

  it("appends one overlay mount per dep dir reachable from the mount", () => {
    const dirs = [
      { depDir: "node_modules", volumeName: "vol-nm" },
      { depDir: "packages/api/node_modules", volumeName: "vol-api" },
    ];
    const override = generateComposeOverride(
      [{ name: "web", workspaceMounts: ROOT }],
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
      [{ name: "api", workspaceMounts: [{ relPath: "backend", target: "/srv" }] }],
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
      [{ name: "web", workspaceMounts: ROOT }],
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
      [{ name: "db" }],
      { ...baseOpts, overlayDepDirs: [NM] },
    );
    const doc = overrideDoc(override);
    const vols = doc.services.db.volumes ?? [];
    expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
    expect(doc.volumes?.[NM.volumeName]).toBeUndefined();
  });

  it("emits nothing overlay-related when overlayDepDirs is absent (non-overlay session unchanged)", () => {
    const override = generateComposeOverride(
      [{ name: "web", workspaceMounts: ROOT }],
      { ...baseOpts },
    );
    expect(override).not.toContain("overlay");
  });

  it("mounts one overlay at a dep dir that is also mounted directly (no duplicate target)", () => {
    const override = generateComposeOverride(
      [{ name: "web", workspaceMounts: [...ROOT, { relPath: "node_modules", target: "/app/node_modules" }] }],
      { ...baseOpts, workspaceSubpath: "s/w", overlayDepDirs: [NM] },
    );
    const vols = overrideDoc(override).services.web.volumes ?? [];
    const atNodeModules = vols.filter((v) => isObj(v) && v.target === "/app/node_modules");
    expect(atNodeModules).toEqual([
      { type: "volume", source: NM.volumeName, target: "/app/node_modules" },
    ]);
  });

  it("leaves anonymous volumes in the snapshot and mounts only the overlay at a dep dir", () => {
    const WS = "/workspace/sessions/abc/workspace";
    const anonymous = [
      { type: "volume", target: "/app/node_modules", volume: {} },
      { type: "volume", target: "/app/.cache", volume: {} },
    ];
    const { model, workspaceMounts } = rewriteResolvedModel(
      { services: { web: { image: "node:20", volumes: [{ type: "bind", source: WS, target: "/app" }, ...anonymous] } } },
      { sessionId: baseOpts.sessionId, workspaceDir: WS, workspaceVolume: "shipit-ws", workspaceSubpath: "s/w" },
    );
    const snapshot = (model as { services: { web: { volumes: unknown[] } } }).services.web.volumes;
    for (const mount of anonymous) expect(snapshot).toContainEqual(mount);
    const override = generateComposeOverride(
      [{ name: "web", workspaceMounts: workspaceMounts.get("web") }],
      { ...baseOpts, workspaceSubpath: "s/w", overlayDepDirs: [NM] },
    );
    expect(overrideDoc(override).services.web.volumes).toEqual([
      { type: "volume", source: NM.volumeName, target: "/app/node_modules" },
    ]);
  });

  it("nests dep-dir overlays through a subdir mount written with a trailing slash", () => {
    const WS = "/workspace/sessions/abc/workspace";
    const { model, workspaceMounts } = rewriteResolvedModel(
      { services: { game: { image: "node:20", volumes: [{ type: "bind", source: `${WS}/game/`, target: "/app" }] } } },
      { sessionId: baseOpts.sessionId, workspaceDir: WS, workspaceVolume: "shipit-ws", workspaceSubpath: "s/w", workspaceDevice: baseOpts.workspaceDevice },
    );
    expect((model as { services: { game: { volumes: unknown[] } } }).services.game.volumes).toContainEqual(
      expect.objectContaining({ source: "shipit-session-workspace", target: "/app", volume: { subpath: "game" } }),
    );
    const override = generateComposeOverride(
      [{ name: "game", workspaceMounts: workspaceMounts.get("game") }],
      {
        ...baseOpts,
        workspaceSubpath: "s/w",
        overlayDepDirs: [{ depDir: "game/node_modules", volumeName: "vol-game" }],
      },
    );
    const vols = overrideDoc(override).services.game.volumes ?? [];
    expect(vols).toContainEqual({ type: "volume", source: "vol-game", target: "/app/node_modules" });
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
        source: "shipit-session-workspace",
        target: "/app",
        volume: { subpath: "packages/api" },
      };
      const doc = overrideDoc(generateComposeOverride(
        [pluginService([fragmentMount])],
        {
          ...baseOpts,
          workspaceSubpath: WS,
          overlayDepDirs: [NM, { depDir: "packages/api/node_modules", volumeName: "vol-api" }],
        },
      ));
      const vols = doc.services.probe.volumes ?? [];
      expect(vols).toContainEqual({ type: "volume", source: "vol-api", target: "/app/node_modules" });
      expect(vols.some((v) => isObj(v) && v.source === NM.volumeName)).toBe(false);
      // A plugin's reference alone must declare the session volume.
      expect(doc.volumes?.["shipit-session-workspace"]).toBeDefined();
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

describe("the `persist` volume (docs/317)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function parse(content: string, opts: { containEgress?: boolean } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-persist-"));
    const file = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(file, content);
    return parseComposeFile(file, { dockerSocket: false, ...opts });
  }

  const WS = "/workspace/sessions/s1/workspace";
  const rewriteOpts = {
    sessionId: "0123456789abcdef-session",
    workspaceDir: WS,
    persist: { device: "/var/lib/docker/volumes/ws/_data/sessions/s1/scratch" },
  };

  interface PersistDoc {
    services: Record<string, { volumes?: unknown[] }>;
    volumes?: Record<string, {
      name?: string;
      driver?: string;
      driver_opts?: Record<string, string>;
      labels?: Record<string, string>;
    }>;
  }

  function snapshot(content: string, extra: Partial<Parameters<typeof rewriteResolvedModel>[1]> = {}): PersistDoc {
    parseComposeContent(content, { dockerSocket: false });
    const model = fakeResolvedModel(content, { workspaceDir: WS, project: PROJECT });
    validateResolvedModel(model, { dockerSocket: false, project: PROJECT, workspaceDir: WS });
    return rewriteResolvedModel(model, { ...rewriteOpts, ...extra }).model as unknown as PersistDoc;
  }

  it("records which part of /persist each service mounts, in every declaration form", () => {
    const [api, other] = parse(`
services:
  api:
    image: node:24-slim
    volumes:
      - persist:/data
      - persist/verseshot:/renders:ro
      - persist/./media//clips/:/clips
      - type: volume
        source: persist
        target: /cache
        volume:
          subpath: cache/fal
  other:
    image: node:24-slim
    volumes: [".:/app"]
`);
    expect(api.persistSubpaths).toEqual(["", "verseshot", "media/clips", "cache/fal"]);
    expect(other).not.toHaveProperty("persistSubpaths");
  });

  it.each([
    ["persist/../other-session:/data"],
    ["persist/a/../../b:/data"],
  ])("refuses a short-form subpath that leaves /persist: %s", (entry) => {
    expect(() => parse(`services:\n  api:\n    image: x\n    volumes: ["${entry}"]\n`))
      .toThrow(/leaves \/persist|Path traversal/);
  });

  it("refuses a long-form subpath that leaves /persist", () => {
    expect(() => parse(`
services:
  api:
    image: x
    volumes:
      - type: volume
        source: persist
        target: /data
        volume: { subpath: ../../other }
`)).toThrow(ComposeValidationError);
  });

  it("refuses interpolation in a persist subpath, which Compose would expand after validation", () => {
    expect(() => parse(`services:\n  api:\n    image: x\n    volumes: ["persist/\${DIR}:/data"]\n`))
      .toThrow(/interpolation is not allowed in a `persist` subpath/);
  });

  it("does not treat a bind of a workspace folder named persist as the session's /persist", () => {
    const [api] = parse(`
services:
  api:
    image: x
    volumes:
      - ./persist:/app/persist
      - type: bind
        source: ./persist
        target: /other
`);
    expect(api).not.toHaveProperty("persistSubpaths");
  });

  it("mounts /persist through a bind-backed volume of the session's own scratch directory", () => {
    const doc = snapshot(`
services:
  api:
    image: x
    volumes: ["persist/verseshot:/data"]
`, { workspaceVolume: "shipit-ws", workspaceSubpath: "sessions/s1/workspace", stackName: "shipit-a" });

    expect(doc.volumes?.persist).toEqual({
      name: "shipit-0123456789ab_shipit-persist",
      driver: "local",
      driver_opts: { type: "none", o: "bind", device: rewriteOpts.persist.device },
      labels: { "shipit-managed": "true", "shipit-session": rewriteOpts.sessionId, "shipit-stack": "shipit-a" },
    });
    // A subpath of the shared workspace volume is confined only to that volume, which holds
    // every session; the subpath must be resolved against the scratch directory instead.
    expect(doc.services.api.volumes).toEqual([
      { type: "volume", source: "persist", target: "/data", volume: { nocopy: true, subpath: "verseshot" } },
    ]);
  });

  it("rewrites every form, keeping read-only and long-form options", () => {
    const doc = snapshot(`
services:
  api:
    image: x
    volumes:
      - persist:/data:ro
      - .:/app
      - type: volume
        source: persist
        target: /cache
        read_only: false
        volume:
          subpath: cache
          nocopy: false
`, { workspaceVolume: "shipit-ws", workspaceSubpath: "sessions/s1/workspace" });

    expect(doc.services.api.volumes).toEqual([
      { type: "volume", source: "persist", target: "/data", read_only: true, volume: { nocopy: true } },
      { type: "volume", source: "shipit-workspace", target: "/app", volume: { subpath: "sessions/s1/workspace" } },
      {
        type: "volume", source: "persist", target: "/cache", read_only: false,
        volume: { nocopy: true, subpath: "cache" },
      },
    ]);
  });

  it("rewrites persist mounts when the workspace is a bind mount too", () => {
    const doc = snapshot(`
services:
  api:
    image: x
    volumes: [".:/app", "persist/verseshot:/data"]
`);
    expect(doc.services.api.volumes).toEqual([
      expect.objectContaining({ type: "bind", source: WS, target: "/app" }),
      { type: "volume", source: "persist", target: "/data", volume: { nocopy: true, subpath: "verseshot" } },
    ]);
    expect(doc.volumes?.persist?.driver_opts?.device).toBe(rewriteOpts.persist.device);
  });

  it("replaces a declared top-level `persist` volume even when no service mounts it", () => {
    const doc = snapshot(`
services:
  api:
    image: x
volumes:
  persist:
  pgdata:
`);
    expect(doc.volumes?.persist?.driver_opts?.o).toBe("bind");
    expect(doc.volumes?.pgdata).toEqual({
      name: `${PROJECT}_pgdata`,
      labels: { "shipit-managed": "true", "shipit-session": rewriteOpts.sessionId },
    });
  });

  it("declares nothing when no service uses /persist", () => {
    const doc = snapshot(`services:\n  api:\n    image: x\n    volumes: [".:/app"]\n`);
    expect(doc.volumes?.persist).toBeUndefined();
  });

  it("fails rather than emit a mount it has no directory for", () => {
    expect(() => snapshot(`services:\n  api:\n    image: x\n    volumes: ["persist:/data"]\n`, { persist: undefined }))
      .toThrow(/could not be located/);
    expect(() => snapshot(`services:\n  api:\n    image: x\nvolumes:\n  persist:\n`, { persist: undefined }))
      .toThrow(/could not be located/);
  });
});

describe("validateResolvedModel on Compose's resolved output (docs/318)", () => {
  const WS = "/workspace/sessions/s1/workspace";
  const SOCKET = "/var/run/docker.sock";
  const ctx = { dockerSocket: false, project: PROJECT, workspaceDir: WS };

  function resolved(web: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: PROJECT,
      services: { web: { image: "node:20", networks: { default: null }, ...web } },
      networks: { default: { name: `${PROJECT}_default` } },
      ...top,
    };
  }
  const mounts = (...volumes: unknown[]) => resolved({ volumes });
  const bindAt = (source: string) => ({ type: "bind", source, target: "/app", bind: { create_host_path: true } });

  const OPS_CONFIG = `name: ${PROJECT}
services:
  docker-socket-proxy:
    environment:
      AUTH: "0"
      BUILD: "0"
      COMMIT: "0"
      CONFIGS: "0"
      CONTAINERS: "1"
      DISTRIBUTION: "0"
      EVENTS: "1"
      EXEC: "0"
      GRPC: "0"
      IMAGES: "1"
      INFO: "1"
      NETWORKS: "1"
      NODES: "0"
      PING: "1"
      PLUGINS: "0"
      POST: "0"
      SECRETS: "0"
      SERVICES: "0"
      SESSION: "0"
      SWARM: "0"
      SYSTEM: "0"
      TASKS: "0"
      VERSION: "1"
      VOLUMES: "1"
    image: ${TRUSTED_OPS_PROXY_IMAGE}
    networks:
      default: null
    restart: unless-stopped
    volumes:
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
        read_only: true
        bind:
          create_host_path: true
    x-shipit-depends-on-install: false
    x-shipit-preview: auto
networks:
  default:
    name: ${PROJECT}_default
`;

  it("passes a ./sub stack, and the rewrite declares the session volume", () => {
    const model = mounts(bindAt(`${WS}/sub`));
    expect(() => validateResolvedModel(model, ctx)).not.toThrow();
    const device = "/var/lib/docker/volumes/ws/_data/sessions/s1/workspace";
    const { model: out } = rewriteResolvedModel(model, {
      sessionId: "s1",
      workspaceDir: WS,
      workspaceVolume: "ws",
      workspaceSubpath: "sessions/s1/workspace",
      workspaceDevice: device,
    });
    expect(out.volumes).toEqual({
      "shipit-session-workspace": {
        driver: "local",
        driver_opts: { type: "none", o: "bind", device },
        labels: { "shipit-managed": "true", "shipit-session": "s1" },
      },
    });
  });

  it("passes the ops template's proxy in an ops session", () => {
    for (const containEgress of [false, true]) {
      const check = validateResolvedModel(parseYaml(OPS_CONFIG), {
        ...ctx, dockerSocket: true, containEgress, trustedOpsProxy: true,
      });
      expect([...check.trustedOpsProxies]).toEqual(["docker-socket-proxy"]);
    }
  });

  it("refuses a bind source that resolved outside the workspace", () => {
    for (const source of ["/", "/workspace/sessions/other/workspace", "/workspace/sessions/s1", `${WS}-b`]) {
      expect(() => validateResolvedModel(mounts(bindAt(source)), ctx), source)
        .toThrow("outside this session's workspace");
    }
  });

  it("refuses a reserved named volume", () => {
    const mount = { type: "volume", source: "shipit-workspace", target: "/b", volume: { subpath: "sessions/other/workspace" } };
    expect(() => validateResolvedModel(mounts(mount), ctx)).toThrow("reserved for ShipIt");
  });

  it("refuses an undeclared named volume", () => {
    const mount = { type: "volume", source: "data", target: "/data", volume: {} };
    expect(() => validateResolvedModel(mounts(mount), ctx)).toThrow("`data` is not declared");
    const declared = resolved({ volumes: [mount] }, { volumes: { data: { name: `${PROJECT}_data` } } });
    expect(() => validateResolvedModel(declared, ctx)).not.toThrow();
  });

  it("refuses volumes_from a container", () => {
    expect(() => validateResolvedModel(resolved({ volumes_from: ["container:x"] }), ctx))
      .toThrow("`volumes_from: container:x` is not allowed");
  });

  it("refuses provider", () => {
    const model = resolved({ provider: { type: "model", options: { model: "ai/smollm2" } } });
    expect(() => validateResolvedModel(model, ctx)).toThrow("`provider` is not allowed");
  });

  it("refuses a name: other than Compose's own on a volume, network or secret", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["Volume `data`", { volumes: { data: { name: "data" } } }],
      ["Network `backend`", { networks: { default: { name: `${PROJECT}_default` }, backend: { name: "shipit-session-x" } } }],
      ["Secret `token`", { secrets: { token: { name: "token", file: `${WS}/token` } } }],
    ];
    for (const [what, top] of cases) {
      expect(() => validateResolvedModel(resolved({}, top), ctx), what).toThrow(new RegExp(`^${what}: .*name`));
    }
  });

  it("refuses a secret file outside the workspace", () => {
    for (const file of ["/etc/shadow", "/workspace/sessions/other/workspace/token"]) {
      const model = resolved({}, { secrets: { token: { name: `${PROJECT}_token`, file } } });
      expect(() => validateResolvedModel(model, ctx), file).toThrow("outside this session's workspace");
    }
  });

  it("refuses an env_file or label_file Compose did not inline", () => {
    expect(() => validateResolvedModel(resolved({ env_file: [{ path: `${WS}/.env`, required: true }] }), ctx))
      .toThrow("did not resolve `env_file`");
    expect(() => validateResolvedModel(resolved({ label_file: [`${WS}/labels`] }), ctx))
      .toThrow("did not resolve `label_file`");
  });

  it("refuses a leftover extends", () => {
    expect(() => validateResolvedModel(resolved({ extends: { service: "base" } }), ctx))
      .toThrow("left `extends` unresolved");
  });

  it("refuses an unknown mount field", () => {
    expect(() => validateResolvedModel(mounts({ ...bindAt(WS), image: { subpath: "x" } }), ctx))
      .toThrow("the mount field `image` is not supported");
  });

  it("refuses a mount type other than bind, volume and tmpfs", () => {
    for (const type of ["image", "npipe", "cluster"]) {
      expect(() => validateResolvedModel(mounts({ type, source: "x", target: "/x" }), ctx), type)
        .toThrow(`mount type \`${type}\` is not supported`);
    }
  });

  it("refuses a short-form mount", () => {
    expect(() => validateResolvedModel(mounts("./data:/data"), ctx)).toThrow("left the mount `./data:/data` unresolved");
  });

  it("refuses a $ in a bind source", () => {
    expect(() => validateResolvedModel(mounts(bindAt(`${WS}/$HOME`)), ctx)).toThrow("left the bind mount source");
  });

  it("accepts persist and persist/<sub> without a declaration", () => {
    const model = mounts(
      { type: "volume", source: "persist", target: "/data", volume: {} },
      { type: "volume", source: "persist/renders", target: "/renders", volume: {} },
    );
    expect(() => validateResolvedModel(model, ctx)).not.toThrow();
  });

  it("accepts the exact socket path with the grant", () => {
    const model = mounts({ type: "bind", source: SOCKET, target: SOCKET, bind: { create_host_path: true } });
    expect(() => validateResolvedModel(model, { ...ctx, dockerSocket: true, dockerSocketGrant: "granted" })).not.toThrow();
    expect(() => validateResolvedModel(model, ctx)).toThrow("compose.docker-socket");
  });

  it("accepts anonymous volumes and tmpfs", () => {
    const model = mounts(
      { type: "volume", target: "/cache", volume: {} },
      { type: "tmpfs", target: "/scratch", tmpfs: { size: 1048576 } },
    );
    expect(() => validateResolvedModel(model, ctx)).not.toThrow();
  });
});

describe("serializeComposeModel", () => {
  it("doubles $ in values, not keys, and round-trips through a YAML parse", () => {
    const model = {
      services: {
        web: {
          image: "node:20",
          command: ["sh", "-c", `echo $HOME \${USER:-me}`],
          environment: { "A$B": "p$ss", PORT: "3000" },
          labels: { "x.note": "a ".repeat(100) },
        },
      },
    };
    expect(parseYaml(serializeComposeModel(model))).toEqual({
      services: {
        web: {
          image: "node:20",
          command: ["sh", "-c", `echo $$HOME $\${USER:-me}`],
          environment: { "A$B": "p$$ss", PORT: "3000" },
          labels: { "x.note": "a ".repeat(100) },
        },
      },
    });
  });
});

describe("pluginStubModel", () => {
  it("carries each plugin service's name and image only", () => {
    const stubs = pluginStubModel([
      {
        name: "probe",
        definition: {
          image: "node:22-alpine",
          entrypoint: ["/plugin/bin/serve"],
          environment: { FAL_KEY: "sk-live" },
          volumes: [{ type: "volume", source: "shipit-workspace", target: "/project" }],
          labels: { "shipit-plugin": "probe" },
        },
      },
      { name: "built", definition: { build: { context: "/plugin" } } },
    ]);
    expect(stubs).toEqual({ services: { probe: { image: "node:22-alpine" }, built: { image: "shipit-plugin-stub" } } });
  });
});

describe("composeBuildModel", () => {
  it("names project files by their workspace paths and adds the plugin stubs", () => {
    const WS = "/workspace/sessions/s1/workspace";
    const snapshot = {
      name: PROJECT,
      services: {
        web: {
          image: "app:dev",
          build: { context: WS, dockerfile: "Dockerfile", secrets: [{ source: "token" }] },
          depends_on: { probe: { condition: "service_started", required: true } },
        },
      },
      secrets: { token: { name: `${PROJECT}_token`, file: "/srv/shipit/sessions/s1/state/compose/secrets/token" } },
    };
    const before = structuredClone(snapshot);
    const model = composeBuildModel(
      snapshot,
      [{ kind: "secrets", name: "token", file: `${WS}/token` }],
      pluginStubModel([{ name: "probe", definition: { image: "node:22-alpine" } }]),
    );
    expect(model.secrets).toEqual({ token: { name: `${PROJECT}_token`, file: `${WS}/token` } });
    expect(model.services).toEqual({ probe: { image: "node:22-alpine" }, web: snapshot.services.web });
    expect(snapshot).toEqual(before);
  });
});
