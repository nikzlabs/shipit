import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseComposeFile,
  generateComposeOverride,
  writeComposeOverride,
  ComposeValidationError,
} from "./compose-generator.js";

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

  // ---- Security validation ----

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

  it("throws for missing compose file", () => {
    expect(() => parseComposeFile("/nonexistent/file.yml", { dockerSocket: false }))
      .toThrow("Cannot read compose file");
  });

  it("throws for compose file without services", () => {
    const dir = setup();
    const p = writeCompose(dir, "version: '3'\n");
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("must have a `services` section");
  });
});

describe("generateComposeOverride", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    workspaceVolume: "shipit-workspace-abc",
    workspaceSubpath: "sessions/test-session-123/workspace",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  it("generates override with labels and network", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }],
      baseOpts,
    );
    expect(override).toContain("shipit-parent-session: test-session-123");
    expect(override).toContain("shipit-service-name: web");
    expect(override).toContain("shipit-session");
    expect(override).toContain("shipit-session-test-session-123");
    expect(override).toContain("NET_RAW");
  });

  it("assigns shipit-manual profile to manual services", () => {
    const override = generateComposeOverride(
      [{ name: "db", shipitPreview: "manual" }],
      baseOpts,
    );
    expect(override).toContain("shipit-manual");
  });

  it("preserves user-defined profiles alongside shipit-manual", () => {
    const override = generateComposeOverride(
      [{ name: "db", shipitPreview: "manual", profiles: ["debug"] }],
      baseOpts,
    );
    expect(override).toContain("debug");
    expect(override).toContain("shipit-manual");
  });

  it("defaults services with ports to auto", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["3000:3000"] }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: auto");
    // Should NOT have shipit-manual profile
    expect(override).not.toContain("shipit-manual");
  });

  it("defaults services without ports to manual", () => {
    const override = generateComposeOverride(
      [{ name: "redis" }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: manual");
    expect(override).toContain("shipit-manual");
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

  it("writes override file to .shipit directory", () => {
    const dir = setup();
    const content = "services: {}\n";
    const result = writeComposeOverride(dir, content);
    expect(result).toBe(path.join(dir, ".shipit", "compose.override.yml"));
    expect(fs.readFileSync(result, "utf-8")).toBe(content);
  });

  it("creates .shipit directory if it doesn't exist", () => {
    const dir = setup();
    writeComposeOverride(dir, "test");
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(true);
  });
});
