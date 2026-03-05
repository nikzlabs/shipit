import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSessionConfig, getResourceCaps } from "./session-config.js";

describe("resolveSessionConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-config-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  // --- Missing file (defaults) ---

  it("returns defaults when shipit.yaml does not exist", () => {
    const dir = setup();
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 512, cpu: 0.5, pids: 256 });
    expect(config.capabilities).toEqual({ docker: false });
  });

  // --- Valid config ---

  it("parses resources block", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  memory: 2048\n  cpu: 2.0\n  pids: 1024\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 2048, cpu: 2.0, pids: 1024 });
  });

  it("parses capabilities block", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "capabilities:\n  docker: true\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.capabilities).toEqual({ docker: true });
  });

  it("parses both resources and capabilities", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "capabilities:\n  docker: true\nresources:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 3072, cpu: 2.0, pids: 2048 });
    expect(config.capabilities).toEqual({ docker: true });
  });

  // --- Missing fields (defaults) ---

  it("uses defaults for missing resource fields", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  memory: 1024\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 1024, cpu: 0.5, pids: 256 });
  });

  it("uses defaults for missing capabilities block", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.capabilities).toEqual({ docker: false });
  });

  it("uses defaults for missing resources block", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "preview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 512, cpu: 0.5, pids: 256 });
  });

  // --- Invalid values ---

  it("uses defaults for non-numeric resource values", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      'resources:\n  memory: "lots"\n  cpu: "fast"\n  pids: "many"\npreview:\n  command: npm run dev\n',
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 512, cpu: 0.5, pids: 256 });
  });

  it("uses defaults for negative resource values", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  memory: -1\n  cpu: -0.5\n  pids: 0\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 512, cpu: 0.5, pids: 256 });
  });

  it("floors fractional pids value", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  pids: 512.7\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources.pids).toBe(512);
  });

  it("treats docker: false correctly", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "capabilities:\n  docker: false\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.capabilities.docker).toBe(false);
  });

  it("treats non-boolean docker as false", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      'capabilities:\n  docker: "yes"\npreview:\n  command: npm run dev\n',
    );
    const config = resolveSessionConfig(dir);
    expect(config.capabilities.docker).toBe(false);
  });

  it("handles non-object yaml gracefully", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "shipit.yaml"), "just a string\n");
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 512, cpu: 0.5, pids: 256 });
    expect(config.capabilities).toEqual({ docker: false });
  });

  // --- Deployment-level caps ---

  it("caps resources at deployment-level maximums", () => {
    const dir = setup();
    process.env.MAX_SESSION_MEMORY_MB = "1024";
    process.env.MAX_SESSION_CPU = "1";
    process.env.MAX_SESSION_PIDS = "512";
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  memory: 4096\n  cpu: 4.0\n  pids: 2048\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 1024, cpu: 1, pids: 512 });
  });

  it("does not cap resources below requested values", () => {
    const dir = setup();
    process.env.MAX_SESSION_MEMORY_MB = "4096";
    process.env.MAX_SESSION_CPU = "4";
    process.env.MAX_SESSION_PIDS = "2048";
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      "resources:\n  memory: 1024\n  cpu: 1.0\n  pids: 512\npreview:\n  command: npm run dev\n",
    );
    const config = resolveSessionConfig(dir);
    expect(config.resources).toEqual({ memory: 1024, cpu: 1.0, pids: 512 });
  });
});

describe("getResourceCaps", () => {
  afterEach(() => {
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  it("returns defaults when env vars are not set", () => {
    const caps = getResourceCaps();
    expect(caps).toEqual({ memory: 4096, cpu: 4, pids: 2048 });
  });

  it("reads from env vars", () => {
    process.env.MAX_SESSION_MEMORY_MB = "8192";
    process.env.MAX_SESSION_CPU = "8";
    process.env.MAX_SESSION_PIDS = "4096";
    const caps = getResourceCaps();
    expect(caps).toEqual({ memory: 8192, cpu: 8, pids: 4096 });
  });

  it("falls back to defaults for invalid env vars", () => {
    process.env.MAX_SESSION_MEMORY_MB = "not-a-number";
    process.env.MAX_SESSION_CPU = "";
    process.env.MAX_SESSION_PIDS = "-1";
    const caps = getResourceCaps();
    expect(caps).toEqual({ memory: 4096, cpu: 4, pids: 2048 });
  });
});
